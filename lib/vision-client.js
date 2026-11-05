import { createHash } from "node:crypto";
import { CircuitBreaker, classifyFailure } from "./breaker.js";
import { PoolScheduler, poolEmptyMessage, resolvePool } from "./pool.js";

export const DEFAULT_PROMPT = "请准确识别这张图片，描述关键视觉内容、上下文，并尽量完整转写其中的文字。只依据可见内容回答。";

/** 错误可进入持久会话，因此最后统一抹去已知密钥。 */
export function safeErrorMessage(error, config) {
  let message = String(error?.message ?? error ?? "未知错误");
  const secrets = [config?.apiKey, process.env[config?.apiKeyEnv]];
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) message = message.split(secret).join("[已隐藏]");
  }
  return message;
}

/**
 * 从 DSH 的流式响应里提取文本。
 *
 * chunk 形态在适配器之间不统一，逐个兜住。
 */
export function extractText(chunks) {
  let text = "";
  for (const chunk of chunks ?? []) {
    if (typeof chunk === "string") {
      text += chunk;
      continue;
    }
    if (typeof chunk?.text === "string") {
      text += chunk.text;
      continue;
    }
    if (typeof chunk?.delta?.text === "string") {
      text += chunk.delta.text;
      continue;
    }
    if (typeof chunk?.delta?.content === "string") {
      text += chunk.delta.content;
      continue;
    }
    if (typeof chunk?.content === "string") {
      text += chunk.content;
      continue;
    }
  }
  return text.trim();
}

