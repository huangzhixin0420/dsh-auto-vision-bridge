import { loadAttachment, sessionEvents } from "./image-source.js";
import { failedTranscriptionBlock, isTranscriptionBlock, transcriptionBlock } from "./markers.js";
import { storeTranscript } from "./transcript-store.js";
import { admitImage, safeErrorMessage } from "./vision-client.js";
import { currentRoute, routeModality } from "./route.js";
import { TRANSCRIPTION_FIELD, hasTranscription, injectTranscriptions } from "./transcription.js";

export function hasImageBlock(messages) {
  return (messages ?? []).some((message) => Array.isArray(message?.content)
    && message.content.some((block) => block?.type === "image"));
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function alreadyBridged(content, index) {
  return isTranscriptionBlock(content[index + 1]);
}

/**
 * 记一条识图历史。
 *
 * 历史是旁路：写失败只记日志，绝不让它把用户的识图带崩。
 */
async function recordHistory(history, record, logger) {
  if (!history) return;
  try {
    await history.record(record, logger);
  } catch (error) {
    logger?.warn?.(`[auto-vision-bridge] 识图历史记账失败：${error?.message ?? error}`);
  }
}

/**
 * 识别一条消息里的图片，把转写结果收集起来。
 *
 * 转写**不写进 content**：DSH 把一条消息的所有 text block 拼成同一个用户气泡，
 * 转写一旦进 content，Web GUI 就会把它渲染出来（且插件的浏览器端清理脚本
 * 删不掉 —— DSH 0.2.2 起会把文本切成多个 span，标记跨节点）。转写改为随消息
 * 落到 event.data.transcription，由 lib/transcription-projection.js 的投影
 * 只注入模型侧副本，前端读原始 content 因此完全看不到。
 *
 * 多图并发识别，单图失败转为该图的失败说明，不中断其他图片。
 *
 * @param {object[]} messages - 待处理消息。
 * @param {object} deps - 依赖。
 * @param {object} [deps.history] - 识图历史账本；给了就逐图记账。
 * @param {string} [deps.sessionId] - 所属会话 id（记账用）。
 * @returns {Promise<{messages: object[], changed: boolean}>}
 */
export async function bridgeMessages(messages, { ctx, client, getConfig, signal, history = null, sessionId = "" } = {}) {
  let changed = false;
  const nextMessages = [];
  for (const message of messages ?? []) {
    const content = message?.content;
    if (!Array.isArray(content) || !content.some((block, index) =>
      block?.type === "image" && !alreadyBridged(content, index))) {
      nextMessages.push(message);
      continue;
    }
    const pending = [];
    let imageIndex = 0;
    for (let index = 0; index < content.length; index += 1) {
      const block = content[index];
      if (block?.type !== "image") continue;
      const currentImage = imageIndex++;
      if (alreadyBridged(content, index)) continue;
      pending.push({ block, currentImage });
    }
    // 多张图片并发识别；模型池的并发上限负责真正限流。
    const results = await Promise.all(pending.map(async (item) => {
      const startedAt = Date.now();
      const attachment = item.block.attachment;
      const imageName = String(attachment?.name ?? "");
      try {
        const image = await loadAttachment(ctx, item.block.attachment, getConfig(), signal);
        // llm 通道只认持久引用，图片要先经附件服务落盘。
        const attachmentRef = await admitImage(ctx, image);
        // 优先用带回报的接口（能拿到实际派发的模型与耗时）；旧客户端
        // 只有 recognize 时退回，记账里就没有模型信息。
        const report = typeof client.recognizeWithReport === "function"
          ? await client.recognizeWithReport({ ...image, attachmentRef }, undefined, signal)
          : { text: await client.recognize({ ...image, attachmentRef }, undefined, signal), provider: "", model: "", durationMs: Date.now() - startedAt, cached: false, attempt: 1 };
        await recordHistory(history, {
          provider: report.provider,
          model: report.model,
          ok: true,
          error: "",
          durationMs: report.durationMs,
          cached: report.cached,
          attachmentId: String(image.attachmentId ?? attachment?.attachmentId ?? ""),
          imageName,
          source: "bridge",
          sessionId,
          attempt: report.attempt,
        }, ctx?.logger);
        return { item, answer: report.text };
      } catch (error) {
        const message = safeErrorMessage(error, getConfig());
        // 失败也记账「试过哪个模型」：VisionClient 会把最后一次派发的路由挂到
        // error.dshVisionRoute 上，没有就用空值（旧客户端或调用前的失败）。
        const route = (error && typeof error === "object" && error.dshVisionRoute) || {};
        await recordHistory(history, {
          provider: route.provider ?? "",
          model: route.model ?? "",
          ok: false,
          error: message,
          durationMs: Date.now() - startedAt,
          cached: false,
          attachmentId: String(attachment?.attachmentId ?? ""),
          imageName,
          source: "bridge",
          sessionId,
          attempt: route.attempt ?? 1,
        }, ctx?.logger);
        return { item, error };
      }
    }));
    const blocks = [];
    for (const result of results) {
      const { item } = result;
      if (result.error) {
        blocks.push(failedTranscriptionBlock(
          item.block.attachment,
          item.currentImage,
          safeErrorMessage(result.error, getConfig()),
        ));
        continue;
      }
      // 转写过长时：摘要进上下文，全文写文件，只把路径给主模型。
      const stored = await storeTranscript(result.answer, {
        config: getConfig(),
        hint: item.block.attachment?.name,
      });
      blocks.push(transcriptionBlock(item.block.attachment, item.currentImage, stored.text));
    }
    changed = true;
    // content 保持原样（只有原图与用户自己的文字），转写另存一份。
    const transcription = blocks.map((block) => block.text).join("\n\n");
    nextMessages.push(deepFreeze({ ...message, [TRANSCRIPTION_FIELD]: transcription }));
  }
  return { messages: changed ? nextMessages : messages, changed };
}

/**
 * 懒修复历史 user/message：把历史上未转写的图片消息补上转写。
 *
 * 只有成功 append 的事件才进入 repaired；append 失败会在下一次 pre-step
 * 重新扫描，绝不提前标记完成。
 *
 * 这里写回的版本同样把转写放进 transcription 字段而非 content，
 * 因此前端读到的历史消息同样是干净的。
 */
export async function repairLoggedImages(ctx, session, deps, repaired = new Set()) {
  // Session 不暴露 events 属性，只有 eventsSnapshot 字段与 snapshotEvents()
  // 方法；早前误读 session.events 导致这里恒为空数组，replace 写回从未发生。
  const events = sessionEvents(session);
  const shadowed = new Set();
  for (const event of events) {
    if (event.surfaceOp?.op !== "replace") continue;
    for (const seq of event.sourceEventSeqs ?? []) shadowed.add(seq);
  }
  for (const event of events) {
    if (repaired.has(event.seq) || shadowed.has(event.seq)) continue;
    if (event.type !== "user/message" || !Array.isArray(event.data?.content)) {
      repaired.add(event.seq);
      continue;
    }
    // 已有转写（transcription 字段或旧的 content 内标记块）就不再重复识别。
    if (hasTranscription(event.data) || event.data.content.some((block, index) =>
      block?.type === "image" && alreadyBridged(event.data.content, index))) {
      repaired.add(event.seq);
      continue;
    }
    const hasUnbridged = event.data.content.some((block) => block?.type === "image");
    if (!hasUnbridged) {
      repaired.add(event.seq);
      continue;
    }
    try {
      const bridged = await bridgeMessages([event.data], {
        ...deps,
        ctx,
        signal: deps.signal,
      });
      if (!bridged.changed) {
        repaired.add(event.seq);
        continue;
      }
      await session.append("user/message", bridged.messages[0], {
        surfaceOp: { op: "replace", startSeq: event.seq, endSeq: event.seq },
        sourceEventSeqs: [event.seq],
      });
      repaired.add(event.seq);
      ctx.logger?.info?.(`[auto-vision-bridge] 已修复历史图片事件 seq=${event.seq}`);
    } catch (error) {
      ctx.logger?.warn?.(`[auto-vision-bridge] 历史事件 seq=${event.seq} 写回失败：${safeErrorMessage(error, deps.getConfig())}`);
    }
  }
  return repaired;
}

/**
 * 模型侧注入转写。
 *
 * 会话事件里的 content 保持干净（前端读它），转写另存于消息的 transcription
 * 字段；这里在请求发出前把它以 text 块并入模型侧的 messages，模型照常读到
 * 转写，而 Web GUI 的用户气泡里看不到。
 *
 * 只处理 agent 主循环发出的请求：options.sessionId 存在才注入，避免影响
 * 标题生成、压缩摘要等同样走 llm 通道但不应带图片转写的调用。
 */
export function attachModelSideInjection(ctx) {
  return ctx.on("llm/stream", (options, next) => {
    if (options?.sessionId === undefined) return next();
    const messages = options.messages;
    if (!Array.isArray(messages)) return next();
    const injected = injectTranscriptions(messages);
    if (injected === messages) return next();
    return next({ ...options, messages: injected });
  });
}

/**
 * 根级监听器服务所有 Agent，包括重启后恢复、不会再触发 created 的会话。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} deps - 依赖。
 * @param {object} deps.client - 视觉客户端。
 * @param {Function} deps.getConfig - 读配置。
 * @param {() => object|null} [deps.history] - 取识图历史账本（可能还没就绪）。
 * @param {(session: object) => string} [deps.sessionIdOf] - 取会话 id。
 */
export function attachPreStepBridge(ctx, { client, getConfig, history = null, sessionIdOf = (session) => String(session?.id ?? "") }) {
  const repairedBySession = new WeakMap();
  return ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (!decision || decision.kind !== "enter") return decision;
    const agent = payload?.agent;
    if (!agent?.session) return decision;
    const projections = ctx.sessionProjections ?? ctx.get?.("sessionProjections");
    const route = currentRoute(agent, projections);
    const modality = await routeModality(ctx.llm ?? ctx.get?.("llm"), route, payload.signal);
    // 原生视觉与无法确认的路由均不做历史修复或新消息改写。
    if (modality !== "text") return decision;

    let repaired = repairedBySession.get(agent.session);
    if (!repaired) {
      repaired = new Set();
      repairedBySession.set(agent.session, repaired);
    }
    await repairLoggedImages(ctx, agent.session, { client, getConfig, signal: payload.signal }, repaired);
    const bridged = await bridgeMessages(decision.messages, {
      ctx,
      client,
      getConfig,
      signal: payload.signal,
      history: typeof history === "function" ? history() : history,
      sessionId: sessionIdOf(agent.session),
    });
    if (!bridged.changed) return decision;
    return { ...decision, messages: bridged.messages };
  });
}
