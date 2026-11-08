import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 转写落盘与截断。
 *
 * 识图模型的输出可能很长（描述性提示、逐像素讲解），而转写块是塞进主模型
 * 上下文的：太长既烧 token 又挤占上下文。这里把长转写拆成两半：
 *
 * - 摘要：前若干字符，进上下文，够主模型判断内容对不对；
 * - 全文：写进文件，只把路径给主模型，需要细节时它自己去读。
 *
 * 落盘目录默认在系统临时区，不污染用户的代码目录。
 */

/** 落盘根目录。 */
export const DEFAULT_DUMP_DIR = join(tmpdir(), "dsh-auto-vision-bridge");
/** 超过这个字符数才落盘并截断；短的直接全文进上下文。 */
/**
 * 转写落盘阈值（字符）—— 全插件的唯一真源，index.js 的 Config 默认值直接引用它。
 *
 * 一张手机截图的转写实测 2000–3000 字符。阈值定太低（早期是 500）会把几乎每张
 * 截图都截成摘要，模型只剩头尾、中段细节全丢，于是又去调 inspect_image 重看原图，
 * 白白多花一次视觉请求。4000 让绝大多数单图转写全文进上下文。
 */
export const DEFAULT_DUMP_THRESHOLD = 4000;
/** 截断后保留在上下文里的摘要长度。摘要保留头尾，末尾通常是结论。 */
export const DEFAULT_SUMMARY_LENGTH = 2000;

/**
 * 读取落盘阈值；非法值回落默认。
 * 0 是有意义的「不截断」，与「未配置」区分开。
 */
export function dumpThresholdOf(config) {
  const value = Number(config?.dumpThreshold);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DUMP_THRESHOLD;
  return Math.floor(value);
}

/** 读取摘要长度；非法值回落默认。 */
export function summaryLengthOf(config) {
  const value = Number(config?.summaryLength);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_SUMMARY_LENGTH;
  return Math.floor(value);
}

/** 读取落盘目录；非法值回落默认。 */
export function dumpDirOf(config) {
  const value = typeof config?.dumpDir === "string" ? config.dumpDir.trim() : "";
  return value || DEFAULT_DUMP_DIR;
}

/**
 * 给转写内容挑一个稳定的文件名。
 *
 * 用内容的哈希做主键：同一份转写重复落盘会覆盖同一个文件，不会堆出一堆
 * 几乎一样的文件；哈希也保证文件名对内容唯一。
 */
function fileNameFor(text, hint) {
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const safeHint = String(hint ?? "")
    .trim()
    .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return safeHint ? `${safeHint}-${digest}.md` : `transcript-${digest}.md`;
}

/**
 * 把转写内容整理成「摘要 + 全文路径」。
 *
 * @param {string} text - 完整转写内容。
 * @param {object} options
 * @param {object} options.config - 插件配置，决定阈值与目录。
 * @param {string} [options.hint] - 文件名前缀提示，通常是图片名。
 * @returns {Promise<{text: string, file: string|null, totalLength: number, truncated: boolean}>}
 *   text 为进入上下文的摘要；file 为全文路径，未落盘时为 null。
 */
export async function storeTranscript(text, { config, hint } = {}) {
  const content = String(text ?? "");
  const threshold = dumpThresholdOf(config);
  const summaryLength = summaryLengthOf(config);
  const totalLength = content.length;

  // 阈值 0 表示不截断：全文直接进上下文，不产生文件。
  if (threshold === 0 || totalLength <= threshold) {
    return { text: content, file: null, totalLength, truncated: false };
  }

  // 摘要保留开头与结尾：识别结论通常在末尾（模型先复述任务再给答案），
  // 只截开头会正好把唯一码切掉，逼主模型白白再调一次 inspect_image。
  const headLength = Math.ceil(summaryLength / 2);
  const tailLength = summaryLength - headLength;
  const summary = content.length <= summaryLength
    ? content
    : `${content.slice(0, headLength)}\n…（中间已省略，全文见文件）…\n${content.slice(-tailLength)}`;
  const dir = dumpDirOf(config);
  const file = join(dir, fileNameFor(content, hint));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, content, "utf8");
  } catch {
    // 落盘失败不能连累识图结果：退回全文进上下文。
    return { text: content, file: null, totalLength, truncated: false };
  }

  return {
    text: `${summary}\n\n（转写全文过长，共 ${totalLength} 字符，已存文件：${file}；`
      + `若上面摘要没给出你要的信息，直接读这个文件取全文。）`,
    file,
    totalLength,
    truncated: true,
  };
}
