import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInspectImageTool } from "../lib/inspect-image.js";
import { findUserImageAttachment, listSessionImages } from "../lib/image-source.js";
import { VisionClient } from "../lib/vision-client.js";
import { fakeAttachments, fakeLlm, identityDefineTool, testConfig } from "./helpers.js";

const tempDir = fileURLToPath(new URL("./.tmp-multi/", import.meta.url));
const bytes = Buffer.from("fake-png-for-multi-test");

/**
 * 每个文件内容必须不同：视觉客户端按图片内容做缓存，
 * 字节相同的三张图只会发一次请求，测不出并发。
 */
const FILES = ["a.png", "b.png", "c.png"];
const fileBytes = new Map();

before(async () => {
  await mkdir(tempDir, { recursive: true });
  for (const [index, name] of FILES.entries()) {
    // 首字节各不相同：附件 ID 取的是内容哈希的前若干字节，开头不同才能区分。
  const data = Buffer.concat([Buffer.from([0xa0 + index]), Buffer.from(`fake-png-multi-${index}`)]);
    fileBytes.set(name, data);
    await writeFile(join(tempDir, name), data);
  }
});

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function harness(routes = { "c2a/vision": "视觉结果" }, options = {}) {
  const attachments = fakeAttachments({
    readImage(ref) {
      return { ref, data: fileBytes.get("a.png") ?? bytes };
    },
  });
  const llm = fakeLlm(routes, options);
  const ctx = { attachments, llm, get(name) { return this[name]; } };
  const config = testConfig({ pool: [{ provider: "c2a", model: "vision", maxConcurrent: 4 }] });
  const client = new VisionClient(() => config, { ctx, llm });
  return { ctx, llm, client, config, attachments };
}

function toolOf(h) {
  return createInspectImageTool(identityDefineTool, {
    ctx: h.ctx,
    client: h.client,
    getConfig: () => h.config,
  });
}

test("多图输入返回数组，每项与输入一一对应且顺序保持", async () => {
  const h = harness();
  const result = await toolOf(h).execute({
    path: [join(tempDir, "a.png"), join(tempDir, "b.png"), join(tempDir, "c.png")],
  }, { agent: { session: { header: { cwd: tempDir } } } });

  assert.equal(Array.isArray(result), true);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((item) => item.index), [0, 1, 2]);
  assert.deepEqual(result.map((item) => item.ok), [true, true, true]);
  assert.equal(result[0].source, "path");
  assert.equal(result[0].id, join(tempDir, "a.png"));
  assert.equal(result[1].id, join(tempDir, "b.png"));
  assert.equal(result[2].id, join(tempDir, "c.png"));
  for (const item of result) assert.equal(item.text, "视觉结果");
});

test("多图并发识别，全部发出请求且真正并行", async () => {
  // 加上延迟，才能量到同时在途的请求数。
  const h = harness({ "c2a/vision": "视觉结果" }, { delayMs: 30 });
  await toolOf(h).execute({
    path: [join(tempDir, "a.png"), join(tempDir, "b.png"), join(tempDir, "c.png")],
  }, { agent: { session: { header: { cwd: tempDir } } } });
  assert.equal(h.llm.calls.length, 3);
  // 三张图同时在途，证明是并发而不是逐个等待。
  assert.equal(h.llm.peak, 3);
});

test("单张失败只影响它自己，其余照常返回", async () => {
  const h = harness();
  const result = await toolOf(h).execute({
    path: [
      join(tempDir, "a.png"),
      join(tempDir, "missing.png"),
      join(tempDir, "c.png"),
    ],
  }, { agent: { session: { header: { cwd: tempDir } } } });

  assert.equal(result.length, 3);
  assert.deepEqual(result.map((item) => item.ok), [true, false, true]);
  assert.match(result[1].error, /图片不存在/);
  assert.equal(result[0].text, "视觉结果");
  assert.equal(result[2].text, "视觉结果");
  // 失败的那张没发出识别请求。
  assert.equal(h.llm.calls.length, 2);
});

