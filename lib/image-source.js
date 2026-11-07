import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";

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
 * 在一组内容块里找出匹配附件 ID 的图片引用。
 */
function imageRefIn(content, attachmentId) {
  if (!Array.isArray(content)) return undefined;
  const wanted = attachmentHex(attachmentId);
  if (!wanted) return undefined;
  for (const block of content) {
    const ref = block?.type === "image" ? block.attachment : undefined;
    // 按 hex 归一化后比较：完整 ID 的大小写、`sha256:` 前缀、首尾空白都容忍，
    // 但仍然是全等匹配 —— 前缀永远不等于完整 ID。
    if (ref && attachmentHex(ref.attachmentId) === wanted) return ref;
  }
  return undefined;
}

/**
 * 取出附件 ID 的 hex 部分，用于比较。
 *
 * 模型抄 64 位 hex 时经常走样：只抄前 8 位、大小写不一致、漏掉 `sha256:` 前缀。
 * 这里统一去掉前缀、转小写、去空白，让上述走样都能对齐。
 *
 * @param {unknown} value - 附件 ID。
 * @returns {string} 小写 hex 串；没有内容时为空串。
 */
function attachmentHex(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text.startsWith("sha256:") ? text.slice("sha256:".length) : text;
}

/**
 * 收集会话里出现过的所有图片引用（原始 ref，保留 bytes 等字段）。
 *
 * 与 {@link findUserImageAttachment} 的差别：这里不按事件类型分别取字段，
 * 而是把所有可能承载图片的位置都扫一遍，返回去重后的原始引用数组。
 * 前缀匹配需要「会话里到底有哪些图」的全貌，用这个。
 *
 * @param {object} session - 会话。
 * @returns {object[]} 原始图片引用数组。
 */
export function collectImageRefs(session) {
  const events = sessionEvents(session);
  const found = new Map();
  const visit = (content) => {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const ref = block?.type === "image" ? block.attachment : undefined;
      const id = ref?.attachmentId;
      if (!id) continue;
      const key = String(id);
      if (!found.has(key)) found.set(key, ref);
    }
  };
  for (const event of events) {
    const data = event?.data;
    if (!data || typeof data !== "object") continue;
    visit(data.content);
    visit(data.message?.content);
    visit(data.summary);
    visit(data.rawOutput);
    if (Array.isArray(data.inserted)) {
      for (const message of data.inserted) visit(message?.content);
    }
  }
  return [...found.values()];
}

/** 完整附件 ID 的 hex 长度：sha256 的 64 位十六进制。 */
export const FULL_HEX_LENGTH = 64;

/**
 * 判断模型给的 ID 是不是「完整」的附件 ID。
 *
 * 2026-11-07 起只接受完整 ID：不猜前缀。理由见 {@link truncatedIdMessage}。
 *
 * @param {unknown} value - 模型给的附件 ID。
 * @returns {boolean} 是否为完整 ID。
 */
export function isCompleteAttachmentId(value) {
  return new RegExp(`^[0-9a-f]{${FULL_HEX_LENGTH}}$`).test(attachmentHex(value));
}

/**
 * 模型抄短了附件 ID 时的纠正提示。
 *
 * 为什么不猜前缀（2026-11-07 决定）：模型把 64 位抄成前 8 位时，前缀补全看起来
 * 很友好，但它无法区分「抄的是这张图的正确前缀」和「抄错了、而这个错误前缀恰好
 * 唯一命中另一张图」—— 后者会静默返回无关图片的识别结果，模型和用户都发现不了。
 * 实测全局附件库里桶内最多 5 个对象，4 位前缀误中概率约 2%，不是可以忽略的量级。
 *
 * 所以改成硬失败：报错里把当前会话所有图片的完整 ID 原样列出，让模型照着重抄。
 * 抄错是可恢复的（重抄即可），找错图是不可恢复的（拿错内容）。
 *
 * @param {string} given - 模型给的 ID。
 * @param {object[]} available - 当前会话里的图片引用。
 * @returns {string} 可直接抛给模型的错误信息。
 */
