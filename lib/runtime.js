import { attachModelSideInjection, attachPreStepBridge } from "./bridge.js";
import { CircuitBreaker } from "./breaker.js";
import { createInspectImageTool } from "./inspect-image.js";
import { PoolScheduler, resolvePool } from "./pool.js";
import { installAutoImageAdmission } from "./route.js";
import { VisionClient } from "./vision-client.js";

const SETTINGS_NS = "auto-vision-bridge";

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
        attachPreStepBridge(inner, { client, getConfig });
        // 转写只注入模型侧：会话事件的 content 保持干净，Web GUI 看不到它。
        attachModelSideInjection(inner);
        const restoreAdmission = installAutoImageAdmission(inner.get("llm"), inner.logger);
        inner.effect(() => restoreAdmission, "auto-vision-bridge: 图片上传准入");
        inner.tools.register(createInspectImageTool(defineTool, { ctx: inner, client, getConfig }));
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
  syncFeatures();
}
