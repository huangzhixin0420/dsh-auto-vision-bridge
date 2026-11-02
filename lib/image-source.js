import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

function asBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data);
}

function assertSize(bytes, config, identity) {
  const limit = Number(config.maxImageBytes);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("maxImageBytes 必须是正数");
  if (bytes.byteLength > limit) {
    throw new Error(`图片过大：${identity}（${bytes.byteLength} 字节，上限 ${limit} 字节）`);
  }
}

/** 扩展名不可信时，用常见文件头补充判断。 */
export function sniffMediaType(bytes) {
  const data = asBuffer(bytes);
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && data.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (data.length >= 6 && data.subarray(0, 6).toString("ascii") === "GIF87a") return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

/** 读取 DSH 原始附件，不导出副本，不改变附件引用。 */
export async function loadAttachment(ctx, attachment, config, signal) {
  if (!attachment) throw new Error("图片块缺少 attachment 引用");
  const attachments = ctx?.attachments ?? ctx?.get?.("attachments");
  if (!attachments || typeof attachments.readImage !== "function") {
    throw new Error("DSH attachments 服务不可用");
  }
  const stored = await attachments.readImage(attachment, signal);
  const data = asBuffer(stored.data);
  assertSize(data, config, attachment.name ?? attachment.attachmentId ?? "附件");
  return {
    data,
    mediaType: stored.ref?.mediaType ?? attachment.mediaType ?? sniffMediaType(data) ?? "image/png",
    attachmentId: attachment.attachmentId,
  };
}

/**
 * readImage 的真实契约要求会话日志中的完整 ImageAttachmentRef，不能只传 ID。
 * 与宿主附件接口一致，只在当前会话已记录的用户图片中解析引用。
 */
export function findUserImageAttachment(session, attachmentId) {
  for (const event of session?.events ?? []) {
    if (event?.type !== "user/message" || !Array.isArray(event.data?.content)) continue;
    for (const block of event.data.content) {
      const ref = block?.type === "image" ? block.attachment : undefined;
      if (ref && String(ref.attachmentId) === attachmentId) return ref;
    }
  }
  return undefined;
}

/** 按 ID 找回当前会话引用，再通过宿主 attachments 服务读取并校验原图。 */
export async function loadAttachmentById(ctx, session, attachmentId, config, signal) {
  const ref = findUserImageAttachment(session, attachmentId);
  if (!ref) throw new Error(`当前会话未找到图片附件：${attachmentId}`);
  return loadAttachment(ctx, ref, config, signal);
}

/** 本地绝对路径或 cwd 相对路径。 */
export async function loadLocalImage(target, cwd, config, signal) {
  const absolute = isAbsolute(target) ? target : resolve(cwd, target);
  let info;
  try { info = await stat(absolute); } catch {
    throw new Error(`图片不存在：${absolute}`);
  }
  if (!info.isFile()) throw new Error(`图片路径不是文件：${absolute}`);
  if (info.size > Number(config.maxImageBytes)) {
    throw new Error(`图片过大：${absolute}（${info.size} 字节，上限 ${config.maxImageBytes} 字节）`);
  }
  const data = await readFile(absolute, { signal });
  assertSize(data, config, absolute);
  const mediaType = MIME_BY_EXT[extname(absolute).toLowerCase()] ?? sniffMediaType(data);
  if (!mediaType) throw new Error(`无法识别图片格式：${absolute}`);
  return { data, mediaType, identity: absolute };
}

/** 下载远程图片后转 data URL；不向图片主机转发视觉 API key。 */
export async function loadRemoteImage(target, config, signal, fetchImpl = fetch) {
  const url = new URL(target);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("inspect_image 仅支持 http(s) 图片 URL");
  const timeoutMs = Number(config.timeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    controller.signal.throwIfAborted();
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`图片下载返回 HTTP ${response.status}：${url}`);
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > Number(config.maxImageBytes)) {
      throw new Error(`远程图片超过大小上限：${url}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    assertSize(data, config, url);
    const mediaType = response.headers?.get?.("content-type")?.split(";", 1)[0].trim()
      || MIME_BY_EXT[extname(url.pathname).toLowerCase()]
      || sniffMediaType(data);
    if (!mediaType?.startsWith("image/")) throw new Error(`远程响应不是图片：${url}`);
    return { data, mediaType, identity: url.href };
  } catch (error) {
    if (timedOut) throw new Error(`图片下载超时（${timeoutMs}ms）：${url}`);
    if (signal?.aborted) throw new Error("图片下载已取消");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function loadToolImage(target, cwd, config, { signal, fetchImpl = fetch } = {}) {
  const input = String(target ?? "").trim();
  if (!input) throw new Error("inspect_image 需要 path 参数");
  if (/^https?:\/\//i.test(input)) return loadRemoteImage(input, config, signal, fetchImpl);
  return loadLocalImage(input, cwd, config, signal);
}
