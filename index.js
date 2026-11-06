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
}).volatile();

export function apply(ctx, config) {
  return applyRuntime(ctx, config, defineTool);
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