test("path 与 attachmentId 可同时提供，序号按 path 在前、attachmentId 在后", async () => {
  const h = harness();
  const ref = { attachmentId: "sha256:multi", mediaType: "image/png", bytes: bytes.byteLength, width: 1, height: 1, name: "m.png" };
  const session = {
    header: { cwd: tempDir },
    events: [{ type: "user/message", data: { content: [{ type: "image", attachment: ref }] } }],
  };
  const result = await toolOf(h).execute({
    path: [join(tempDir, "a.png"), join(tempDir, "b.png")],
    attachmentId: [ref.attachmentId],
  }, { agent: { session } });

  assert.equal(result.length, 3);
  assert.deepEqual(result.map((item) => item.source), ["path", "path", "attachmentId"]);
  assert.deepEqual(result.map((item) => item.index), [0, 1, 2]);
  assert.deepEqual(result.map((item) => item.ok), [true, true, true]);
  assert.equal(result[2].id, ref.attachmentId);
});

test("单值输入仍返回单元素数组，向后兼容调用方读第一项", async () => {
  const h = harness();
  const result = await toolOf(h).execute({ path: join(tempDir, "a.png") }, {
    agent: { session: { header: { cwd: tempDir } } },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].ok, true);
  assert.equal(result[0].text, "视觉结果");
});

test("识别失败时该项标记失败，其余不受影响", async () => {
  // 多图并发，完成顺序不确定：按图片内容的哈希标识判断哪张失败，不依赖调用次序。
  // fakeAttachments 的 attachmentId 是图片内容哈希的前 12 字节 hex。
  // 第二张图的附件 ID 片段（内容哈希前 12 位 hex）。
  const failedMarker = "a166616b652d";
  const h = harness({
    "c2a/vision": (streamOptions) => {
      const marker = JSON.stringify(streamOptions?.messages ?? "");
      if (marker.includes(failedMarker)) throw new Error("识别炸了");
      return "视觉结果";
    },
  });
  const result = await toolOf(h).execute({
    path: [join(tempDir, "a.png"), join(tempDir, "b.png"), join(tempDir, "c.png")],
  }, { agent: { session: { header: { cwd: tempDir } } } });

  assert.equal(result.length, 3);
  const failed = result.filter((item) => !item.ok);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /识别炸了/);
  assert.equal(result.filter((item) => item.ok).length, 2);
});

test("全部失败时仍返回数组，不整体抛错", async () => {
  const h = harness({
    "c2a/vision": () => { throw new Error("全都炸了"); },
  });
  const result = await toolOf(h).execute({
    path: [join(tempDir, "a.png"), join(tempDir, "b.png")],
  }, { agent: { session: { header: { cwd: tempDir } } } });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((item) => item.ok), [false, false]);
  for (const item of result) assert.match(item.error, /全都炸了/);
});

test("输出渲染成带序号的可读文本", async () => {
  const h = harness();
  const tool = toolOf(h);
  const rendered = tool.output.render(
    { path: "x" },
    [
      { index: 0, source: "path", id: "/a.png", ok: true, text: "第一张" },
      { index: 1, source: "path", id: "/b.png", ok: false, error: "读不出来" },
    ],
  );
  const text = rendered.map((part) => part.text).join("\n");
  assert.match(text, /\[0\] path:\/a\.png/);
  assert.match(text, /第一张/);
  assert.match(text, /\[1\] path:\/b\.png/);
  assert.match(text, /识别失败：读不出来/);
});

