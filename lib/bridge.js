import { loadAttachment } from "./image-source.js";
import { failedTranscriptionBlock, isTranscriptionBlock, transcriptionBlock } from "./markers.js";
import { storeTranscript } from "./transcript-store.js";
import { admitImage, safeErrorMessage } from "./vision-client.js";
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
 * 多图并发识别，单图失败转为该图的失败标记，不中断其他图片。
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
    const pending = [];
    let imageIndex = 0;
    for (let index = 0; index < content.length; index += 1) {
      const block = content[index];
      blocks.push(block);
      if (block?.type !== "image") continue;
      const currentImage = imageIndex++;
      if (alreadyBridged(content, index)) continue;
      // 先占位，稍后按原顺序回填，保证并发下 block 顺序不变。
      const slot = blocks.length;
      blocks.push(null);
      pending.push({ slot, block, currentImage });
    }
    // 多张图片并发识别；模型池的并发上限负责真正限流。
    const results = await Promise.all(pending.map(async (item) => {
      try {
        const image = await loadAttachment(ctx, item.block.attachment, getConfig(), signal);
        // llm 通道只认持久引用，图片要先经附件服务落盘。
        const attachmentRef = await admitImage(ctx, image);
        const answer = await client.recognize({ ...image, attachmentRef }, undefined, signal);
        return { item, answer };
      } catch (error) {
        return { item, error };
      }
    }));
    for (const result of results) {
      const { item } = result;
      if (result.error) {
        blocks[item.slot] = failedTranscriptionBlock(
          item.block.attachment,
          item.currentImage,
          safeErrorMessage(result.error, getConfig()),
        );
        continue;
      }
      // 转写过长时：摘要进上下文，全文写文件，只把路径给主模型。
      const stored = await storeTranscript(result.answer, {
        config: getConfig(),
        hint: item.block.attachment?.name,
      });
      blocks[item.slot] = transcriptionBlock(item.block.attachment, item.currentImage, stored.text);
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
