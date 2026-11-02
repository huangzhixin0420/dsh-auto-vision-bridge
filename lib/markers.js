// 自动桥接文本的唯一协议。client.js 使用同样的精确标记，不做自由文本猜测。
export const BRIDGE_START = "\u200b[auto-vision-bridge:start]";
export const BRIDGE_END = "\u200b[auto-vision-bridge:end]";

/** 附件身份进入模型侧文本，便于多图时明确对应关系。 */
export function attachmentIdentity(attachment, index = 0) {
  const name = typeof attachment?.name === "string" && attachment.name.trim()
    ? attachment.name.trim()
    : `第 ${index + 1} 张图片`;
  const id = typeof attachment?.attachmentId === "string" && attachment.attachmentId
    ? `，attachmentId=${attachment.attachmentId}`
    : "";
  return `${name}${id}`;
}

/** 防止上游文本伪造协议边界，导致浏览器误清理其他内容。 */
export function sanitizeTranscription(text) {
  return String(text).split(BRIDGE_START).join("[auto-vision-bridge:start]")
    .split(BRIDGE_END).join("[auto-vision-bridge:end]");
}

/** 有真实附件 ID 时，才给模型可执行的原图复核指令。 */
function reviewHint(attachment) {
  const id = typeof attachment?.attachmentId === "string" ? attachment.attachmentId.trim() : "";
  if (!id) return "";
  return `复核提示：转写可能有误；需核对细节、回答追问或转写不明确时，用 attachmentId=${id} 调用 inspect_image，并携带针对性 question 重看原图，不要仅凭转写猜测。`;
}

/** 生成紧跟原图的隐藏转写块。 */
export function transcriptionBlock(attachment, index, text) {
  const hint = reviewHint(attachment);
  return {
    type: "text",
    text: `${BRIDGE_START}\n[附件：${attachmentIdentity(attachment, index)}]\n${sanitizeTranscription(text)}${hint ? `\n${hint}` : ""}\n${BRIDGE_END}`,
  };
}

/** 单图失败也留下明确语义，但绝不伪造识别内容。 */
export function failedTranscriptionBlock(attachment, index, error) {
  return transcriptionBlock(
    attachment,
    index,
    `图片识别失败：${sanitizeTranscription(error?.message ?? error ?? "未知错误")}`,
  );
}

/** 只有完整且独立的标记块才算已桥接。 */
export function isTranscriptionBlock(block) {
  if (block?.type !== "text" || typeof block.text !== "string") return false;
  const start = block.text.indexOf(BRIDGE_START);
  const end = block.text.lastIndexOf(BRIDGE_END);
  return start === 0 && end > start && block.text.slice(end + BRIDGE_END.length).trim() === "";
}

/** 纯函数与浏览器端共用同一清理语义：只删完整标记段。 */
export function stripBridgedText(value) {
  const input = String(value ?? "");
  let output = "";
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf(BRIDGE_START, cursor);
    if (start === -1) {
      output += input.slice(cursor);
      break;
    }
    const end = input.indexOf(BRIDGE_END, start + BRIDGE_START.length);
    // 不完整段不删除，避免网络/DOM 分片时误伤用户文本。
    if (end === -1) {
      output += input.slice(cursor);
      break;
    }
    output += input.slice(cursor, start);
    cursor = end + BRIDGE_END.length;
  }
  return output;
}
