// 转写作为「独立的一条 user/message 事件」注入，不再塞进原消息的 content。
//
// 为什么不能塞进 content（2026-11-10 实测定位的偶现泄漏）：
//   1. DSH 把一条 user/message 的所有 text block 拼成同一个用户气泡
//      （dsh-client-ui-chat/lib/client.js:6010 contentParts）。
//   2. 转写一旦进了 content，前端就会把它渲染出来；插件的浏览器端清理脚本
//      又删不掉它 —— DSH 0.2.2 起新增 dsh-message-quotes 与 markdown 行内渲染，
//      会把一段文本切成多个节点，START/END 标记落在不同节点时单节点替换失效。
//      实测（Chrome）：START/END 分属不同父元素时，清理模式为 none、0 节点清除、
//      转写正文完整泄漏；生产 44 个转写块里 1 例命中（2.3%），与「偶现」吻合。
//   3. 会话标题生成器也读同一份 content，于是标题被标记污染。
//
// 现在怎么做：
//   转写单独成一条 user/message 事件，source.kind 不是 "user"，于是宿主把它
//   投影成「上下文注入」而不是用户气泡（dsh-client-ui-chat/lib/client.js:11964：
//   source.kind !== "user" → contextMessage 分支 → 折叠的上下文卡片）。
//   模型侧照常读到它（session.deriveMessages() 走 surface fold，事件即输入），
//   前端用户气泡永远干净。
//
// 事件形态照抄 DSH 官方的 model-selection notice（dsh-agent/lib/index.js:208）：
//   source: { kind, form: "notice", summary }
// 其中 form:"notice" 要求 summary 是非空字符串，否则 notice 分支退化成 opaque。

import { randomUUID } from "node:crypto";
import { loadAttachment, sessionEvents } from "./image-source.js";
import { transcriptionBlock, failedTranscriptionBlock } from "./markers.js";
import { admitImage, safeErrorMessage } from "./vision-client.js";
import { currentRoute, routeModality } from "./route.js";

/** 转写事件的 source.kind。宿主据此把它归类为上下文注入而非用户消息。 */
export const TRANSCRIPTION_SOURCE_KIND = "auto-vision-bridge";

export function hasImageBlock(messages) {
  return (messages ?? []).some((message) => Array.isArray(message?.content)
    && message.content.some((block) => block?.type === "image"));
}

/** 落盘时承载转写的消息字段名（v0.3.0 遗留，读时兼容）。 */
export const TRANSCRIPTION_FIELD = "transcription";

/** 标记「这条消息里的图片已经转写过」的自定义字段。 */
export const TRANSCRIBED_FIELD = "transcribed";

/**
 * 一条消息是否已经被本插件转写过。
 *
 * 判据有三条：
 *   1. message.transcribed —— 本插件写下的标记（含转写条数）；
 *   2. message.transcription —— v0.3.0 的旧形态（转写挂在字段里）；
 *   3. content 里存在带 START/END 标记的旧式转写块（v0.4.x 的旧形态）。
 *
 * 第 1 条是必需的：2026-11-10 起转写是**独立的一条消息**，原消息的 content
 * 里不再有任何标记。若没有这个标记，历史修复会每次扫描都重新识别同一张图、
 * 重新写回 —— 实测会打成无限循环（内存爆掉）。
 */
function alreadyTranscribed(message) {
  if (!message || typeof message !== "object") return false;
  // transcribed 记的是转写条数（数字）；历史上也可能存成数组，两种都认。
  const mark = message.transcribed;
  if (typeof mark === "number" && mark > 0) return true;
  if (Array.isArray(mark) && mark.length > 0) return true;
  if (typeof message.transcription === "string" && message.transcription.length > 0) return true;
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block?.type === "text"
    && typeof block.text === "string"
    && block.text.includes("\u200b[auto-vision-bridge:start]"));
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
 * 转写**不写进原消息的 content**：原消息保持原样（图片 + 用户自己的文字），
 * 转写另起一条 user/message 事件。模型侧照样读到（事件即输入），前端读到的
 * 是折叠的上下文卡片，用户气泡永远干净。
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
    const hasImage = Array.isArray(content)
      && content.some((block) => block?.type === "image");
    if (!hasImage || alreadyTranscribed(message)) {
      nextMessages.push(message);
      continue;
    }
    const pending = [];
    let imageIndex = 0;
    for (let index = 0; index < content.length; index += 1) {
      const block = content[index];
      if (block?.type !== "image") continue;
      pending.push({ block, currentImage: imageIndex++ });
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
          waitMs: Number.isFinite(report.waitMs) ? report.waitMs : 0,
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
          waitMs: 0,
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
      // 转写全文进上下文，不再截断、不再落盘：
      // 实测 44 个转写块中位 870 字符、平均 1303、最大 7173，token 成本可忽略；
      // 而截断会让模型只拿到头尾摘要、漏掉中段细节，白白再调一次 inspect_image。
      blocks.push(transcriptionBlock(item.block.attachment, item.currentImage, result.answer));
    }
    changed = true;
    // 原消息原样保留（宿主给的消息本就是冻结的），但**加上「已转写」标记**：
    // 转写现在是独立的一条消息，原消息的 content 里没有任何标记，
    // 若不留这个标记，历史修复每次扫描都会把同一张图重新识别一遍
    // （实测会打成无限循环直到内存爆掉）。
    nextMessages.push(markTranscribed(message, blocks.length));
    nextMessages.push(...transcriptionMessages(blocks));
  }
  return { messages: changed ? nextMessages : messages, changed };
}

