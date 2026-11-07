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
/** 「模型没收到图」的常见说法。只用来认空转，不用来判断内容质量。 */
const BLIND_PATTERNS = [
  /我看不到(?:这|那)?(?:张)?图/,
  /无法(?:查看|看到|识别)(?:这|那)?(?:张)?图/,
  /没有(?:接收|收到)(?:到)?[^。\n]{0,8}图/,
  /图片(?:被)?(?:省略|忽略)/,
  /附件(?:被)?(?:省略|忽略)/,
  /image (?:was |is )?omitted/i,
  /accepts? text only/i,
  /(?:can ?not|can't|could not|couldn't) (?:see|view|read) (?:the )?image/i,
  /unable to (?:see|view|read) (?:the )?image/i,
];

/**
 * 判断模型回复是不是「其实没收到图」。
 *
 * 实测：池里混进不支持视觉的模型（如把主模型当备用候选）时，它会礼貌地回
 * 「图片被省略了 / 我看不到图片 / image omitted」。这类回复 HTTP 200、内容非空，
 * 会被误当成识别成功。判据取「文本很短 + 命中固定句式」，正常转写很少这么短，
 * 也不会恰好写成这几句。
 *
 * @param {string} text - 模型回复。
 * @returns {boolean} true 表示这次调用等于空转，应判失败并改派别的候选。
 */
export function looksBlind(text) {
  const value = String(text ?? "").trim();
  if (value === "") return true;
  if (value.length > 300) return false;
  return BLIND_PATTERNS.some((pattern) => pattern.test(value));
}

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

  /**
   * 派发一个条目并执行请求，失败时按配置重试。
   *
   * @param {object} image - 图片。
   * @param {string} [question] - 追问。
   * @param {AbortSignal} [signal] - 取消信号。
   * @param {object} config - 配置。
   * @param {object} [hooks] - 回调钩子。
   * @param {(provider: string, model: string, attempt: number) => void} [hooks.onRoute] -
   *   每次派发到某个池条目时调用，供记账知道「实际用了哪个模型」。
   * @returns {Promise<string>} 识别文本。
   */
  async dispatch(image, question, signal, config, hooks = {}) {
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
        hooks.onRoute?.(entry.provider, entry.model, attempt + 1);
        const answer = await this.callRoute(entry, image, question, signal, config);
        // 有的路由（池里配了不支持视觉的模型）会礼貌地回一句「图片被省略了，
        // 我看不到图片」，HTTP 200、内容非空，看着像成功。不拦的话这种空转会被
        // 记成成功写进历史，用户拿到的转写就是这句废话。这里当失败处理，接下来的
        // catch 会记熔断失败计数，重试时自然改派别的条目。
        if (looksBlind(answer)) {
          throw new Error(
            `模型没有收到图片（${entry.provider}/${entry.model} 回的是「${String(answer).trim().slice(0, 60)}」）`,
          );
        }
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
    return this.recognizeWithReport(image, question, signal).then((report) => report.text);
  }

  /**
   * 识图并回报这次调用的细节。
   *
   * 与 {@link recognize} 的区别只在返回值：这里多带上「实际派发到哪个模型、
   * 耗时多少、是不是命中缓存」，供识图历史记账用。老的 recognize 保持
   * 返回纯文本，调用方不用改。
   *
   * @param {object} image - 已落成 DSH 引用的图片。
   * @param {string} [question] - 针对性追问；空则用默认提示词。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<{text: string, provider: string, model: string, durationMs: number, cached: boolean, attempt: number}>}
   */
  async recognizeWithReport(image, question, signal) {
    const config = this.getConfig();
    const key = this.cacheKey(image, question, config);
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      const report = await cached.promise;
      // 缓存命中：这次没有真正调用模型，模型信息沿用上一次派发的结果。
      return { ...report, cached: true, durationMs: 0 };
    }

    const startedAt = Date.now();
    const entry = { promise: null, provider: "", model: "", attempt: 1 };
    entry.promise = this.dispatch(image, question, signal, config, {
      onRoute(provider, model, attempt) {
        entry.provider = provider;
        entry.model = model;
        entry.attempt = attempt;
      },
    }).then(
      (text) => {
        this.entries.delete(key);
        this.entries.set(key, entry);
        return {
          text,
          provider: entry.provider,
          model: entry.model,
          durationMs: Date.now() - startedAt,
          cached: false,
          attempt: entry.attempt,
        };
      },
      (error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        // 失败时也要把「试过哪个模型」带出去，否则识图历史里失败记录全是空的，
        // 排不出「是哪条路由挂了」。挂到 error 上，调用方按需读取。
        if (error && typeof error === "object") {
          error.dshVisionRoute = {
            provider: entry.provider,
            model: entry.model,
            attempt: entry.attempt,
          };
        }
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
