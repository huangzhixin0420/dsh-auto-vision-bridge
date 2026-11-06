// 转写的模型侧注入：让图片转写只对模型可见，完全不进入 Web GUI 的用户消息。
//
// 背景（2026-11-06 实测）：
//   1. DSH 把一条 user/message 的所有 text block 拼成同一个用户气泡
//      （dsh-client-ui-chat/lib/client.js:6010 contentParts）。
//   2. 转写文本若留在 content 里，前端就会把它渲染出来；插件的浏览器端
//      清理脚本又删不掉它 —— DSH 0.2.2 起新增 dsh-message-quotes 与 markdown
//      行内渲染，会把一段文本切成多个 <span class="_plainRun">，START/END
//      标记落在不同节点，单节点替换失效。
//   3. 会话标题生成器也读同一份 content，于是标题被标记污染。
//
// 做法：转写随消息落到 event.data.transcription（DSH 的消息事件只校验
// id/role/source.kind/content 是数组，允许额外字段），**content 保持干净**；
// 再在 llm/stream 钩子里把转写以 text 块注入模型侧的 messages。
//   - 前端读原始 event.data.content —— 看不到转写；
//   - 模型侧读到的是注入了转写的副本 —— 转写照常生效。
//
// 为什么不用 session message projection：投影要求它自己的事件类型独占
// 一个 surface 位置（实测：把投影挂在 user/message 上会让该消息失去 surface
// 位置，deriveMessages 收不到它），且插件记录必须晚于目标消息落盘才能被
// 投影扫到，而 DSH 的 step() 在落盘与 buildRequest 之间没有可插入的 await。

/** 落盘时承载转写的消息字段名。 */
export const TRANSCRIPTION_FIELD = "transcription";

/** 是否是普通对象。 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读取一条消息上承载的转写。
 *
 * @param {object} message - 消息。
 * @returns {string|null} 转写文本；没有则为 null。
 */
export function transcriptionOf(message) {
  const value = message?.[TRANSCRIPTION_FIELD];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 判断一条消息是否已经被本插件转写过（避免重复识别）。
 *
 * @param {object} message - 消息。
 * @returns {boolean} 已有转写则为 true。
 */
export function hasTranscription(message) {
  return transcriptionOf(message) !== null;
}

/**
 * 把转写以 text 块注入模型侧的消息副本。
 *
 * @param {object} message - 模型侧消息。
 * @returns {object} 注入后的新消息；无需注入时原样返回。
 */
export function withTranscription(message) {
  const transcription = transcriptionOf(message);
  if (transcription === null) return message;
  return {
    ...message,
    content: [...message.content, { type: "text", text: transcription }],
  };
}

/**
 * 给一组模型侧消息注入转写。
 *
 * @param {object[]} messages - 模型侧消息。
 * @returns {object[]} 注入后的新数组；没有需要注入的消息时原样返回。
 */
export function injectTranscriptions(messages) {
  if (!Array.isArray(messages)) return messages;
  let next;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const projected = withTranscription(message);
    if (projected === message) continue;
    next ??= messages.slice(0, index);
    next.push(projected);
  }
  return next ?? messages;
}
