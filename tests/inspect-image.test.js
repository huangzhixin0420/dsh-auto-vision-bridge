import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInspectImageTool, INSPECT_IMAGE_DESCRIPTION } from "../lib/inspect-image.js";
import { loadLocalImage } from "../lib/image-source.js";
import { bridgeMessages } from "../lib/bridge.js";
import { VisionClient } from "../lib/vision-client.js";
import { fakeAttachments, fakeLlm, identityDefineTool, testConfig, transcriptionOf } from "./helpers.js";

const tempDir = fileURLToPath(new URL("./.tmp/", import.meta.url));
const imagePath = join(tempDir, "tiny.png");
const bytes = Buffer.from("fake-png-for-transport-test");

before(async () => {
  await mkdir(tempDir, { recursive: true });
  await writeFile(imagePath, bytes);
});

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** 带 llm 通道与附件服务的测试上下文。 */
function harness(routes = { "c2a/vision": "视觉结果" }, options = {}) {
  const attachments = fakeAttachments({
    readImage(ref) {
      return { ref, data: bytes };
    },
  });
  const llm = fakeLlm(routes, options);
  const ctx = { attachments, llm, get(name) { return this[name]; } };
  const config = testConfig({ pool: [{ provider: "c2a", model: "vision", maxConcurrent: 2 }] });
  const client = new VisionClient(() => config, { ctx, llm });
  return { ctx, llm, client, config, attachments };
}

test("inspect_image 支持本地绝对路径与 cwd 相对路径，并返回视觉文本", async () => {
  const h = harness({ "c2a/vision": "视觉结果" });
  const tool = createInspectImageTool(identityDefineTool, {
    ctx: h.ctx,
    client: h.client,
    getConfig: () => h.config,
  });
  assert.equal(tool.name, "inspect_image");
  assert.equal(tool.parameters.path.required, undefined);
  assert.equal(tool.parameters.attachmentId.required, undefined);
  assert.match(INSPECT_IMAGE_DESCRIPTION, /attachmentId/);
  assert.match(INSPECT_IMAGE_DESCRIPTION, /screenshots/);
  // 描述必须明确指示模型：多图时一次调用传数组，而不是每张图调一次。
  assert.match(INSPECT_IMAGE_DESCRIPTION, /array/i);
  assert.match(INSPECT_IMAGE_DESCRIPTION, /one call/i);
  assert.match(INSPECT_IMAGE_DESCRIPTION, /concurrent/i);
  assert.doesNotMatch(INSPECT_IMAGE_DESCRIPTION, /user attachments are bridged automatically/i);
  const first = await tool.execute({ path: imagePath }, {});
  assert.deepEqual(first, [{ index: 0, source: "path", id: imagePath, ok: true, text: "视觉结果" }]);
  const second = await tool.execute({ path: "tiny.png", question: "只读文字" }, {
    agent: { session: { header: { cwd: tempDir } } },
  });
  assert.equal(second.length, 1);
  assert.equal(second[0].ok, true);
  assert.equal(second[0].text, "视觉结果");
  assert.equal(second[0].source, "path");
  assert.equal(h.llm.calls.length, 2);
  assert.equal(h.llm.calls[0].provider, "c2a");
  assert.equal(h.llm.calls[0].model, "vision");
});

test("图片先经附件服务落成持久引用，再交给 llm 通道", async () => {
  const h = harness();
  const tool = createInspectImageTool(identityDefineTool, {
    ctx: h.ctx,
    client: h.client,
    getConfig: () => h.config,
  });
  await tool.execute({ path: imagePath }, {});
  assert.equal(h.attachments.saved.length, 1);
  assert.ok(h.attachments.saved[0].ref.attachmentId);
  // 落盘的是图片字节本身。
  assert.ok(h.attachments.saved[0].bytes.byteLength > 0);
});

test("inspect_image 下载 http(s) URL，且不向图片主机泄露任何凭据", async () => {
  const fetched = [];
  const h = harness();
  const ctx = {
    attachments: h.attachments,
    llm: h.llm,
    get(name) { return this[name]; },
  };
  const tool = createInspectImageTool(identityDefineTool, {
    ctx,
    client: h.client,
    getConfig: () => h.config,
    fetchImpl: async (url, options = {}) => {
      fetched.push({ url: url.href, options });
      return new Response(bytes, { status: 200, headers: { "Content-Type": "image/png" } });
    },
  });
  const result = await tool.execute({ path: "https://images.example/a.png" }, {});
  assert.equal(result.length, 1);
  assert.equal(result[0].ok, true);
  assert.equal(result[0].text, "视觉结果");
  assert.equal(result[0].id, "https://images.example/a.png");
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, "https://images.example/a.png");
  assert.equal(fetched[0].options.headers, undefined);
  assert.equal(h.llm.calls.length, 1);
});

test("自动桥接与 inspect_image 共用内容缓存，同图同提示不重复请求", async () => {
  const h = harness({ "c2a/vision": "共享" });
  const image = await loadLocalImage(imagePath, process.cwd(), h.config);
  const { admitImage } = await import("../lib/vision-client.js");
  const attachmentRef = await admitImage(h.ctx, image);
  assert.equal(await h.client.recognize({ ...image, attachmentRef }), "共享");
  const tool = createInspectImageTool(identityDefineTool, {
    ctx: h.ctx,
    client: h.client,
    getConfig: () => h.config,
  });
  const cached = await tool.execute({ path: imagePath }, {});
  assert.equal(cached[0].text, "共享");
  assert.equal(h.llm.calls.length, 1);
});

