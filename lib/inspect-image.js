import { loadAttachmentById, loadToolImage } from "./image-source.js";

export const INSPECT_IMAGE_DESCRIPTION =
  "Analyze an image with the configured OpenAI-compatible vision model. " +
  "User attachments are transcribed automatically; to verify details, answer follow-ups, or clarify an uncertain transcription, " +
  "re-inspect the original with its attachmentId and a targeted question. " +
  "Use path for screenshots, generated images, local absolute/cwd-relative paths, or http(s) URLs. " +
  "Provide exactly one non-empty path or attachmentId.";

/** defineTool 由入口按宿主真实 API 注入，便于在无宿主单元测试中验证完整契约。 */
export function createInspectImageTool(defineTool, { ctx, client, getConfig, fetchImpl = fetch }) {
  return defineTool({
    name: "inspect_image",
    description: INSPECT_IMAGE_DESCRIPTION,
    parameters: {
      path: {
        type: "string",
        description: "Local absolute path, cwd-relative path, or an http(s) image URL; use for screenshots and generated images.",
      },
      attachmentId: {
        type: "string",
        description: "DSH user attachment ID (for example sha256:...); use to re-inspect the original attachment.",
      },
      question: {
        type: "string",
        description: "Optional focused question about the image.",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const path = typeof args?.path === "string" ? args.path.trim() : "";
      const attachmentId = typeof args?.attachmentId === "string" ? args.attachmentId.trim() : "";
      if ((!path && !attachmentId) || (path && attachmentId)) {
        throw new Error("inspect_image 的 path 与 attachmentId 必须且只能提供一个非空参数");
      }
      if (attachmentId) {
        const image = await loadAttachmentById(
          ctx,
          exec?.agent?.session,
          attachmentId,
          getConfig(),
          exec?.signal,
        );
        return client.recognize(image, args?.question, exec?.signal);
      }
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
      const image = await loadToolImage(path, cwd, getConfig(), {
        signal: exec?.signal,
        fetchImpl,
      });
      return client.recognize(image, args.question, exec?.signal);
    },
  });
}
