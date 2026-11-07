import { basename } from "node:path";
import { loadAttachmentById, loadToolImage } from "./image-source.js";
import { storeTranscript } from "./transcript-store.js";
import { admitImage, safeErrorMessage } from "./vision-client.js";

export const INSPECT_IMAGE_DESCRIPTION =
  "Analyze one or more images with the configured vision model. " +
  "User attachments are transcribed automatically; to verify details, answer follow-ups, or clarify an uncertain transcription, " +
  "re-inspect the original with its attachmentId and a targeted question. " +
  "Use path for a single screenshot, generated image, local absolute/cwd-relative path, or http(s) URL. " +
  "When you need to inspect several images, put ALL of them in paths (attachmentIds for several attachments) in ONE call " +
  "instead of calling the tool once per image; the images are then recognized concurrently and the result is an array whose " +
  "entries correspond one-to-one with the inputs in order, each carrying its own success or failure.";

/** 把 string | string[] 归一成非空字符串数组。 */
function toList(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/** defineTool 由入口按宿主真实 API 注入，便于在无宿主单元测试中验证完整契约。 */
/**
 * 记一条识图历史。
 *
 * 历史是旁路：写失败只记日志，绝不让它把工具调用带崩。
 */
async function recordHistory(history, record, logger) {
  if (!history) return;
  try {
    await history.record(record, logger);
  } catch (error) {
    logger?.warn?.(`[auto-vision-bridge] 识图历史记账失败：${error?.message ?? error}`);
  }
}

export function createInspectImageTool(defineTool, { ctx, client, getConfig, fetchImpl = fetch, history = null }) {
  // history 可能是函数（账本异步就绪时传活对象引用），每次调用时解析一次。
  const historyOf = () => (typeof history === "function" ? history() : history);
  return defineTool({
    name: "inspect_image",
    description: INSPECT_IMAGE_DESCRIPTION,
    parameters: {
      path: {
        type: "string",
        description: "One local absolute path, cwd-relative path, or http(s) image URL. For several images use paths instead.",
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Several images in one call (they are recognized concurrently; results come back in the same order). Use this instead of calling the tool once per image.",
      },
      attachmentId: {
        type: "string",
        description: "One DSH user attachment ID (for example sha256:...). For several attachments use attachmentIds instead.",
      },
      attachmentIds: {
        type: "array",
        items: { type: "string" },
        description: "Several DSH user attachment IDs in one call (recognized concurrently, results in the same order).",
      },
      items: {
        type: "array",
        description: "Several images each with its OWN question, in one call. Use this instead of paths/attachmentIds when the questions differ per image. Entries are recognized concurrently and returned in the same order.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: {
              type: "string",
              description: "Local absolute path, cwd-relative path, or http(s) image URL.",
            },
            attachmentId: {
              type: "string",
              description: "DSH user attachment ID (for example sha256:...).",
            },
            question: {
              type: "string",
              description: "Question for THIS image only; falls back to the top-level question when omitted.",
            },
          },
        },
      },
      question: {
        type: "string",
        description: "Optional focused question about the image(s).",
      },
    },
    output: {
      schema: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            index: { type: "number" },
            source: { type: "string" },
            id: { type: "string" },
            ok: { type: "boolean" },
            text: { type: "string" },
            file: { type: "string" },
            error: { type: "string" },
          },
        },
      },
      render: (_args, value) => {
        const items = Array.isArray(value) ? value : [];
        return [{
          type: "text",
          text: items.map((item) => {
            const head = `[${item?.index ?? "?"}] ${item?.source ?? ""}:${item?.id ?? ""}`;
            if (!item?.ok) return `${head}\n识别失败：${item?.error ?? "未知错误"}`;
            const fileNote = item?.file ? `\n（全文已存文件：${item.file}）` : "";
            return `${head}\n${item.text ?? ""}${fileNote}`;
          }).join("\n\n"),
        }];
      },
    },
    async execute(args, exec) {
      // 单数与复数参数并存：path/paths、attachmentId/attachmentIds 各自可单独使用。
      // 早先用 oneOf 表达「字符串或数组」，实测传数组进来会被整体当成一个字符串
      // 路径（报错里能看到 "[\"/a.png\",\"/b.png\"]" 被当作文件名），所以拆成两组明确参数。
      const paths = [...toList(args?.path), ...toList(args?.paths)];
      const attachmentIds = [...toList(args?.attachmentId), ...toList(args?.attachmentIds)];
      // items 是「图 + 它自己的问题」的成对输入：多图各问各的时用它，
      // 平行数组（paths[0] 配 questions[0]）容易错位，所以绑定成对象。
      const itemTasks = (Array.isArray(args?.items) ? args.items : [])
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const path = typeof item.path === "string" ? item.path.trim() : "";
          const id = typeof item.attachmentId === "string" ? item.attachmentId.trim() : "";
          const source = path ? "path" : id ? "attachmentId" : "";
          if (!source) return null;
          const own = typeof item.question === "string" && item.question.trim() ? item.question.trim() : undefined;
          return { source, value: source === "path" ? path : id, question: own };
        })
        .filter(Boolean);
      if (paths.length === 0 && attachmentIds.length === 0 && itemTasks.length === 0) {
        throw new Error("inspect_image 的 path/paths、attachmentId/attachmentIds 与 items 至少要提供一个非空参数");
      }

      // 三组输入合成一条任务队列，顺序即输出顺序。
      const tasks = [
        ...paths.map((value) => ({ source: "path", value })),
        ...attachmentIds.map((value) => ({ source: "attachmentId", value })),
        ...itemTasks,
      ];

      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
      const question = typeof args?.question === "string" && args.question.trim() ? args.question : undefined;

      // 多图并发识别；单张失败只影响它自己，其余照常返回。
      const results = await Promise.all(tasks.map(async (task, index) => {
        const base = { index, source: task.source, id: task.value };
        const startedAt = Date.now();
        const imageName = task.source === "path" ? basename(task.value) : "";
        try {
          const image = task.source === "attachmentId"
            ? await loadAttachmentById(ctx, exec?.agent?.session, task.value, getConfig(), exec?.signal)
            : await loadToolImage(task.value, cwd, getConfig(), { signal: exec?.signal, fetchImpl });
          // llm 通道只认持久引用，图片要先经附件服务落盘。
          const attachmentRef = await admitImage(ctx, image);
          // 优先用带回报的接口（能拿到实际派发的模型与耗时）；旧客户端
          // 只有 recognize 时退回，记账里就没有模型信息。
          // 任务自带的 question 优先，没带才用顶层那个。
          const taskQuestion = task.question ?? question;
          const report = typeof client.recognizeWithReport === "function"
            ? await client.recognizeWithReport({ ...image, attachmentRef }, taskQuestion, exec?.signal)
            : { text: await client.recognize({ ...image, attachmentRef }, taskQuestion, exec?.signal), provider: "", model: "", durationMs: Date.now() - startedAt, cached: false, attempt: 1 };
          await recordHistory(historyOf(), {
            provider: report.provider,
            model: report.model,
            ok: true,
            error: "",
            durationMs: report.durationMs,
            waitMs: Number.isFinite(report.waitMs) ? report.waitMs : 0,
            cached: report.cached,
            attachmentId: String(image.attachmentId ?? ""),
            imageName,
            source: "inspect",
            sessionId: String(exec?.agent?.session?.id ?? ""),
            attempt: report.attempt,
          }, ctx?.logger);
          // 过长的转写：摘要进结果，全文写文件，只把路径带回去。
          const stored = await storeTranscript(report.text, {
            config: getConfig(),
            // 文件名提示只取 basename：完整路径会变成一长串目录名。
            hint: task.source === "path" ? basename(task.value) : undefined,
          });
          return {
            ...base,
            ok: true,
            text: stored.text,
            ...(stored.file ? { file: stored.file } : {}),
          };
        } catch (error) {
          const message = safeErrorMessage(error, getConfig());
          // 失败也记账「试过哪个模型」，路由由 VisionClient 挂在 error 上。
          const route = (error && typeof error === "object" && error.dshVisionRoute) || {};
          await recordHistory(historyOf(), {
            provider: route.provider ?? "",
            model: route.model ?? "",
            ok: false,
            error: message,
            durationMs: Date.now() - startedAt,
            cached: false,
            attachmentId: String(base?.id ?? ""),
            imageName,
            source: "inspect",
            sessionId: String(exec?.agent?.session?.id ?? ""),
            attempt: route.attempt ?? 1,
          }, ctx?.logger);
          return { ...base, ok: false, error: message };
        }
      }));

      return results;
    },
  });
}