test("本地图片超过 maxImageBytes 时在视觉请求前失败", async () => {
  const h = harness();
  const config = testConfig({ maxImageBytes: 2, pool: [{ provider: "c2a", model: "vision" }] });
  const client = new VisionClient(() => config, { ctx: h.ctx, llm: h.llm });
  const tool = createInspectImageTool(identityDefineTool, {
    ctx: h.ctx,
    client,
    getConfig: () => config,
  });
  const result = await tool.execute({ path: imagePath }, {});
  assert.equal(result.length, 1);
  assert.equal(result[0].ok, false);
  assert.match(result[0].error, /图片过大/);
  assert.equal(h.llm.calls.length, 0);
});

function attachmentFixture() {
  const ref = {
    attachmentId: "sha256:review",
    mediaType: "image/png",
    bytes: bytes.byteLength,
    width: 1,
    height: 1,
    name: "review.png",
  };
  const session = {
    header: { cwd: tempDir },
    events: [{
      type: "user/message",
      data: { content: [{ type: "image", attachment: ref }] },
    }],
  };
  return { ref, session };
}

test("inspect_image 按 attachmentId 经宿主服务读原图，并与自动桥接复用视觉客户端缓存", async () => {
  const { ref, session } = attachmentFixture();
  const reads = [];
  const attachments = fakeAttachments({
    readImage(actualRef, signal) {
      reads.push({ actualRef, signal });
      return { ref: actualRef, data: bytes };
    },
  });
  const llm = fakeLlm({ "c2a/vision": "首次转写" });
  const ctx = { attachments, llm, get(name) { return this[name]; } };
  const config = testConfig({ pool: [{ provider: "c2a", model: "vision" }] });
  const client = new VisionClient(() => config, { ctx, llm });
  const getConfig = () => config;
  const imageBlock = { type: "image", attachment: ref };
  const bridged = await bridgeMessages([{ role: "user", content: [imageBlock] }], {
    ctx, client, getConfig,
  });
  assert.match(transcriptionOf(bridged.messages[0]), /首次转写/);

  const tool = createInspectImageTool(identityDefineTool, { ctx, client, getConfig });
  const result = await tool.execute({ attachmentId: `  ${ref.attachmentId}  ` }, {
    agent: { session },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].ok, true);
  assert.equal(result[0].text, "首次转写");
  assert.equal(result[0].source, "attachmentId");
  assert.equal(result[0].id, ref.attachmentId);
  assert.equal(llm.calls.length, 1);
  assert.equal(reads.length, 2);
  assert.strictEqual(reads[0].actualRef, ref);
  assert.strictEqual(reads[1].actualRef, ref);
});

test("inspect_image 的 path 与 attachmentId 同时提供或都缺失时，在读取和网络前报中文错误", async () => {
  let reads = 0;
  let fetches = 0;
  let recognitions = 0;
  const config = testConfig();
  const ctx = {
    attachments: { async readImage() { reads++; throw new Error("不应读取"); } },
  };
  const client = {
    async recognize() { recognitions++; return "不应识别"; },
  };
  const tool = createInspectImageTool(identityDefineTool, {
    ctx,
    client,
    getConfig: () => config,
    fetchImpl: async () => { fetches++; throw new Error("不应联网"); },
  });
  const { session } = attachmentFixture();
  for (const args of [
    {},
    { path: "  ", attachmentId: "" },
    { path: [], attachmentId: [] },
  ]) {
    await assert.rejects(
      tool.execute(args, { agent: { session } }),
      /path 与 attachmentId 至少要提供一个非空参数/,
    );
  }
  assert.equal(reads, 0);
  assert.equal(fetches, 0);
  assert.equal(recognitions, 0);
});

test("附件读取失败时该条目失败，其余继续，不伪造识别文本", async () => {
  const { session } = attachmentFixture();
  let recognitions = 0;
  const ctx = {
    attachments: { async readImage() { throw new Error("附件读取失败测试"); } },
  };
  const tool = createInspectImageTool(identityDefineTool, {
    ctx,
    client: { async recognize() { recognitions++; return "伪造文本"; } },
    getConfig: () => testConfig(),
  });
  const result = await tool.execute({ attachmentId: "sha256:review" }, { agent: { session } });
  assert.equal(result.length, 1);
  assert.equal(result[0].ok, false);
  assert.match(result[0].error, /附件读取失败测试/);
  assert.equal(recognitions, 0);
});

test("attachmentId 未在当前会话用户图片中登记时拒绝读取", async () => {
  let reads = 0;
  const ctx = { attachments: { async readImage() { reads++; } } };
  const tool = createInspectImageTool(identityDefineTool, {
    ctx,
    client: { async recognize() { throw new Error("不应识别"); } },
    getConfig: () => testConfig(),
  });
  const result = await tool.execute(
    { attachmentId: "sha256:other" },
    { agent: { session: { events: [] } } },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].ok, false);
  assert.match(result[0].error, /当前会话未找到图片附件：sha256:other/);
  assert.equal(reads, 0);
});