/**
 * 给原消息盖上「已转写」标记。
 *
 * 宿主只校验消息的 id / role / source.kind / content 是数组，**允许额外字段**
 * （v0.3.0 的 transcription 字段就是这么用的，生产已验证）。这里是同一机制：
 * 标记这个会话里的图片已经被本插件转写过，避免重复识别与重复写回。
 *
 * **总是造副本**：就地改会污染调用方传进来的对象 —— 历史修复写回失败时，
 * 原事件对象已经带上标记，下一轮扫描就会误判「已转写」而永远不再修复。
 */
function markTranscribed(message, count) {
  if (!message || typeof message !== "object") return message;
  return { ...message, [TRANSCRIBED_FIELD]: count };
}

/**
 * 把转写块变成模型侧的消息。
 *
 * 每条转写块独立成一条 user/message，source 形如
 * `{ kind: "auto-vision-bridge", form: "notice", summary }`：
 *   - kind 不是 "user" → 前端渲染成折叠的上下文卡片，不是用户气泡；
 *   - form:"notice" 要求 summary 非空，折叠行才有一行摘要可读；
 *   - id 与 role 由 createUserMessage 生成（宿主要求消息有稳定 id）。
 */
function transcriptionMessages(blocks) {
  return blocks.map((block) => createTranscriptionMessage(block));
}

/** 造一条转写消息。 */
function createTranscriptionMessage(block) {
  const text = typeof block?.text === "string" ? block.text : "";
  // 消息形态照抄 DSH 官方的 model-selection notice（dsh-agent/lib/index.js:208）：
  //   source: { kind, form: "notice", summary }
  // 宿主只校验 source.kind 是非空字符串（dsh-session/lib/index.js:1205）、
  // role 是 "user"、content 是数组、消息有非空 id，其余字段自由。
  return {
    role: "user",
    id: randomUUID(),
    content: [{ type: "text", text }],
    source: {
      kind: TRANSCRIPTION_SOURCE_KIND,
      form: "notice",
      summary: noticeSummaryOf(text),
    },
  };
}

/**
 * 折叠行的一行摘要。
 *
 * 取转写的第一段有意义的话（去掉标记行与附件行）。
 * 空则退回固定文案 —— form:"notice" 的 summary 必须非空，否则退化成 opaque。
 * 长度按官方 notice 的同一上限截断（CONTEXT_SUMMARY_MAX_CHARS = 120，
 * 见 dsh-llm/lib/types/message.d.ts）。
 */
const NOTICE_SUMMARY_MAX_CHARS = 120;

export function noticeSummaryOf(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("\u200b[auto-vision-bridge:") && !line.startsWith("[附件："));
  const first = lines[0] ?? "";
  if (!first) return "图片已转写为文字";
  return first.length > NOTICE_SUMMARY_MAX_CHARS
    ? `${first.slice(0, NOTICE_SUMMARY_MAX_CHARS)}…`
    : first;
}

/**
 * 懒修复历史 user/message：把历史上未转写的图片消息补上转写。
 *
 * 只有成功 append 的事件才进入 repaired；append 失败会在下一次 pre-step
 * 重新扫描，绝不提前标记完成。
 */
export async function repairLoggedImages(ctx, session, deps, repaired = new Set()) {
  // Session 不暴露 events 属性，只有 eventsSnapshot 字段与 snapshotEvents()
  // 方法；早前误读 session.events 导致这里恒为空数组，replace 写回从未发生。
  //
  // **必须先复制一份再遍历**：下面的写回会 append 新事件，若宿主返回的是
  // 活数组，遍历会追着自己 append 的事件跑成无限循环（实测内存爆掉）。
  const events = [...sessionEvents(session)];
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
    // 已有转写就不再重复识别。
    if (alreadyTranscribed(event.data) || event.data.content.some((block) =>
      block?.type === "image" && alreadyTranscribed({ content: [block] }))) {
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
      // 写回：原消息用 replace 覆盖（同 seq，不新增气泡），转写另起一条 append 事件。
      await session.append("user/message", bridged.messages[0], {
        surfaceOp: { op: "replace", startSeq: event.seq, endSeq: event.seq },
        sourceEventSeqs: [event.seq],
      });
      for (const message of bridged.messages.slice(1)) {
        await session.append("user/message", message, { surfaceOp: "append" });
      }
      repaired.add(event.seq);
      ctx.logger?.info?.(`[auto-vision-bridge] 已修复历史图片事件 seq=${event.seq}`);
    } catch (error) {
      ctx.logger?.warn?.(`[auto-vision-bridge] 历史事件 seq=${event.seq} 写回失败：${safeErrorMessage(error, deps.getConfig())}`);
    }
  }
  return repaired;
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
