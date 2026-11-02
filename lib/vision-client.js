import { createHash } from "node:crypto";

export const DEFAULT_PROMPT = "请准确识别这张图片，描述关键视觉内容、上下文，并尽量完整转写其中的文字。只依据可见内容回答。";

/** 密钥只来自本插件配置或其指定环境变量，不回退到主模型凭据。 */
export function resolveApiKey(config, env = process.env) {
  if (typeof config?.apiKey === "string" && config.apiKey.trim()) return config.apiKey.trim();
  if (typeof config?.apiKeyEnv === "string" && config.apiKeyEnv.trim()) {
    const value = env[config.apiKeyEnv.trim()];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** 错误可进入持久会话，因此最后一次统一抹去已知密钥。 */
export function safeErrorMessage(error, config) {
  let message = String(error?.message ?? error ?? "未知错误");
  const secrets = [config?.apiKey, process.env[config?.apiKeyEnv]];
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) message = message.split(secret).join("[已隐藏]");
  }
  return message;
}

function responseAnswer(body) {
  const message = body?.choices?.[0]?.message;
  if (typeof message?.content === "string") return message.content.trim();
  if (Array.isArray(message?.content)) {
    const text = message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  if (typeof message?.reasoning_content === "string") return message.reasoning_content.trim();
  return "";
}

function endpointOf(config) {
  if (typeof config?.baseURL !== "string" || !config.baseURL.trim()) {
    throw new Error("视觉 API baseURL 未配置");
  }
  const base = config.baseURL.trim().replace(/\/+$/, "") + "/";
  const endpoint = new URL("chat/completions", base);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("视觉 API baseURL 必须使用 http(s)");
  }
  return endpoint;
}

/**
 * 单次 OpenAI-compatible 请求。图片始终以 data URL 放入 image_url。
 * fetchImpl 仅供测试或宿主注入，生产默认使用全局 fetch。
 */
export async function callVision(config, image, question, signal, fetchImpl = fetch) {
  const apiKey = resolveApiKey(config);
  if (!apiKey) throw new Error("视觉 API key 缺失：请配置 apiKey，或设置 apiKeyEnv 指向的环境变量");
  if (typeof config?.model !== "string" || !config.model.trim()) throw new Error("视觉模型 model 未配置");
  const endpoint = endpointOf(config);
  const timeoutMs = Number(config.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("视觉请求 timeoutMs 必须是正数");
  const maxTokens = Number(config.maxTokens);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) throw new Error("视觉请求 maxTokens 必须是正数");

  const bytes = Buffer.isBuffer(image.data)
    ? image.data
    : Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  const mediaType = image.mediaType || "image/png";
  const dataUrl = `data:${mediaType};base64,${bytes.toString("base64")}`;
  const prompt = typeof question === "string" && question.trim()
    ? question.trim()
    : String(config.prompt || DEFAULT_PROMPT);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`视觉请求超时（${timeoutMs}ms）`));
  }, timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    controller.signal.throwIfAborted();
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let body = null;
    if (raw.trim()) {
      try { body = JSON.parse(raw); } catch { /* 下方按协议错误报告 */ }
    }
    if (!response.ok) {
      const detail = body?.error?.message ?? body?.message ?? response.statusText ?? raw.slice(0, 300);
      throw new Error(`视觉端点返回 HTTP ${response.status}：${String(detail || "未知错误")}（${endpoint}）`);
    }
    if (body === null) throw new Error("视觉端点返回空响应或非 JSON 响应");
    const answer = responseAnswer(body);
    if (!answer) throw new Error("视觉端点返回空识别文本");
    return answer;
  } catch (error) {
    if (timedOut) throw new Error(`视觉请求超时（${timeoutMs}ms）`);
    if (signal?.aborted) throw new Error("视觉请求已取消");
    throw new Error(safeErrorMessage(error, config));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 两个入口共用的 LRU + in-flight 缓存。key 不包含密钥，但包含所有影响
 * 图片语义与回答内容的配置，配置变更不会复用旧结果。
 */
export class VisionClient {
  constructor(getConfig, { fetchImpl = fetch, maxEntries = 200 } = {}) {
    this.getConfig = getConfig;
    this.fetchImpl = fetchImpl;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  recognize(image, question, signal) {
    const config = this.getConfig();
    const prompt = typeof question === "string" && question.trim()
      ? question.trim()
      : String(config.prompt || DEFAULT_PROMPT);
    const bytes = Buffer.isBuffer(image.data)
      ? image.data
      : Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const key = JSON.stringify([
      digest,
      image.attachmentId ?? "",
      config.baseURL,
      config.model,
      prompt,
      Number(config.maxTokens),
    ]);
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.promise;
    }

    const entry = { promise: null };
    entry.promise = callVision(config, { ...image, data: bytes }, prompt, signal, this.fetchImpl).then(
      (answer) => {
        this.entries.delete(key);
        this.entries.set(key, entry);
        return answer;
      },
      (error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      },
    );
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return entry.promise;
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}