test("attachmentId 查找覆盖宿主的全部事件形态", async () => {
  // 与宿主 dsh-api-session-controller 的 imageInEvent 覆盖面保持一致：
  // 只认 user/message + data.content 会让真实会话直接找不到附件。
  const ID = "sha256:" + "a".repeat(64);
  const ref = { attachmentId: ID, mediaType: "image/png", bytes: 1, width: 1, height: 1 };
  const shapes = [
    ["user/message + data.content", { type: "user/message", data: { content: [{ type: "image", attachment: ref }] } }],
    ["user/message + data.message.content", { type: "user/message", data: { message: { content: [{ type: "image", attachment: ref }] } } }],
    ["tool/ptc-dispatch + data.content", { type: "tool/ptc-dispatch", data: { content: [{ type: "image", attachment: ref }] } }],
    ["system/message + data.message.content", { type: "system/message", data: { message: { content: [{ type: "image", attachment: ref }] } } }],
    ["developer/message + data.message.content", { type: "developer/message", data: { message: { content: [{ type: "image", attachment: ref }] } } }],
    ["tool/result + data.message.content", { type: "tool/result", data: { message: { content: [{ type: "image", attachment: ref }] } } }],
    ["team/message/queued + data.message.content", { type: "team/message/queued", data: { message: { content: [{ type: "image", attachment: ref }] } } }],
    ["agent/inbox/spliced + data.inserted", { type: "agent/inbox/spliced", data: { inserted: [{ content: [{ type: "image", attachment: ref }] }] } }],
    ["compaction/summary + data.summary", { type: "compaction/summary", data: { summary: [{ type: "image", attachment: ref }] } }],
    ["compaction/summary + data.rawOutput", { type: "compaction/summary", data: { rawOutput: [{ type: "image", attachment: ref }] } }],
    ["assistant/message + data.message.content", { type: "assistant/message", data: { message: { content: [{ type: "image", attachment: ref }] } } }],
  ];
  for (const [name, event] of shapes) {
    const found = findUserImageAttachment({ events: [event] }, ID);
    assert.ok(found, `应命中：${name}`);
    assert.equal(found.attachmentId, ID);
  }
});

test("会话用 snapshotEvents() 方法暴露事件时也能命中（真实宿主形态）", async () => {
  // 真实会话对象暴露的是 snapshotEvents()，不是 events 属性。
  // 之前只读 .events，拿到空数组，表现为「附件永远找不到」。
  const ID = "sha256:" + "c".repeat(64);
  const ref = { attachmentId: ID, name: "a.png", mediaType: "image/png" };
  const session = {
    snapshotEvents() {
      return [{ type: "user/message", data: { content: [{ type: "image", attachment: ref }] } }];
    },
  };
  const found = findUserImageAttachment(session, ID);
  assert.ok(found, "应通过 snapshotEvents() 命中");
  assert.equal(found.attachmentId, ID);
  assert.equal(found.name, "a.png");
});

test("会话同时有 events 与 snapshotEvents 时优先用 snapshotEvents", async () => {
  const ID = "sha256:" + "d".repeat(64);
  const ref = { attachmentId: ID, name: "b.png" };
  const session = {
    events: [{ type: "user/message", data: { content: [{ type: "text", text: "无关" }] } }],
    snapshotEvents() {
      return [{ type: "user/message", data: { content: [{ type: "image", attachment: ref }] } }];
    },
  };
  const found = findUserImageAttachment(session, ID);
  assert.ok(found, "应命中 snapshotEvents 里的图片");
  assert.equal(found.attachmentId, ID);
});

test("snapshotEvents 抛异常时不炸，退回空结果", async () => {
  const ID = "sha256:" + "e".repeat(64);
  const session = {
    snapshotEvents() { throw new Error("会话已关闭"); },
  };
  assert.equal(findUserImageAttachment(session, ID), undefined);
});

test("找不到附件时能列出会话里真实存在的图片，供模型自我纠正", async () => {
  const ID = "sha256:" + "f".repeat(64);
  const ref = { attachmentId: ID, name: "验证码.png", mediaType: "image/png" };
  const session = {
    snapshotEvents() {
      return [
        { type: "user/message", data: { content: [{ type: "image", attachment: ref }] } },
        { type: "user/message", data: { content: [{ type: "text", text: "hi" }] } },
      ];
    },
  };
  const imgs = listSessionImages(session);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].attachmentId, ID);
  assert.equal(imgs[0].name, "验证码.png");
});

