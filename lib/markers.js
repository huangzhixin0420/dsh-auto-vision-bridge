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

/**
 * 视觉模型爱在开头复述任务。
 *
 * 实测输出常常长这样（原文照抄，未做任何加工）：
 *
 *   The user wants me to accurately identify the image, describe key visual
 *   content, and transcribe the text as completely as possible.
 *
 *   The image is 1800x680px, PNG format. ...
 *
 * 第一段纯属白占预算：它既不是识别结果，还会把真正的结论往后挤 —— 转写超阈值
 * 时摘要只留头尾，这段独白正好把标题一类的中段信息顶出保留区。
 *
 * 只从开头连续剥，遇到第一段不像复述就停；剥完若短于原文的六成，或剥成空串，
 * 一律退回原文 —— 宁可多花 token，也不能把识别结果本身删掉。
 */
const PRELUDE_PATTERNS = [
  /^\s*the\s+user(?:'s)?\s+(?:wants|wanted|wants? me|asked|asks|is asking|requests?|requested|would like|instruction|request)/i,
  /^\s*(?:i\s+(?:need|should|will|must|am going)\s+to)\b/i,
  /^\s*(?:let\s+me\s+(?:look|transcribe|describe|examine|analyze|analyse|start|check|read))\b/i,
  /^\s*(?:用户(?:要求|希望|让我|想要)|我需要|让我(?:先|来)?(?:看看|识别|描述|转写|分析))/,
];

/** 这一段是不是「复述任务」的独白。 */
function isPreludeParagraph(paragraph) {
  const firstLine = paragraph.split("\n").find((line) => line.trim()) ?? "";
  if (!firstLine.trim()) return false;
  // 真正的答案常常以 markdown 标题起头，永远不当独白处理。
  if (/^#{1,6}\s/.test(firstLine.trim())) return false;
  return PRELUDE_PATTERNS.some((pattern) => pattern.test(firstLine));
}

/**
 * 剥掉视觉模型开头的任务复述段落。
 *
 * 纯函数，便于单测；任何不确定的情况都返回原文。
 */
export function stripModelPrelude(text) {
  const original = String(text ?? "");
  if (!original.trim()) return original;
  const paragraphs = original.split(/\n{2,}/);
  let cut = 0;
  // 最多剥三段：再往后就更可能是真正的识别内容了。
  while (cut < paragraphs.length - 1 && cut < 3 && isPreludeParagraph(paragraphs[cut])) cut += 1;
  if (cut === 0) return original;
  const trimmed = paragraphs.slice(cut).join("\n\n").trim();
  // 安全阀：剥完几乎什么都不剩，说明判断错了，退回原文。用绝对长度而不是比例：
  // 比例会冤枉短转写（独白占比天然更高），而这里要防的是「把答案本身删没」。
  if (trimmed.length < 20) return original;
  return trimmed;
}

/** 有真实附件 ID 时，才给模型可执行的原图复核指令。 */
function reviewHint(attachment) {
  const id = typeof attachment?.attachmentId === "string" ? attachment.attachmentId.trim() : "";
  if (!id) return "";
  return `复核提示：转写可能有误；需核对细节、回答追问或转写不明确时，用 attachmentId=${id} 调用 inspect_image，并携带针对性 question 重看原图，不要仅凭转写猜测。这个 id 必须原样整串复制（sha256: + 64 位），截断或凭记忆重写会被拒绝。`;
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
