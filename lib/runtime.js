import { attachModelSideInjection, attachPreStepBridge } from "./bridge.js";
import { CircuitBreaker } from "./breaker.js";
import { HISTORY_TABLE, VisionHistory, historyDomainSpec, DEFAULT_RETENTION_DAYS } from "./history.js";
import { createInspectImageTool } from "./inspect-image.js";
import { PoolScheduler, resolvePool } from "./pool.js";
import { installAutoImageAdmission } from "./route.js";
import { VisionClient } from "./vision-client.js";

const SETTINGS_NS = "auto-vision-bridge";

/** 识图历史的取数路由（Connection 的精确 Fetch 路由，路径必须以 /api 开头）。 */
export const HISTORY_PATH = "/api/auto-vision-bridge.history";

/**
 * 读保留天数。
 *
 * 配置非法（负数、NaN）时退回默认；0 表示不自动清理。
 */
export function retentionDaysOf(config) {
  const value = Number(config?.historyRetentionDays);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_RETENTION_DAYS;
  return value;
}

/** 运行时组合与配置 schema 分离，便于用假 Cordis fiber 验证热禁用。 */
/** 各上下文自己的诊断视图。 */
const DIAGNOSTICS = new WeakMap();

/**
 * 读取某个上下文的运行期诊断视图。
 *
 * 不能把视图直接挂在 ctx 上：Cordis 的 ctx 是 Proxy，赋未声明的属性会抛
 * "cannot set property ... without provide"，插件会直接加载失败。
 */
export function runtimeDiagnostics(ctx) {
  return DIAGNOSTICS.get(ctx) ?? null;
}