export function truncatedIdMessage(given, available) {
  const hex = attachmentHex(given);
  const head = hex
    ? `附件 ID 不完整：你传的是 ${hex.length} 位（${given}），必须传完整的 sha256: + ${FULL_HEX_LENGTH} 位十六进制。`
    : `附件 ID 为空，必须传完整的 sha256: + ${FULL_HEX_LENGTH} 位十六进制。`;
  return head + availableHint(available) + " 请从附件标记里逐字复制完整 ID 后重试。";
}

/** 「当前会话有哪些图」的提示片段；没有图时说明这一点。 */
function availableHint(available) {
  if (!available.length) return "当前会话里没有任何图片附件。";
  return `当前会话可用的图片附件：${available
    .map((item) => `${item.name ?? "未命名"}（${item.attachmentId}）`)
    .join("；")}。`;
}

/**
 * 取出会话事件列表。
 *
 * 会话对象暴露的是 snapshotEvents() 方法（与宿主 dsh-api-session-controller
 * 读取附件的方式一致），不是 events 属性。读错取法会拿到空数组，表现为
 * 「附件永远找不到」。这里同时兼容两种形态，便于测试用普通对象构造会话。
 */
export function sessionEvents(session) {
  if (!session) return [];
  if (typeof session.snapshotEvents === "function") {
    try {
      return session.snapshotEvents() ?? [];
    } catch {
      return [];
    }
  }
  return Array.isArray(session.events) ? session.events : [];
}

/**
 * readImage 的真实契约要求会话日志中的完整 ImageAttachmentRef，不能只传 ID。
 *
 * 事件形态与宿主 dsh-api-session-controller 的 imageInEvent 保持一致：图片块
 * 不只出现在 user/message.data.content——system/developer/tool-result 用
 * data.message.content，inbox 拼接用 data.inserted[].content，压缩摘要用
 * data.summary / data.rawOutput，助手消息还可能来自流式 chunk。只认一种
 * 形态会在真实会话里直接找不到附件。
 */
export function findUserImageAttachment(session, attachmentId) {
  const events = sessionEvents(session);
  for (const event of events) {
    const data = event?.data;
    if (!data || typeof data !== "object") continue;
    let found;
    switch (event.type) {
      case "user/message":
      case "tool/ptc-dispatch":
        // user/message 的内容既可能在 data.content，也可能在 data.message.content。
        found = imageRefIn(data.content, attachmentId) ?? imageRefIn(data.message?.content, attachmentId);
        break;
      case "system/message":
      case "developer/message":
      case "tool/result":
      case "team/message/queued":
        found = imageRefIn(data.message?.content, attachmentId);
        break;
      case "agent/inbox/spliced":
        if (Array.isArray(data.inserted)) {
          for (const message of data.inserted) {
            if (!message || typeof message !== "object") continue;
            found = imageRefIn(message.content, attachmentId);
            if (found) break;
          }
        }
        break;
      case "compaction/summary":
        found = imageRefIn(data.summary, attachmentId) ?? imageRefIn(data.rawOutput, attachmentId);
        break;
      case "assistant/message":
        found = imageRefIn(data.message?.content, attachmentId);
        break;
      default:
        found = undefined;
    }
    if (found) return found;
  }
  return undefined;
}

/**
 * 列出会话里出现过的所有图片引用。
 *
 * 找不到附件时把可选项告诉模型，它能自己纠正 ID 重试，不必把错误原样丢回去。
 */
export function listSessionImages(session) {
  const events = sessionEvents(session);
  const found = new Map();
  const visit = (content) => {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const ref = block?.type === "image" ? block.attachment : undefined;
      const id = ref?.attachmentId;
      if (!id) continue;
      if (!found.has(String(id))) {
        found.set(String(id), { attachmentId: String(id), name: ref.name, mediaType: ref.mediaType });
      }
    }
  };
  for (const event of events) {
    const data = event?.data;
    if (!data || typeof data !== "object") continue;
    visit(data.content);
    visit(data.message?.content);
    visit(data.summary);
    visit(data.rawOutput);
    if (Array.isArray(data.inserted)) {
      for (const message of data.inserted) visit(message?.content);
    }
  }
  return [...found.values()];
}

