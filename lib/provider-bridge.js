// 包装 provider：图片先转写成文本，再转发给真实的文本 provider。
//
// 为什么必须在 provider 层做：
//   1. agent/pre-step 钩子是阻塞式的：Web GUI 发图后要等转写跑完才能继续，
//      界面因此闪烁；
//   2. llm/stream waterfall 改不了 messages —— args 是宿主闭包捕获的原始
//      参数，next() 不接受替换，只有 adapter 自己的 stream 能改；
//   3. 宿主是否把图片剥成文字占位符，只看 modelInfo.inputModalities 是否包含
//      "image"（dsh-llm/lib/index.js:2342）。包装层声明包含 "image"，就能在
//      自己的 stream 里拿到原始图片块。
//
// 模块只负责「造一个 adapter 对象」；注册（ctx.llm.registerAdapter）留给集成方，
// 因为重复注册同名 provider 会抛 DUPLICATE_ADAPTER，注册时机必须由集成方掌握。

import { loadAttachment } from "./image-source.js";
import { attachmentIdentity, stripModelPrelude, transcriptionBlock } from "./markers.js";
import { admitImage, safeErrorMessage } from "./vision-client.js";

/** 宿主模型选择里显示的名字：让用户知道这是一层桥，不是真实模型。 */
const PROVIDER_NAME = "视觉桥接";

/** 转写缓存上限。一张图的转写可能是一篇文档，长会话里不能无限囤。 */
const CACHE_LIMIT = 500;

/**
 * 只把这几个请求控制参数交给内部 prepareCall。
 *
 * 不能把整个 options 传进去：prepareCall 会把 config 深拷贝成 resolvedConfig，
 * 连 messages 一起复制既慢又可能在遇到不可克隆对象时直接炸。
 */
const CONTROL_KEYS = ["maxTokens", "temperature", "reasoningEffort", "stop"];

/**
 * 造一个「视觉桥接」adapter。
 *
 * 它拥有一个新 provider（id 由调用方注册时给出），内部把请求转发给
 * `innerProvider`：图片块先转写成 text 块，其余字段原样透传。
 *
 * @param {object} deps - 依赖。
 * @param {object} deps.ctx - 宿主上下文，需提供 attachments 服务。
 * @param {object} deps.llm - 宿主 llm 服务，用来取内部 provider 的流。
 * @param {() => object} deps.getConfig - 读插件配置。
 * @param {object} deps.client - 视觉客户端，需提供 recognizeWithReport（或 recognize）。
 * @param {string} deps.innerProvider - 真实 provider 的 id，例如 "c2a"。
 * @param {string} [deps.modelId] - 内部模型 id 的缺省值：模型名为空或内部列表为空时用它。
 * @param {object} [deps.logger] - 日志；缺省回退 ctx.logger。
 * @returns {object} 满足 registerAdapter 鸭子类型契约的 adapter。
 */