export function applyRuntime(ctx, config, defineTool) {
  const getConfig = () => typeof config?.get === "function" ? config.get() : config;
  let featureFiber = null;
  /**
   * 运行期诊断视图：暴露当前熔断状态，供设置页或排障查看。
   * 熔断器只存在于进程内存，这里返回的是活对象上的即时快照。
   */
  let activeBreaker = null;
  /**
   * 识图历史账本。storageDomain 的 open 是异步的，账本在就绪后才存在；
   * 之前发生的识图没有记账（插件刚起、或存储服务不可用）。
   */
  let activeHistory = null;
  /** 按 sessionId 读会话标题：取数时用它把记账里的 id 补成人类可读标题。 */
  let titleById = undefined;
  const diagnostics = {
    /** 当前处于冷却中的条目路由键。 */
    trippedKeys: () => activeBreaker?.trippedKeys() ?? [],
    /** 每个条目剩余的冷却毫秒数。 */
    cooldowns: () => {
      const breaker = activeBreaker;
      if (!breaker) return {};
      const out = {};
      for (const [key, state] of breaker.states) {
        const remaining = breaker.remainingCooldown(key);
        if (remaining > 0) out[key] = { remaining, failures: state.failures };
      }
      return out;
    },
    /** 仅供测试注入熔断器：真实运行路径不需要。 */
    __setBreaker: (breaker) => { activeBreaker = breaker; },
  };

  function installFeatures() {
    if (featureFiber) return;
    featureFiber = ctx.plugin({
      name: "dsh-auto-vision-bridge:features",
      apply(inner) {
        // 熔断器与调度器共用同一份配置读取，配置热更新后立即生效。
        const breaker = new CircuitBreaker(getConfig);
        activeBreaker = breaker;
        // 调度器每次取配置时重算池，配置热更新后立即生效。
        const scheduler = new PoolScheduler(
          () => resolvePool(getConfig()),
          () => getConfig().maxConcurrent,
          breaker,
        );
        const client = new VisionClient(getConfig, {
          ctx: inner,
          llm: inner.get("llm"),
          scheduler,
          breaker,
        });
        // 识图历史账本可能还没就绪（存储服务缺失或 open 还在路上），
        // 这里传活对象引用：就绪后自动开始记账。
        attachPreStepBridge(inner, {
          client,
          getConfig,
          history: () => activeHistory,
          sessionIdOf: (session) => String(session?.id ?? ""),
        });
        // 转写只注入模型侧：会话事件的 content 保持干净，Web GUI 看不到它。
        attachModelSideInjection(inner);
        const restoreAdmission = installAutoImageAdmission(inner.get("llm"), inner.logger);
        inner.effect(() => restoreAdmission, "auto-vision-bridge: 图片上传准入");
        inner.tools.register(createInspectImageTool(defineTool, {
          ctx: inner,
          client,
          getConfig,
          history: () => activeHistory,
        }));
      },
    });
  }

  function uninstallFeatures() {
    const fiber = featureFiber;
    featureFiber = null;
    if (fiber) Promise.resolve(fiber.dispose()).catch((error) => {
      ctx.logger?.warn?.(`[auto-vision-bridge] 功能卸载失败：${String(error?.message ?? error)}`);
    });
  }

  function syncFeatures() {
    if (getConfig().enabled === false) uninstallFeatures();
    else installFeatures();
  }

  DIAGNOSTICS.set(ctx, diagnostics);
  ctx.on("settings/document-updated", (id) => {
    if (id === SETTINGS_NS) syncFeatures();
  });
  ctx.effect(() => () => uninstallFeatures(), "auto-vision-bridge: 功能生命周期");

  // ---- 识图历史存储 ----
  //
  // storageDomain 不在顶层 inject 里：非 Web profile（headless 等）可能没有
  // 存储服务，顶层声明会让插件整体不挂载。改成嵌套 inject，安静降级。
  ctx.inject(["storageDomain"], (storageCtx) => {
    const storageDomain = storageCtx.get?.("storageDomain") ?? storageCtx.storageDomain;
    if (storageDomain?.open === undefined) {
      ctx.logger?.warn?.("auto-vision-bridge: storageDomain 服务不可用，识图历史不落盘");
      return;
    }
    storageCtx.effect(async () => {
      let domain;
      try {
        domain = await storageDomain.open(historyDomainSpec);
      } catch (error) {
        ctx.logger?.warn?.(`auto-vision-bridge: 识图历史域打开失败：${String(error?.message ?? error)}`);
        return;
      }
      const history = new VisionHistory({ table: domain.table(HISTORY_TABLE) });
      activeHistory = history;
      // 启动时先清一遍过期记录：保留期可能刚被改小。
      await history.prune(retentionDaysOf(getConfig()));
      storageCtx.effect(() => () => { activeHistory = null; }, "auto-vision-bridge: 识图历史生命周期");
    }, "auto-vision-bridge: 识图历史存储");
  });

  // ---- 会话标题读取 ----
  //
  // 标题是 DSH 事后用模型生成的，识图发生时多半还没有；取数时按 sessionId
  // 解析最新标题，因此明细里显示的总是当前标题。
  // 标题是 DSH 事后用模型生成的，识图发生时多半还没有；取数时按 sessionId
  // 解析最新标题，因此明细里显示的总是当前标题。
  //
  // sessionTitle.get 要的是 Session 实例，而记账里只有 sessionId，
  // 所以要经 sessions 服务把 id 换回实例（见 dsh-session-title 内部同样做法）。
  ctx.inject(["sessions", "sessionTitle"], (titleCtx) => {
    const titleService = titleCtx.get?.("sessionTitle") ?? titleCtx.sessionTitle;
    const sessions = titleCtx.get?.("sessions") ?? titleCtx.sessions;
    if (titleService === undefined || sessions === undefined) {
      ctx.logger?.warn?.("auto-vision-bridge: sessionTitle/sessions 服务不可用，识图历史只显示会话 id");
      return;
    }
    titleById = (sessionId) => {
      if (!sessionId) return undefined;
      try {
        const session = sessions.get(sessionId);
        if (session === undefined) return undefined;
        return titleService.get(session)?.title;
      } catch {
        return undefined;
      }
    };
  });

  // ---- 识图历史取数路由 ----
  //
  // 注册在 Connection 的精确 Fetch 路由表里：路径必须以 /api 开头，
  // 且只有 owner Peer 能到达。浏览器侧同源 fetch 会带上会话 cookie。
  ctx.inject(["connection"], (connectionCtx) => {
    const connection = connectionCtx.get?.("connection") ?? connectionCtx.connection;
    if (connection?.fetch === undefined) {
      ctx.logger?.warn?.("auto-vision-bridge: Connection 的 Fetch 路由表不可用，识图历史页不提供取数");
      return;
    }
    connection.fetch.register({
      path: HISTORY_PATH,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: async () => {
        const history = activeHistory;
        const records = history ? await history.list() : [];
        return Response.json({
          records: records.map((record) => {
            // 取不到标题就留空串，由前端退回短 sessionId 显示。
            // 已结束的会话不在 live store 里，拿不到标题属于正常情况。
            const title = titleById?.(record.sessionId);
            return { ...record, sessionTitle: title || "" };
          }),
          summary: VisionHistory.summarize(records),
          retentionDays: retentionDaysOf(getConfig()),
        }, { headers: { "cache-control": "no-store" } });
      },
    });
  });

  syncFeatures();
}
