import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInspectImageTool, INSPECT_IMAGE_DESCRIPTION } from "../lib/inspect-image.js";
import { loadLocalImage } from "../lib/image-source.js";
import { bridgeMessages } from "../lib/bridge.js";
import { VisionClient } from "../lib/vision-client.js";
import { identityDefineTool, testConfig, visionResponse } from "./helpers.js";

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

test("inspect_image 支持本地绝对路径与 cwd 相对路径，并返回视觉文本", async () => {
  const requests = [];
  const client = new VisionClient(() => testConfig(), {
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return visionResponse(requests.length === 1 ? "绝对路径结果" : "相对路径结果");
    },
  });
  const tool = createInspectImageTool(identityDefineTool, { client, getConfig: () => testConfig() });
  assert.equal(tool.name, "inspect_image");
  assert.equal(tool.parameters.path.required, undefined);
  assert.equal(tool.parameters.attachmentId.required, undefined);
  assert.match(INSPECT_IMAGE_DESCRIPTION, /attachmentId/);
  assert.match(INSPECT_IMAGE_DESCRIPTION, /screenshots/);
  assert.doesNotMatch(INSPECT_IMAGE_DESCRIPTION, /user attachments are bridged automatically/i);
  assert.equal(await tool.execute({ path: imagePath }, {}), "绝对路径结果");
  assert.equal(await tool.execute({ path: "tiny.png", question: "只读文字" }, {
    agent: { session: { header: { cwd: tempDir } } },
  }), "相对路径结果");
  assert.equal(requests[0].messages[0].content[0].text, "默认识别提示");
  assert.equal(requests[1].messages[0].content[0].text, "只读文字");
  assert.match(requests[0].messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test("inspect_image 下载 http(s) URL 后发送 data URL，且不向图片主机泄露视觉 key", async () => {
  const calls = [];
  const config = testConfig();
  const client = new VisionClient(() => config, {
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: url.href, options });
      if (options.method === "POST") return visionResponse("URL 识别结果");
      return new Response(bytes, { status: 200, headers: { "Content-Type": "image/png" } });
    },
  });
  const tool = createInspectImageTool(identityDefineTool, {
    client,
    getConfig: () => config,
    fetchImpl: client.fetchImpl,
  });
  assert.equal(await tool.execute({ path: "https://images.example/a.png" }, {}), "URL 识别结果");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://images.example/a.png");
  assert.equal(calls[0].options.headers, undefined);
  const body = JSON.parse(calls[1].options.body);
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(calls[1].options.headers.Authorization, "Bearer test-secret");
});

test("自动桥接与 inspect_image 共用内容缓存，同图同提示不重复请求", async () => {
  let calls = 0;
  const config = testConfig();
  const client = new VisionClient(() => config, {
    fetchImpl: async () => { calls++; return visionResponse("共享"); },
  });
  const image = await loadLocalImage(imagePath, process.cwd(), config);
  assert.equal(await client.recognize(image), "共享"); // 模拟自动桥接入口
  const tool = createInspectImageTool(identityDefineTool, { client, getConfig: () => config });
  assert.equal(await tool.execute({ path: imagePath }, {}), "共享");
  assert.equal(calls, 1);
});

test("本地图片超过 maxImageBytes 时在视觉请求前失败", async () => {
  let calls = 0;
  const config = testConfig({ maxImageBytes: 2 });
  const client = new VisionClient(() => config, {
    fetchImpl: async () => { calls++; return visionResponse("不应调用"); },
  });
  const tool = createInspectImageTool(identityDefineTool, { client, getConfig: () => config });
  await assert.rejects(tool.execute({ path: imagePath }, {}), /图片过大/);
  assert.equal(calls, 0);
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
  const requests = [];
  const attachments = {
    async readImage(actualRef, signal) {
      reads.push({ actualRef, signal });
      return { ref: actualRef, data: bytes };
    },
  };
  const ctx = { attachments, get(name) { return this[name]; } };
  const config = testConfig();
  const client = new VisionClient(() => config, {
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return visionResponse(requests.length === 1 ? "首次转写" : "针对性复核");
    },
  });
  const getConfig = () => config;
  const imageBlock = { type: "image", attachment: ref };
  const [bridged] = await bridgeMessages([{ role: "user", content: [imageBlock] }], {
    ctx, client, getConfig,
  });
  assert.match(bridged.content[1].text, /首次转写/);

  const tool = createInspectImageTool(identityDefineTool, { ctx, client, getConfig });
  assert.equal(await tool.execute({ attachmentId: `  ${ref.attachmentId}  ` }, {
    agent: { session },
  }), "首次转写");
  assert.equal(requests.length, 1);
  assert.equal(reads.length, 2);
  assert.strictEqual(reads[0].actualRef, ref);
  assert.strictEqual(reads[1].actualRef, ref);
  assert.match(requests[0].messages[0].content[1].image_url.url, /^data:image\/png;base64,/);

  assert.equal(await tool.execute({ attachmentId: ref.attachmentId, question: "核对右上角文字" }, {
    agent: { session },
  }), "针对性复核");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages[0].content[0].text, "核对右上角文字");
  assert.strictEqual(reads[2].actualRef, ref);
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
    { path: imagePath, attachmentId: "sha256:review" },
  ]) {
    await assert.rejects(
      tool.execute(args, { agent: { session } }),
      /path 与 attachmentId 必须且只能提供一个非空参数/,
    );
  }
  assert.equal(reads, 0);
  assert.equal(fetches, 0);
  assert.equal(recognitions, 0);
});

test("附件读取失败时原样报错，不伪造识别文本或调用视觉客户端", async () => {
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
  await assert.rejects(
    tool.execute({ attachmentId: "sha256:review" }, { agent: { session } }),
    /附件读取失败测试/,
  );
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
  await assert.rejects(
    tool.execute({ attachmentId: "sha256:other" }, { agent: { session: { events: [] } } }),
    /当前会话未找到图片附件：sha256:other/,
  );
  assert.equal(reads, 0);
});
