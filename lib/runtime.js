import { attachModelSideInjection, attachPreStepBridge } from "./bridge.js";
import { CircuitBreaker } from "./breaker.js";
import { VisionHistory, DEFAULT_RETENTION_DAYS } from "./history.js";
import { createFileStore, defaultHistoryDir, legacyHistoryDir } from "./history-store.js";
import { createInspectImageTool } from "./inspect-image.js";
import { PoolScheduler, resolvePool } from "./pool.js";
import { createVisionBridgeAdapter } from "./provider-bridge.js";
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
 * 把 provider 层桥接挂上去。
 *
 * 注册一个新 provider，它的 adapter 在请求发出前把图片块换成转写文本，
 * 再把改好的消息交给真实 provider。相比 agent/pre-step 的阻塞式转写：
 *   - 用户消息不等转写就能落库，Web GUI 的图文闪烁消失；
 *   - 转写不进 content，用户气泡保持干净；
 *   - 模型第一轮就看到转写，不必自己再调 inspect_image。
 *
 * 代价是模型路由要切到 providerId，所以在设置里默认关闭。
 */
function attachProviderBridge(ctx, { client, getConfig }) {
  const llm = ctx?.llm ?? ctx.get?.("llm");
  if (!llm || typeof llm.registerAdapter !== "function") {
    ctx.logger?.warn?.("[auto-vision-bridge] llm.registerAdapter 不可用，provider 桥接未启用，回退到 pre-step 转写");
    return false;
  }
  const settings = getConfig()?.providerBridge ?? {};
  const providerId = typeof settings.providerId === "string" && settings.providerId.trim()
    ? settings.providerId.trim()
    : "vision-bridge";
  const innerProvider = typeof settings.innerProvider === "string" && settings.innerProvider.trim()
    ? settings.innerProvider.trim()
    : "c2a";
  if (providerId === innerProvider) {
    ctx.logger?.warn?.(`[auto-vision-bridge] providerBridge.providerId 与 innerProvider 相同（${providerId}），会导致自引用，已跳过`);
    return false;
  }
  const adapter = createVisionBridgeAdapter({
    ctx,
    llm,
    getConfig,
    client,
    innerProvider,
    displayName: settings.displayName,
    logger: ctx.logger,
  });
  ctx.effect(() => {
    const handle = llm.registerAdapter([providerId], adapter);
    ctx.logger?.warn?.(`[auto-vision-bridge] 已注册包装 provider「${providerId}」→「${innerProvider}」；把模型路由切到 ${providerId}/* 即可生效`);
    return () => {
      try {
        handle?.();
      } catch (error) {
        ctx.logger?.warn?.(`[auto-vision-bridge] 注销包装 provider 失败：${String(error?.message ?? error)}`);
      }
    };
  }, "auto-vision-bridge: 包装 provider");
  return true;
}

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
  /** provider 层桥接是否启用：默认关闭，只有显式 true 才接管转写。 */
  const isProviderBridgeOn = () => getConfig()?.providerBridge?.enabled === true;
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
    /** 实际读到的配置快照：排查配置是否真的生效用。 */
    configSnapshot: () => {
      const raw = getConfig();
      return {
        providerBridge: raw?.providerBridge ?? null,
        providerBridgeEnabled: isProviderBridgeOn(),
        poolSize: Array.isArray(raw?.pool) ? raw.pool.length : 0,
      };
    },
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
        // provider 层接管：转写挪到请求发出前，pre-step 不再阻塞。
        // 这样用户消息立刻落库，图文闪烁消失；转写也不进 content，气泡保持干净。
        // 注册失败（llm 服务缺失、id 自引用）时回退到 pre-step 老路径，不影响可用性。
        const bridged = isProviderBridgeOn() && attachProviderBridge(inner, { client, getConfig });
        if (!bridged) {
          attachPreStepBridge(inner, {
            client,
            getConfig,
            history: () => activeHistory,
            sessionIdOf: (session) => String(session?.id ?? ""),
          });
          // 转写只注入模型侧：会话事件的 content 保持干净，Web GUI 看不到它。
          // （实测这条注入路径是空操作，保留只为不改变既有行为；开启 provider
          //   桥接后不再挂它，避免 llm/stream 监听器在外层与内层各跑一次。）
          attachModelSideInjection(inner);
        }
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
  // 不用 DSH 的 storageDomain：它每次 put 都 emit("domain/changed")，前端收到就
  // 重渲染消息列表；图片组件被销毁重建、重新 createObjectURL，浏览器必须重新
  // 解码——用户看到的就是「转写完成后整张图闪一下」。实测跳过写历史后，发送
  // 2 秒内的图片 DOM 变化次数由 1 降到 0。
  //
  // 改为直接落盘（lib/history-store.js）：原子写 + 坏记录跳过自己实现，
  // 不产生任何事件。storages 下历史域的旧目录仍只读兼容（见 legacyHistoryDir）。
  {
    const historyDir = defaultHistoryDir();
    const legacyDir = legacyHistoryDir();
    const store = createFileStore({
      dir: historyDir,
      readDirs: [legacyDir],
      onWarn: (error) => ctx.logger?.warn?.(`auto-vision-bridge: 识图历史清理失败：${String(error?.message ?? error)}`),
    });
    const history = new VisionHistory({ store });
    activeHistory = history;
    ctx.logger?.info?.(`[auto-vision-bridge] 识图历史目录：${historyDir}`);
    // 启动时先清一遍过期记录：保留期可能刚被改小。
    history.prune(retentionDaysOf(getConfig())).catch((error) => {
      ctx.logger?.warn?.(`auto-vision-bridge: 识图历史清理失败：${String(error?.message ?? error)}`);
    });
    ctx.effect(() => () => { activeHistory = null; }, "auto-vision-bridge: 识图历史生命周期");
  }

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