test("attachmentId 查找在事件里无图片时返回 undefined", async () => {
  const ID = "sha256:" + "b".repeat(64);
  const found = findUserImageAttachment({
    events: [
      { type: "user/message", data: { content: [{ type: "text", text: "hi" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "yo" }] } } },
    ],
  }, ID);
  assert.equal(found, undefined);
});

test("工具侧：转写过长时结果项带 file 字段，正文只留摘要", async () => {
  const dumpDir = await mkdtemp(join(tmpdir(), "avb-tool-"));
  try {
    const longText = "识别细节".repeat(300);
    const h = harness({ "c2a/vision": longText });
    const config = { ...h.config, dumpThreshold: 100, summaryLength: 60, dumpDir };
    const tool = createInspectImageTool(identityDefineTool, {
      ctx: h.ctx,
      client: h.client,
      getConfig: () => config,
    });
    const result = await tool.execute({ path: join(tempDir, "a.png") }, {
      agent: { session: { header: { cwd: tempDir } } },
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].ok, true);
    assert.ok(result[0].file, "结果项应带 file 字段");
    assert.ok(result[0].file.startsWith(dumpDir));
    assert.ok(result[0].text.length < longText.length, "正文应是摘要而非全文");
    assert.match(result[0].text, /已存文件：/);
    // 文件里是全文。
    assert.equal(await readFile(result[0].file, "utf8"), longText);
  } finally {
    await rm(dumpDir, { recursive: true, force: true });
  }
});

test("工具侧：转写较短时结果项不带 file 字段", async () => {
  const dumpDir = await mkdtemp(join(tmpdir(), "avb-tool-"));
  try {
    const h = harness({ "c2a/vision": "短结果" });
    const config = { ...h.config, dumpThreshold: 500, dumpDir };
    const tool = createInspectImageTool(identityDefineTool, {
      ctx: h.ctx,
      client: h.client,
      getConfig: () => config,
    });
    const result = await tool.execute({ path: join(tempDir, "a.png") }, {
      agent: { session: { header: { cwd: tempDir } } },
    });
    assert.equal(result[0].ok, true);
    assert.equal(result[0].file, undefined, "短转写不应带 file 字段");
    assert.equal(result[0].text, "短结果");
  } finally {
    await rm(dumpDir, { recursive: true, force: true });
  }
});

test("工具侧：落盘文件名只取 basename，不带整条目录路径", async () => {
  const dumpDir = await mkdtemp(join(tmpdir(), "avb-tool-"));
  try {
    const longText = "识别细节".repeat(300);
    const h = harness({ "c2a/vision": longText });
    const config = { ...h.config, dumpThreshold: 100, summaryLength: 60, dumpDir };
    const tool = createInspectImageTool(identityDefineTool, {
      ctx: h.ctx,
      client: h.client,
      getConfig: () => config,
    });
    const result = await tool.execute({ path: join(tempDir, "a.png") }, {
      agent: { session: { header: { cwd: tempDir } } },
    });
    const name = result[0].file.split("/").pop();
    assert.match(name, /^a\.png-[0-9a-f]{16}\.md$/, "文件名应为 basename + 哈希，不含目录");
    assert.doesNotMatch(name, /tmp|Users|Development/);
  } finally {
    await rm(dumpDir, { recursive: true, force: true });
  }
});

test("工具侧：渲染文本在有全文路径时明确指出", async () => {
  const h = harness();
  const tool = createInspectImageTool(identityDefineTool, {
    ctx: h.ctx,
    client: h.client,
    getConfig: () => h.config,
  });
  const rendered = tool.output.render({ path: "x" }, [
    { index: 0, source: "path", id: "/a.png", ok: true, text: "摘要", file: "/tmp/x/a.md" },
  ]);
  const text = rendered.map((part) => part.text).join("\n");
  assert.match(text, /全文已存文件：\/tmp\/x\/a\.md/);
});