/**
 * 解析出可读取事件的会话对象。
 *
 * 工具执行时拿到的是 agent.session；它若不含事件，则回退到宿主 sessions
 * 服务里挂载的同一会话记录（官方读附件走的就是这条路径）。
 */
function resolveSession(ctx, session) {
  if (session && sessionEvents(session).length > 0) return session;
  const id = session?.id ?? session?.header?.id;
  if (!id) return session;
  try {
    const sessions = ctx?.sessions ?? ctx?.get?.("sessions");
    const record = sessions?.get?.(id);
    if (record && sessionEvents(record).length > 0) return record;
  } catch {
    // 取不到就按原样继续，错误信息里会列出可用附件。
  }
  return session;
}

/**
 * 从 DSH 的全局附件对象库读图。
 *
 * 宿主把附件按 sha256 落在 `~/.dsh/attachments/v1/objects/<前 2 位>/<完整 hex>`，
 * 这个库跨会话、跨重启都在。只查会话的话，换个会话或重启之后就再也看不到旧图
 * （实测：会话 A 传的图，在会话 B 里连完整 ID 都查不到）。
 *
 * 只认图片（按文件头判定）、只接受十六进制 ID（防路径穿越），并沿用 maxImageBytes 上限。
 *
 * @returns {Promise<{data: Buffer, mediaType: string, attachmentId: string}|undefined>}
 *   读不到返回 undefined。只按完整 ID 精确命中，不做前缀猜测。
 */
async function readGlobalAttachment(attachmentId, config) {
  const hex = attachmentHex(attachmentId);
  // 只认完整 ID：前缀会让「抄错但唯一命中」静默拿到无关图片，见 truncatedIdMessage。
  if (!new RegExp(`^[0-9a-f]{${FULL_HEX_LENGTH}}$`).test(hex)) return undefined;
  const dir = join(homedir(), ".dsh", "attachments", "v1", "objects", hex.slice(0, 2));
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  if (!names.includes(hex)) return undefined;
  let data;
  try {
    data = asBuffer(await readFile(join(dir, hex)));
  } catch {
    return undefined;
  }
  const mediaType = sniffMediaType(data);
  if (!mediaType) return undefined;
  assertSize(data, config, `附件 ${hex.slice(0, 8)}`);
  return { data, mediaType, attachmentId: `sha256:${hex}` };
}

/** 按 ID 找回当前会话引用，再通过宿主 attachments 服务读取并校验原图。 */
export async function loadAttachmentById(ctx, session, attachmentId, config, signal) {
  const resolved = resolveSession(ctx, session);
  const ref = findUserImageAttachment(resolved, attachmentId);
  // 抄短了就直接拒绝：前缀补全会静默拿错图，恢复成本远高于让模型重抄一次。
  if (!isCompleteAttachmentId(attachmentId)) {
    throw new Error(truncatedIdMessage(attachmentId, listSessionImages(resolved)));
  }
  if (!ref) {
    // 会话里没有：这张图可能是别的会话上传的，或重启前那个会话留下的。
    // 宿主的全局对象库还留着它，按完整 ID 回落到那里读。
    const global = await readGlobalAttachment(attachmentId, config);
    if (global) {
      ctx?.logger?.info?.(
        `[auto-vision-bridge] 附件不在当前会话，已从全局对象库补读：${attachmentId} → ${global.attachmentId}`,
      );
      return global;
    }
    // 完整 ID 也对不上：把会话里真实存在的图片列出来，模型据此自行纠正。
    throw new Error(
      `当前会话未找到图片附件：${attachmentId}。${availableHint(listSessionImages(resolved))}`,
    );
  }
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
