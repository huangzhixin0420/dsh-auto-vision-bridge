import { basename } from "node:path";
import { loadAttachmentById, loadToolImage } from "./image-source.js";
import { storeTranscript } from "./transcript-store.js";
import { admitImage, safeErrorMessage } from "./vision-client.js";

export const INSPECT_IMAGE_DESCRIPTION =
  "Analyze one or more images with the configured vision model. " +
  "User attachments are transcribed automatically; to verify details, answer follow-ups, or clarify an uncertain transcription, " +
  "re-inspect the original with its attachmentId and a targeted question. " +
  "Use path for screenshots, generated images, local absolute/cwd-relative paths, or http(s) URLs. " +
  "When you need to inspect several images, pass ALL of them in ONE call as an array " +
  "(for example attachmentId:[\"sha256:...\",\"sha256:...\"]) instead of calling the tool once per image; " +
  "the images are then recognized concurrently and the result is an array whose entries correspond " +
  "one-to-one with the inputs in order, each carrying its own success or failure. " +
  "A single image may be passed as a plain string.";

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
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
        description: "Local absolute path, cwd-relative path, or an http(s) image URL. Pass an array to inspect several images in one call; they are recognized concurrently and each result corresponds to its input.",
      },
      attachmentId: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
        description: "DSH user attachment ID (for example sha256:...). Pass an array to re-inspect several attachments in one call; they are recognized concurrently and each result corresponds to its input.",
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
      const paths = toList(args?.path);
      const attachmentIds = toList(args?.attachmentId);
      if (paths.length === 0 && attachmentIds.length === 0) {
        throw new Error("inspect_image 的 path 与 attachmentId 至少要提供一个非空参数");
      }

      // 两组输入合成一条任务队列，顺序即输出顺序。
      const tasks = [
        ...paths.map((value) => ({ source: "path", value })),
        ...attachmentIds.map((value) => ({ source: "attachmentId", value })),
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
          const report = typeof client.recognizeWithReport === "function"
            ? await client.recognizeWithReport({ ...image, attachmentRef }, question, exec?.signal)
            : { text: await client.recognize({ ...image, attachmentRef }, question, exec?.signal), provider: "", model: "", durationMs: Date.now() - startedAt, cached: false, attempt: 1 };
          await recordHistory(historyOf(), {
            provider: report.provider,
            model: report.model,
            ok: true,
            error: "",
            durationMs: report.durationMs,
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
