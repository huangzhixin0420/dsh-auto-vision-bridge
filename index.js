import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DEFAULT_RETENTION_DAYS } from "./lib/history.js";
import { INSPECT_IMAGE_DESCRIPTION } from "./lib/inspect-image.js";
import { applyRuntime, runtimeDiagnostics } from "./lib/runtime.js";
import { DEFAULT_PROMPT } from "./lib/vision-client.js";

export const name = "auto-vision-bridge";
export const inject = ["tools", "llm", "attachments", "sessionProjections"];
const SETTINGS_NS = "auto-vision-bridge";

/**
 * 模型池条目：直接指向 DSH 模型目录里的一个视觉模型。
 *
 * 插件不经手 baseURL 与凭据：识别请求走 DSH 自己的 llm 通道，
 * 端点与密钥由 provider 适配器自己解析。
 */
const PoolEntry = z.object({
  provider: z.string().default(""),
  model: z.string().default(""),
  maxConcurrent: z.number().default(1),
  /** 优先级，数字越小越优先；默认与所有条目同级。 */
  priority: z.number().default(1),
});

const ConfigBase = z.object({
  enabled: z.boolean().default(true),
  prompt: z.string().default(DEFAULT_PROMPT),
  /**
   * 单次视觉请求的超时（毫秒）。
   *
   * 实测本机 c2a/vision 成功耗时在 15.5s–117.2s 之间（1320×2868 的截图尤慢），
   * 原来的 60s 会稳定卡掉大图。给到 180s 覆盖 1.5 倍余量，配合 retries=1
   * 最坏 360s，与生产中调优过的 300s 同量级。
   */
  timeoutMs: z.number().default(180000),
  maxImageBytes: z.number().default(10 * 1024 * 1024),
  /**
   * 识图失败后的重试次数。
   *
   * 视觉请求的失败形态以超时为主，重试一次常能在第二次成功；默认 1 次。
   */
  retries: z.number().default(1),
  /** 重试退避基数（毫秒），第 n 次重试等待 base * n。视觉请求本身慢，退避不必太长。 */
  retryDelayMs: z.number().default(500),
  /** 多图并发的整体上限；每个池条目另有自己的并发上限。 */
  maxConcurrent: z.number().default(6),
  /** 同一模型连续失败多少次后熔断；0 表示不熔断。 */
  failureThreshold: z.number().default(3),
  /** 熔断后的冷却时长（毫秒）；冷却结束前不再派发给该模型。 */
  cooldownMs: z.number().default(60000),
  /** 识图历史保留天数；0 表示不自动清理。 */
  historyRetentionDays: z.number().default(DEFAULT_RETENTION_DAYS),
  /** 视觉模型池；条目来自 DSH 模型目录，可自由增减。 */
  pool: z.array(PoolEntry).default([]),
  /**
   * provider 层桥接：注册一个包装 provider，在它自己的 adapter 里把图片转成文字，
   * 再交给真实 provider。
   *
   * 为什么要有这条：走 agent/pre-step 阻塞式转写时，用户消息要等转写完才落库，
   * 前端先显示乐观回显、落库后再切持久消息，图片节点被重建 → 肉眼可见的闪烁。
   * 改到 provider 层后 pre-step 完全不阻塞，转写发生在请求发出前，
   * 用户消息立刻落库，闪烁消失；模型也能在第一轮就看到转写。
   *
   * 默认关闭：开启后必须把模型路由切到 providerId，否则没有任何变化。
   */
  providerBridge: z.object({
    enabled: z.boolean().default(false),
    /** 新注册的 provider id；模型路由要切到它才会生效。 */
    providerId: z.string().default("vision-bridge"),
    /** 图片真正交给哪个已有 provider 处理（必须已注册，例如 c2a）。 */
    innerProvider: z.string().default("c2a"),
    /** 包装 provider 在模型列表里的显示名。 */
    displayName: z.string().default("视觉桥接"),
    // 默认值必须是 undefined：schemastery 给 object 类型自动补的默认值是空对象
    // （见 schemastery lib/index.mjs 的 defineMethod），写成 {} 会把整个对象替换掉，
    // 子字段的默认值全部失效 —— 开启开关会被静默吞掉。
  }).default(void 0),
});

/**
 * 运行时配置解析：把 schema 上的默认值真正套上去。
 *
 * 为什么需要这一步 —— 导出给 DSH 的 `Config` 必须带 `.volatile()`（设置页热更新需要），
 * 而 schemastery 的 volatile schema **调用时不填默认值**。实测：
 *
 *   z.object({ a: z.number().default(7) })({})            // => { a: 7 }
 *   z.object({ a: z.number().default(7) }).volatile()({}) // => {}    ← 默认值全丢
 *
 * 后果是「没在 yml 里显式配置的字段在运行时一律 undefined」。没有兜底的字段
 * （例如 timeoutMs，缺失即抛「必须是正数」）会让功能直接不可用 —— 默认值写在
 * schema 里等于装饰。
 *
 * 所以保留一份非 volatile 的 base schema 专供运行时补默认；默认值仍只定义一处。
 */
export const Config = ConfigBase.volatile();

export function resolveConfig(raw) {
  return ConfigBase(raw ?? {});
}

export function apply(ctx, config) {
  try {
    // 包一层 getter 把默认值真正套上（volatile schema 调用不填默认，见 resolveConfig 注释）。
    // 上游 config 可能是对象，也可能是带 get() 的响应式句柄，两种都要兼容。
    const resolved = {
      get: () => resolveConfig(typeof config?.get === "function" ? config.get() : config),
    };
    return applyRuntime(ctx, resolved, defineTool);
  } catch (error) {
    // cordis 会把插件加载期的异常截断成一条没有内层帧的堆栈，
    // 这里把原始堆栈打出来，否则定位不到真正出错的帧。
    ctx?.logger?.error?.(`[auto-vision-bridge] 加载失败：${error?.stack ?? error}`);
    throw error;
  }
}

// 仅导出给文档/静态检查使用；实际工具描述仍在唯一定义处维护。
export { INSPECT_IMAGE_DESCRIPTION };
/**
 * 运行期诊断视图：读取熔断状态等内部运行时信息。
 * 只读快照，不改变任何状态。
 */
export function diagnostics(ctx) {
  return runtimeDiagnostics(ctx);
}
