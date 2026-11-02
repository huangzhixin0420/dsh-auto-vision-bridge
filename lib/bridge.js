import { loadAttachment } from "./image-source.js";
import { failedTranscriptionBlock, isTranscriptionBlock, transcriptionBlock } from "./markers.js";
import { safeErrorMessage } from "./vision-client.js";
import { currentRoute, routeModality } from "./route.js";

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
 * 原图、用户文本及其他 block 均保留原引用；只在未桥接图片后插入转写。
 * 单图失败转为该图的失败标记，不中断其他图片。
 */
export async function bridgeMessages(messages, { ctx, client, getConfig, signal } = {}) {
  let changed = false;
  const nextMessages = [];
  for (const message of messages ?? []) {
    const content = message?.content;
    if (!Array.isArray(content) || !content.some((block, index) =>
      block?.type === "image" && !alreadyBridged(content, index))) {
      nextMessages.push(message);
      continue;
    }
    const blocks = [];
    let imageIndex = 0;
    for (let index = 0; index < content.length; index += 1) {
      const block = content[index];
      blocks.push(block);
      if (block?.type !== "image") continue;
      const currentImage = imageIndex++;
      if (alreadyBridged(content, index)) continue;
      try {
        const image = await loadAttachment(ctx, block.attachment, getConfig(), signal);
        const answer = await client.recognize(image, undefined, signal);
        blocks.push(transcriptionBlock(block.attachment, currentImage, answer));
      } catch (error) {
        const safe = safeErrorMessage(error, getConfig());
        blocks.push(failedTranscriptionBlock(block.attachment, currentImage, safe));
      }
    }
    changed = true;
    nextMessages.push(deepFreeze({ ...message, content: blocks }));
  }
  return changed ? nextMessages : messages;
}

/**
 * 懒修复历史 user/message。只有成功 append 的事件才进入 repaired；
 * append 失败会在下一次 pre-step 重新扫描，绝不提前标记完成。
 */
export async function repairLoggedImages(ctx, session, deps, repaired = new Set()) {
  const events = [...(session?.events ?? [])];
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
    const hasUnbridged = event.data.content.some((block, index) =>
      block?.type === "image" && !alreadyBridged(event.data.content, index));
    if (!hasUnbridged) {
      repaired.add(event.seq);
      continue;
    }
    try {
      const [bridged] = await bridgeMessages([event.data], {
        ...deps,
        ctx,
        signal: deps.signal,
      });
      await session.append("user/message", bridged, {
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

/** 根级监听器服务所有 Agent，包括重启后恢复、不会再触发 created 的会话。 */
export function attachPreStepBridge(ctx, { client, getConfig }) {
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
    const messages = await bridgeMessages(decision.messages, {
      ctx,
      client,
      getConfig,
      signal: payload.signal,
    });
    if (messages === decision.messages) return decision;
    return { ...decision, messages };
  });
}
