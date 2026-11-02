import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { INSPECT_IMAGE_DESCRIPTION } from "./lib/inspect-image.js";
import { applyRuntime } from "./lib/runtime.js";
import { DEFAULT_PROMPT } from "./lib/vision-client.js";

export const name = "auto-vision-bridge";
export const inject = ["tools", "llm", "attachments", "sessionProjections"];
const SETTINGS_NS = "auto-vision-bridge";

export const Config = z.object({
  enabled: z.boolean().default(true),
  baseURL: z.string().default("https://api.openai.com/v1"),
  apiKey: z.string().default("").role("secret"),
  apiKeyEnv: z.string().default("AUTO_VISION_API_KEY"),
  model: z.string().default("gpt-4o-mini"),
  prompt: z.string().default(DEFAULT_PROMPT),
  maxTokens: z.number().default(4096),
  timeoutMs: z.number().default(60000),
  maxImageBytes: z.number().default(10 * 1024 * 1024),
}).volatile();

export function apply(ctx, config) {
  return applyRuntime(ctx, config, defineTool);
}

// 仅导出给文档/静态检查使用；实际工具描述仍在唯一定义处维护。
export { INSPECT_IMAGE_DESCRIPTION };