export function createVisionBridgeAdapter({ ctx, llm, getConfig, client, innerProvider, modelId, logger, history = null }) {
  if (!llm || typeof llm.prepareCall !== "function") {
    throw new Error("视觉桥接：llm 服务不可用（需要 prepareCall）");
  }
  if (!innerProvider) {
    throw new Error("视觉桥接：必须指定内层 provider");
  }
  const log = logger ?? ctx?.logger ?? null;
  // 缓存的是 Promise，同轮并发引用同一张图时只会真的转写一次。
  const cache = new Map();

  function settings() {
    const config = typeof getConfig === "function" ? getConfig() : undefined;
    return config?.providerBridge ?? {};
  }

  /**
   * 是否接管请求。
   *
   * 用 `!== false` 而不是 `=== true`：adapter 只有在集成方决定注册之后才存在，
   * 「默认关闭」由注册时机保证（配置里 providerBridge.enabled 默认 false）。
   * 这里只负责运行期热关 —— 显式写了 false 就立刻恢复成透传。
   */
  function enabled() {
    return settings()?.enabled !== false;
  }

  /** 转发后的模态声明：开启时必须含 image，否则宿主会先把图剥成占位符。 */
  function modalitiesOf(model) {
    if (!enabled()) return {};
    const declared = Array.isArray(model?.inputModalities) ? model.inputModalities : [];
    // 没声明模态的内部模型按文本处理：转写完发给它的本来就是文本。
    const base = declared.length > 0 ? declared : ["text"];
    return { inputModalities: [...new Set([...base, "image"])] };
  }

  /**
   * 把内部模型信息改写成包装 provider 名下的模型信息。
   *
   * normalizeModelInfo 会校验 `provider === 注册时的 id` 且 `id === 请求的 model`，
   * 所以这两个字段必须改写，其余（上下文窗口、推理档位）原样保留，否则宿主校验
   * reasoningEffort 时会误判为不支持。
   */
  function wrapModel(info, provider, model) {
    return {
      ...info,
      provider,
      id: model,
      name: info?.name || model,
      ...modalitiesOf(info),
    };
  }

  /** 内层不能是自己：配错会一路递归到栈溢出，这里提前给出可读的报错。 */
  function assertNotSelf(provider) {
    if (provider === innerProvider) {
      throw new Error(`视觉桥接：内层 provider 不能是本 provider 自己（${provider}）`);
    }
  }

  /** 取内部 provider 的真实模型能力。 */
  async function innerModelInfo(model, signal) {
    if (typeof llm.resolveModelInfo !== "function") {
      throw new Error("视觉桥接：llm.resolveModelInfo 不可用，无法转发模型能力");
    }
    try {
      return await llm.resolveModelInfo(innerProvider, model, signal);
    } catch (error) {
      throw new Error(
        `视觉桥接：内层 provider「${innerProvider}」的模型「${model}」不可用（${error?.message ?? error}）`,
        { cause: error },
      );
    }
  }

  /**
   * 记一条识图历史。
   *
   * 历史是旁路：写失败只记日志，绝不能让转写因此失败。
   * source 用 `provider` 与 pre-step 桥接的 `bridge`、工具的 `inspect` 区分开，
   * 三者共用一个账本，历史页才能看出这次识图是谁发起的。
   */
  async function recordTranscription({ provider, model, ok, error, startedAt, report, attachment, sessionId }) {
    const ledger = typeof history === "function" ? history() : history;
    if (!ledger || typeof ledger.record !== "function") return;
    try {
      await ledger.record({
        provider: String(provider ?? ""),
        model: String(model ?? ""),
        ok,
        error: String(error ?? ""),
        // durationMs 只算模型耗时：池满时的排队时间单独记，否则会被误读成模型慢。
        durationMs: Number.isFinite(report?.durationMs) ? report.durationMs : Date.now() - startedAt,
        waitMs: Number.isFinite(report?.waitMs) ? report.waitMs : 0,
        cached: report?.cached === true,
        attachmentId: String(attachment?.attachmentId ?? ""),
        imageName: String(attachment?.name ?? ""),
        source: "provider",
        sessionId: String(sessionId ?? ""),
        attempt: Number.isFinite(report?.attempt) ? report.attempt : 1,
      }, log);
    } catch (failure) {
      log?.warn?.(`[auto-vision-bridge] provider 桥接记账失败：${failure?.message ?? failure}`);
    }
  }

  /**
   * 转写一张图。
   *
   * 失败不抛：这一轮请求要继续跑，用一个说明块告诉主模型「这里本来有图，但没
   * 转写出来」，比整轮失败有用。取消是例外 —— 用户取消后不该再发请求。
   */
  async function transcribe(attachment, index, { signal, sessionId }) {
    const config = typeof getConfig === "function" ? getConfig() : {};
    const startedAt = Date.now();
    try {
      if (!attachment) throw new Error("图片块缺少 attachment 引用");
      if (!client) throw new Error("视觉客户端未就绪");
      // 字节不在块里，要从附件服务读；loadAttachment 顺带做了大小与格式校验。
      const image = await loadAttachment(ctx, attachment, config, signal);
      // llm 通道只认持久引用，先把字节经附件服务落成引用再交给视觉客户端。
      const attachmentRef = await admitImage(ctx, image);
      const report = typeof client.recognizeWithReport === "function"
        ? await client.recognizeWithReport({ ...image, attachmentRef }, undefined, signal)
        : { text: await client.recognize({ ...image, attachmentRef }, undefined, signal) };
      const answer = String(report?.text ?? "").trim();
      if (!answer) throw new Error("视觉模型返回空识别文本");
      await recordTranscription({
        provider: report?.provider,
        model: report?.model,
        ok: true,
        error: "",
        startedAt,
        report,
        attachment,
        sessionId,
      });
      // 转写全文进请求，不再截断、不再落盘。
      // 先裁掉视觉模型复述任务的那段独白：它永远是开头几句，白占预算。
      const pruned = stripModelPrelude(answer);
      return { ok: true, text: transcriptionBlock(attachment, index, pruned).text };
    } catch (error) {
      if (signal?.aborted) throw error;
      const reason = safeErrorMessage(error, config);
      log?.warn?.(`[auto-vision-bridge] provider 桥接转写失败：${reason}`);
      const route = (error && typeof error === "object" && error.dshVisionRoute) || {};
      await recordTranscription({
        provider: route.provider,
        model: route.model,
        ok: false,
        error: reason,
        startedAt,
        report: null,
        attachment,
        sessionId,
      });
      return {
        ok: false,
        text: `[图片转写失败：${reason}]（${attachmentIdentity(attachment, index)}）`,
      };
    }
  }

  /**
   * 按 attachmentId 取转写。
   *
   * 缓存键只用 attachmentId：附件是内容寻址的，同一个 id 一定是同一张图，所以
   * 同一会话里重复引用不会重复花钱。代价是改提示词后旧转写仍会命中 —— 这是
   * 刻意的取舍，转写是「这张图是什么」，不是「按新提示词重答一遍」。
   */
  function transcribeCached(attachment, index, deps) {
    const key = String(attachment?.attachmentId ?? "").trim();
    if (!key) return transcribe(attachment, index, deps).then((result) => result.text);

    const hit = cache.get(key);
    if (hit) {
      // 重新插入到末尾，维持 LRU 顺序。
      cache.delete(key);
      cache.set(key, hit);
      return hit.promise;
    }

    const entry = { promise: null };
    entry.promise = transcribe(attachment, index, deps).then((result) => {
      // 失败不留在缓存里：一次抖动不该把这张图钉死成永久失败。
      if (!result.ok && cache.get(key) === entry) cache.delete(key);
      return result.text;
    });
    cache.set(key, entry);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return entry.promise;
  }

  /**
   * 把消息里的图片块换成 text 块。
   *
   * 没有图片时返回原数组（同一引用），让纯文本请求的透传完全无副作用。
   * `offloaded === true` 的图是压缩时被卸载掉的：字节读不到，也绝不能原样转发。
   */
  async function bridgeMessages(messages, deps) {
    if (!Array.isArray(messages)) return messages;
    if (!messages.some((message) => Array.isArray(message?.content)
      && message.content.some((block) => block?.type === "image"))) {
      return messages;
    }
    const next = [];
    for (const message of messages) {
      const content = message?.content;
      if (!Array.isArray(content) || !content.some((block) => block?.type === "image")) {
        next.push(message);
        continue;
      }
      const blocks = [];
      let index = 0;
      for (const block of content) {
        if (block?.type !== "image") {
          blocks.push(block);
          continue;
        }
        const position = index++;
        if (block.offloaded === true) {
          // 字节已被压缩卸载，读不到也不该读；但必须换成文字 —— 包装层声明了
          // 支持 image，宿主不会再替内层投影，原样转发会让文本模型收到 image 块。
          blocks.push({
            type: "text",
            text: `[图片已因上下文压缩被省略，无法转写]（${attachmentIdentity(block.attachment, position)}）`,
          });
          continue;
        }
        blocks.push({ type: "text", text: await transcribeCached(block.attachment, position, deps) });
      }
      next.push({ ...message, content: blocks });
    }
    return next;
  }

  /** 只取请求控制参数，避免把 messages 等大对象塞进内部 prepareCall 的深拷贝。 */
  function controlsOf(options) {
    const controls = {};
    for (const key of CONTROL_KEYS) {
      if (options?.[key] !== undefined) controls[key] = options[key];
    }
    return controls;
  }

  /**
   * 把历史 assistant 消息的归属改回内部 provider。
   *
   * 宿主的 forAdapter() 会剥掉「`source.provider` 不属于目标 adapter」的消息上的
   * replayState（dsh-llm/lib/index.js 的 forAdapter）。经包装层转发时，历史
   * assistant 消息的 `source.provider` 是包装 provider，内层 adapter 认不出自己，
   * replayState 就被删了 —— 推理模型的多轮 reasoning 回放会因此失效。
   *
   * 请求确实发给了内层 provider，所以把归属改回去既修问题也符合事实；
   * 改的是请求侧副本，持久化事件不受影响。
   */
  function reattribute(messages, outerProvider) {
    if (!Array.isArray(messages) || typeof outerProvider !== "string" || outerProvider === innerProvider) {
      return messages;
    }
    let changed = false;
    const next = messages.map((message) => {
      if (message?.role !== "assistant") return message;
      const source = message.source;
      if (!source || typeof source !== "object" || source.provider !== outerProvider) return message;
      changed = true;
      return { ...message, source: { ...source, provider: innerProvider } };
    });
    return changed ? next : messages;
  }

  /**
   * 一次真正的请求：转写图片 → 取内部流 → 原样透传 chunk。
   *
   * 内部流必须用 `llm.prepareCall({ provider: innerProvider, model })` 取：
   * 它返回的 `stream` 会自己完成 adapter 选择、能力校验与图片投影，等价于宿主
   * 发起一次普通请求。返回的 handle 只能 dispatch 一次，所以每次请求都要重取。
   */
  async function* stream(options, { model, preparedSignal }) {
    const outer = options ?? {};
    const signal = outer.signal ?? preparedSignal;
    // 关闭时整条链路必须与「没装这个 adapter」等价：不读图、不转写、不改消息。
    const messages = enabled() ? await bridgeMessages(outer.messages, { signal }) : outer.messages;
    const call = await llm.prepareCall({
      provider: innerProvider,
      model,
      ...controlsOf(outer),
    }, signal);
    if (!call || typeof call.stream !== "function") {
      throw new Error(`视觉桥接：内层 provider「${innerProvider}」没有返回可用的流`);
    }
    // provider/model 必须切到内层：宿主会拿它们与内部 resolvedConfig 逐字段比对，
    // 不一致就抛 INVALID_PREPARED_CALL（messages 不在比对范围内，所以能改）。
    const innerOptions = { ...outer, ...call.config, messages: reattribute(messages, outer.provider) };
    for await (const chunk of call.stream(innerOptions)) yield chunk;
  }

  return {
    providerInfo(provider) {
      // 显示名允许被配置覆盖，集成方不必为了改名字多传一个参数。
      const name = String(settings()?.displayName ?? "").trim() || PROVIDER_NAME;
      return { id: provider, name };
    },

    /**
     * 重试策略转发给内层。
     *
     * 这个方法**必须存在**：实测 dsh-llm 的 prepareRoutes 会无条件调用它，
     * 缺了直接 TypeError（尽管文档口径是可选）。返回 undefined 即用宿主默认。
     */
    providerRetryPolicy() {
      if (typeof llm.providerRetryPolicy !== "function") return undefined;
      try {
        return llm.providerRetryPolicy(innerProvider);
      } catch {
        return undefined;
      }
    },

    /** 模型列表转调内部 provider，只把归属改成本 provider。 */
    async listModels(provider) {
      assertNotSelf(provider);
      if (typeof llm.listModels !== "function") {
        throw new Error("视觉桥接：llm.listModels 不可用，无法转发模型列表");
      }
      const models = await llm.listModels(innerProvider);
      const list = Array.isArray(models) ? models : [];
      if (list.length === 0 && modelId) {
        return [{ provider, id: modelId, name: modelId, ...modalitiesOf({}) }];
      }
      return list.map((model) => ({ ...model, provider, ...modalitiesOf(model) }));
    },

    /** 模型能力转调内部 provider，并补上 image 模态。 */
    async resolveModel(provider, model, signal) {
      assertNotSelf(provider);
      const inner = model || modelId;
      if (!inner) throw new Error("视觉桥接：模型 id 为空");
      return wrapModel(await innerModelInfo(inner, signal), provider, inner);
    },

    /** 准备一次调用：能力来自内层，流由本模块包装。 */
    async prepareCall(provider, model, signal) {
      assertNotSelf(provider);
      const inner = model || modelId;
      if (!inner) throw new Error("视觉桥接：模型 id 为空");
      const info = await innerModelInfo(inner, signal);
      return {
        model: wrapModel(info, provider, inner),
        stream: (options) => stream(options, { model: inner, preparedSignal: signal }),
      };
    },
  };
}