/** 重试次数：配置为非法值时按 0（不重试）处理。 */
export function retryLimitOf(config) {
  const value = Number(config?.retries);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/** 退避基数（毫秒），第 n 次重试等待 base * n。 */
function backoffDelay(base, attempt) {
  const value = Number(base);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value * attempt);
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("视觉请求已取消"));
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error("视觉请求已取消"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * 把图片字节变成 DSH 认可的持久引用。
 *
 * llm 通道只接受 `{ type: "image", attachment: <引用> }`，因此本地路径、
 * 远程 URL、会话附件三种来源都要先经 attachments 服务落成引用。
 *
 * @param {object} ctx - 宿主上下文，提供 attachments 服务。
 * @param {{data: Buffer, mediaType: string, name?: string}} image - 图片字节。
 * @returns {Promise<object>} 可直接放进消息的 attachment 引用。
 */
export async function admitImage(ctx, image) {
  const attachments = ctx?.attachments ?? ctx?.get?.("attachments");
  if (!attachments || typeof attachments.saveImages !== "function") {
    throw new Error("DSH attachments 服务不可用，无法提交图片");
  }
  const refs = await attachments.saveImages([{
    data: image.data,
    mediaType: image.mediaType || "image/png",
    ...(image.name ? { name: image.name } : {}),
  }]);
  const ref = Array.isArray(refs) ? refs[0] : refs;
  if (!ref || typeof ref !== "object") throw new Error("图片写入附件存储失败");
  return ref;
}

/**
 * 两个入口共用的 LRU + in-flight 缓存。key 不包含密钥，但包含所有影响
 * 图片语义与回答内容的配置，配置变更不会复用旧结果。
 *
 * 池模式下每次尝试都可能派发到不同模型，因此缓存 key 还要包含池指纹。
 */
export class VisionClient {
  constructor(getConfig, { ctx = null, llm = null, maxEntries = 200, scheduler = null, breaker = null } = {}) {
    this.getConfig = getConfig;
    this.ctx = ctx;
    this.llm = llm;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    // 熔断器按条目路由键记录连续失败与冷却截止时间。
    this.breaker = breaker ?? new CircuitBreaker(getConfig);
    // 未显式注入时，调度器直接读当前配置的池，热更新后立即生效。
    this.scheduler = scheduler ?? new PoolScheduler(
      () => resolvePool(getConfig()),
      () => getConfig()?.maxConcurrent,
      this.breaker,
    );
  }

  /** 缓存键：图片语义 + 提示词 + 参数 + 池指纹。 */
  cacheKey(image, question, config) {
    const prompt = typeof question === "string" && question.trim()
      ? question.trim()
      : String(config?.prompt || DEFAULT_PROMPT);
    const bytes = Buffer.isBuffer(image.data)
      ? image.data
      : Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    const digest = createHash("sha256").update(bytes).digest("hex");
    return JSON.stringify([
      digest,
      image.attachmentId ?? "",
      prompt,
      this.poolFingerprint(config),
    ]);
  }

  /** 池指纹：模型组合变化时缓存失效。 */
  poolFingerprint(config) {
    const pool = Array.isArray(config?.pool) ? config.pool : [];
    return pool
      .map((entry) => `${entry?.provider ?? ""}|${entry?.model ?? ""}|${entry?.maxConcurrent ?? ""}`)
      .join(";");
  }

  /**
   * 调用一个池条目：走 DSH 的 llm 通道发一次带图请求。
   *
   * @param {object} entry - 池条目，含 provider 与 model。
   * @param {object} image - 已落成 DSH 引用的图片。
   */
  async callRoute(entry, image, question, signal, config) {
    const llm = this.llm ?? this.ctx?.get?.("llm") ?? this.ctx?.llm;
    if (!llm || typeof llm.prepareCall !== "function") {
      throw new Error("DSH llm 服务不可用");
    }
    const timeoutMs = Number(config?.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("视觉请求 timeoutMs 必须是正数");
    const controller = new AbortController();
    // AbortSignal.timeout 自带保活，不依赖手写定时器。
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    let timedOut = false;
    timeoutSignal.addEventListener("abort", () => {
      if (signal?.aborted) return;
      timedOut = true;
      controller.abort(new Error(`视觉请求超时（${timeoutMs}ms）`));
    }, { once: true });
    try {
      const call = await llm.prepareCall({
        provider: entry.provider,
        model: entry.model,
      }, controller.signal);
      const prompt = typeof question === "string" && question.trim()
        ? question.trim()
        : String(config?.prompt || DEFAULT_PROMPT);
      const options = {
        ...call.config,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image", attachment: image.attachmentRef },
          ],
        }],
        purpose: "auto-vision-bridge",
        signal: controller.signal,
      };
      const chunks = [];
      for await (const chunk of call.stream(options)) {
        chunks.push(chunk);
      }
      // 超时后即便拿到了文本也要失败：这次请求已经超预算。
      if (timedOut) throw new Error(`视觉请求超时（${timeoutMs}ms）`);
      const text = extractText(chunks);
      if (!text) throw new Error("视觉模型返回空识别文本");
      return text;
    } catch (error) {
      if (timedOut) throw new Error(`视觉请求超时（${timeoutMs}ms）`);
      if (signal?.aborted) throw new Error("视觉请求已取消");
      throw new Error(safeErrorMessage(error, config));
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  /** 派发一个条目并执行请求，失败时按配置重试。 */
  async dispatch(image, question, signal, config) {
    const limit = retryLimitOf(config);
    let lastError;
    for (let attempt = 0; attempt <= limit; attempt += 1) {
      if (signal?.aborted) throw new Error("视觉请求已取消");
      const entry = await this.scheduler.acquire(signal);
      if (!entry) {
        // 拿不到条目：要么池是空的，要么全池都在熔断冷却。
        if (this.scheduler.allTripped?.()) {
          throw new Error("识图模型池全部处于熔断冷却中，请稍后重试或检查模型可用性");
        }
        throw new Error(poolEmptyMessage(config));
      }
      try {
        const answer = await this.callRoute(entry, image, question, signal, config);
        // 成功即清零该条目的连续失败计数。
        this.breaker.recordSuccess(entry.key);
        return answer;
      } catch (error) {
        lastError = error;
        // 上报失败：连续失败到阈值就熔断这个模型，重试时自然改派别的条目。
        this.breaker.recordFailure(entry.key, classifyFailure(error));
      } finally {
        this.scheduler.release(entry.index);
      }
      // 先释放占用再退避，重试时才有空位可派发（可能换到别的条目）。
      if (attempt >= limit) break;
      await sleep(backoffDelay(config?.retryDelayMs, attempt + 1), signal);
    }
    throw lastError ?? new Error("视觉请求失败");
  }

  recognize(image, question, signal) {
    const config = this.getConfig();
    const key = this.cacheKey(image, question, config);
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.promise;
    }

    const entry = { promise: null };
    entry.promise = this.dispatch(image, question, signal, config).then(
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
