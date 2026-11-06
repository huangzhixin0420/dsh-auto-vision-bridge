export function testConfig(overrides = {}) {
  return {
    enabled: true,
    prompt: "默认识别提示",
    timeoutMs: 1000,
    maxImageBytes: 1024 * 1024,
    retries: 0,
    retryDelayMs: 0,
    maxConcurrent: 4,
    failureThreshold: 3,
    cooldownMs: 60000,
    dumpThreshold: 500,
    summaryLength: 400,
    pool: [],
    ...overrides,
  };
}

export function attachment(id = "sha256:abc", name = `${id.replace(/:/g, "-")}.png`) {
  return { attachmentId: id, name, mediaType: "image/png", bytes: 3 };
}

export function imageMessage(blocks, extra = {}) {
  return {
    role: "user",
    source: { kind: "user" },
    content: blocks,
    ...extra,
  };
}

/**
 * 取一条消息的转写文本。
 *
 * 转写不再进 content（DSH 会把 content 的 text block 拼成用户气泡），
 * 而是另存于消息的 transcription 字段，由模型侧注入。
 */
export function transcriptionOf(message) {
  const value = message?.transcription;
  return typeof value === "string" ? value : "";
}

/**
 * 取消息里第 index 段转写（多图时每张图一段）。
 */
export function transcriptionPart(message, index = 0) {
  return transcriptionOf(message).split("\n\n")[index] ?? "";
}

export function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

/** 旧的 OpenAI 兼容响应体，仅供仍按该协议断言的用例使用。 */
export function visionResponse(text) {
  return jsonResponse({ choices: [{ message: { content: text } }] });
}

export function imageOf(text, attachmentId = "") {
  return { data: Buffer.from(text), mediaType: "image/png", attachmentId };
}

export const identityDefineTool = (definition) => definition;

/** 可控的取数器：记录并发峰值，便于断言并发行为。 */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * 假的 attachments 服务：把图片字节落成持久引用。
 *
 * llm 通道只接受 `{ type: "image", attachment: <引用> }`，
 * 插件必须先把图片经 saveImages 换成引用，测试要能观察到这一步。
 */
export function fakeAttachments(options = {}) {
  const saved = [];
  return {
    saved,
    async readImage(ref) {
      if (options.readImage) return options.readImage(ref);
      return { data: Buffer.from("bytes"), mediaType: "image/png", ref: { mediaType: "image/png" } };
    },
    async saveImages(inputs) {
      const refs = [];
      for (const input of inputs) {
        const ref = {
          attachmentId: `sha256:${Buffer.from(input.data).toString("hex").slice(0, 12)}`,
          name: input.name,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
        };
        saved.push({ ref, bytes: input.data });
        refs.push(ref);
      }
      return refs;
    },
  };
}

/**
 * 假的 llm 服务：按 provider+model 派发可编程的回复。
 *
 * routes 形如 `{ "c2a/vision": "识别文本" }`；未命中的路由抛错，
 * 便于断言「换条目重试」。
 */
export function fakeLlm(routes = {}, options = {}) {
  const calls = [];
  let inflight = 0;
  let peak = 0;
  return {
    calls,
    get peak() { return peak; },
    async prepareCall(config, signal) {
      const key = `${config.provider}/${config.model}`;
      calls.push({ provider: config.provider, model: config.model });
      const answer = routes[key];
      if (answer === undefined) {
        throw new Error(`未配置的路由：${key}`);
      }
      return {
        config,
        async *stream(streamOptions) {
          inflight += 1;
          peak = Math.max(peak, inflight);
          try {
            // 注意：延迟来自构造参数，不是 stream 的入参。
            if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
            const text = typeof answer === "function" ? await answer(streamOptions) : answer;
            yield { text };
          } finally {
            inflight -= 1;
          }
        },
      };
    },
  };
}
