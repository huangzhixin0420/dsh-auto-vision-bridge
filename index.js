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

export const Config = z.object({
  enabled: z.boolean().default(true),
  prompt: z.string().default(DEFAULT_PROMPT),
  timeoutMs: z.number().default(60000),
  maxImageBytes: z.number().default(10 * 1024 * 1024),
  /** 识图失败后的重试次数；0 表示不重试。 */
  retries: z.number().default(0),
  /** 重试退避基数（毫秒），第 n 次重试等待 base * n。 */
  retryDelayMs: z.number().default(1000),
  /** 多图并发的整体上限；每个池条目另有自己的并发上限。 */
  maxConcurrent: z.number().default(4),
  /** 同一模型连续失败多少次后熔断；0 表示不熔断。 */
  failureThreshold: z.number().default(3),
  /** 熔断后的冷却时长（毫秒）；冷却结束前不再派发给该模型。 */
  cooldownMs: z.number().default(60000),
  /** 转写超过多少字符才落盘并截断；0 表示不截断，全部进上下文。 */
  dumpThreshold: z.number().default(500),
  /** 落盘后留在上下文里的摘要长度（字符）。 */
  summaryLength: z.number().default(400),
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
}).volatile();

export function apply(ctx, config) {
  try {
    return applyRuntime(ctx, config, defineTool);
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
