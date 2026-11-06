import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachPreStepBridge, bridgeMessages, repairLoggedImages } from "../lib/bridge.js";
import { BRIDGE_END, BRIDGE_START, failedTranscriptionBlock, stripBridgedText, transcriptionBlock } from "../lib/markers.js";
import { attachment, fakeAttachments, imageMessage, imageOf, testConfig, transcriptionOf, transcriptionPart } from "./helpers.js";

function fixture(overrides = {}) {
  const reads = [];
  const recognitions = [];
  const admitted = [];
  const attachments = fakeAttachments({
    readImage(ref) {
      reads.push(ref.attachmentId);
      return { ref, data: Buffer.from(`bytes:${ref.attachmentId}`) };
    },
  });
  const ctx = {
    attachments,
    get(name) { return this[name]; },
    logger: { info() {}, warn() {} },
  };
  const client = {
    async recognize(image) {
      recognitions.push(image.attachmentId);
      admitted.push(image.attachmentRef);
      return `识别:${image.attachmentId}`;
    },
  };
  return { ctx, client, reads, recognitions, admitted, getConfig: () => testConfig(), ...overrides };
}

test("纯文本消息保持同引用，且不读取附件、不调用视觉模型", async () => {
  const f = fixture();
  const messages = [imageMessage([{ type: "text", text: "纯文本" }])];
  const result = await bridgeMessages(messages, f);
  assert.strictEqual(result.messages, messages);
  assert.strictEqual(result.messages[0], messages[0]);
  assert.equal(result.changed, false);
  assert.equal(f.reads.length, 0);
  assert.equal(f.recognitions.length, 0);
});

test("文本模型保留原图并另存转写：content 保持干净，附件身份和识别文本完整", async () => {
  const f = fixture();
  const image = { type: "image", attachment: attachment("sha256:one", "界面.png") };
  const userText = { type: "text", text: "请看这张图" };
  const message = imageMessage([userText, image], { id: "message-id" });
  const result = await bridgeMessages([message], f);
  const bridged = result.messages[0];
  assert.notStrictEqual(bridged, message);
  assert.equal(result.changed, true);
  assert.equal(bridged.id, "message-id");
  // content 原样保留：只有用户自己的文字与原图，转写不进 content。
  assert.strictEqual(bridged.content[0], userText);
  assert.strictEqual(bridged.content[1], image);
  assert.equal(bridged.content.length, 2);
  const transcription = transcriptionOf(bridged);
  assert.match(transcription, /界面\.png/);
  assert.match(transcription, /sha256:one/);
  assert.match(transcription, /识别:sha256:one/);
  assert.equal(stripBridgedText(transcription), "");
  assert.ok(Object.isFrozen(bridged));
});

test("混合文字与多图保持原顺序，每张图各调用一次", async () => {
  const f = fixture();
  const a = { type: "image", attachment: attachment("sha256:a", "a.png") };
  const b = { type: "image", attachment: attachment("sha256:b", "b.png") };
  const blocks = [
    { type: "text", text: "开头" }, a,
    { type: "text", text: "中间" }, b,
    { type: "text", text: "结尾" },
  ];
  const result = await bridgeMessages([imageMessage(blocks)], f);
  const bridged = result.messages[0];
  assert.deepEqual(f.recognitions, ["sha256:a", "sha256:b"]);
  // content 保持原样，块序不变。
  assert.strictEqual(bridged.content[0], blocks[0]);
  assert.strictEqual(bridged.content[1], a);
  assert.strictEqual(bridged.content[2], blocks[2]);
  assert.strictEqual(bridged.content[3], b);
  assert.strictEqual(bridged.content[4], blocks[4]);
  // 转写按图的原顺序分段保存。
  assert.match(transcriptionPart(bridged, 0), /识别:sha256:a/);
  assert.match(transcriptionPart(bridged, 1), /识别:sha256:b/);
});

test("多图并发识别：请求重叠发起，结果仍按原顺序落位", async () => {
  const f = fixture();
  let active = 0;
  let peak = 0;
  const order = [];
  f.client.recognize = async (image) => {
    active++;
    peak = Math.max(peak, active);
    order.push(image.attachmentId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return `识别:${image.attachmentId}`;
  };
  const blocks = [
    { type: "image", attachment: attachment("sha256:a", "a.png") },
    { type: "image", attachment: attachment("sha256:b", "b.png") },
    { type: "image", attachment: attachment("sha256:c", "c.png") },
  ];
  const result = await bridgeMessages([imageMessage(blocks)], f);
  const bridged = result.messages[0];
  assert.equal(peak, 3);
  assert.deepEqual(order.sort(), ["sha256:a", "sha256:b", "sha256:c"]);
  assert.strictEqual(bridged.content[0], blocks[0]);
  assert.strictEqual(bridged.content[1], blocks[1]);
  assert.strictEqual(bridged.content[2], blocks[2]);
  assert.match(transcriptionPart(bridged, 0), /识别:sha256:a/);
  assert.match(transcriptionPart(bridged, 1), /识别:sha256:b/);
  assert.match(transcriptionPart(bridged, 2), /识别:sha256:c/);
});

test("单图失败注入明确失败标记，其他图片与文字继续", async () => {
  const f = fixture();
  f.client.recognize = async (image) => {
    f.recognitions.push(image.attachmentId);
    if (image.attachmentId === "sha256:bad") throw new Error("视觉 API key 缺失");
    return "成功图片";
  };
  const bad = { type: "image", attachment: attachment("sha256:bad") };
  const good = { type: "image", attachment: attachment("sha256:good") };
  const tail = { type: "text", text: "用户文字仍在" };
  const result = await bridgeMessages([imageMessage([bad, good, tail])], f);
  const bridged = result.messages[0];
  assert.match(transcriptionPart(bridged, 0), /图片识别失败：视觉 API key 缺失/);
  assert.doesNotMatch(transcriptionPart(bridged, 0), /成功图片/);
  assert.match(transcriptionPart(bridged, 1), /成功图片/);
  // content 原样：失败也不影响用户文字。
  assert.strictEqual(bridged.content[0], bad);
  assert.strictEqual(bridged.content[1], good);
  assert.strictEqual(bridged.content[2], tail);
  assert.deepEqual(f.recognitions, ["sha256:bad", "sha256:good"]);
});

test("已有完整标记的图片不重复识别，消息引用不变", async () => {
  const f = fixture();
  const image = { type: "image", attachment: attachment("sha256:done") };
  const marked = transcriptionBlock(image.attachment, 0, "旧结果");
  const messages = [imageMessage([image, marked])];
  const result = await bridgeMessages(messages, f);
  assert.strictEqual(result.messages, messages);
  assert.equal(result.changed, false);
  assert.equal(f.recognitions.length, 0);
});

function preStepFixture(modalities, pending, lastUsed) {
  const f = fixture();
  const calls = [];
  const llm = {
    async resolveModelInfo(provider, model) {
      calls.push({ provider, model });
      return { inputModalities: modalities };
    },
  };
  const session = {
    id: "s1",
    snapshotEvents: () => [],
    requestHeader: () => ({ config: { provider: "old", model: "old-model" } }),
    append() { throw new Error("不应修复历史"); },
  };
  const agent = { session, options: { provider: "option", model: "option-model" } };
  let listener;
  ctxAssign(f.ctx, llm, pending, lastUsed);
  f.ctx.on = (_event, fn) => { listener = fn; return () => {}; };
  attachPreStepBridge(f.ctx, f);
  return { ...f, llm, calls, agent, listener };
}

function ctxAssign(ctx, llm, pending, lastUsed) {
  ctx.llm = llm;
  ctx.sessionProjections = {
    stateOf(_session, key) {
      assert.equal(key, "modelSelection");
      return { pending: pending ?? null, lastUsed: lastUsed ?? null };
    },
  };
}

test("原生视觉路由的新含图消息原样直发，视觉 API 与历史修复均为零调用", async () => {
  const f = preStepFixture(["text", "image"]);
  const decision = { kind: "enter", messages: [imageMessage([{ type: "image", attachment: attachment() }])] };
  const result = await f.listener({ agent: f.agent }, async () => decision);
  assert.strictEqual(result, decision);
  assert.strictEqual(result.messages, decision.messages);
  assert.equal(f.recognitions.length, 0);
  assert.equal(f.reads.length, 0);
});

test("文本路由的无图路径保持原引用，识图与历史写回均为零调用", async () => {
  const f = preStepFixture(["text"]);
  const decision = { kind: "enter", messages: [imageMessage([{ type: "text", text: "无图" }])] };
  const result = await f.listener({ agent: f.agent }, async () => decision);
  assert.strictEqual(result, decision);
  assert.strictEqual(result.messages, decision.messages);
  assert.equal(f.recognitions.length, 0);
  assert.equal(f.reads.length, 0);
});

test("模型选择 pending 优先于 lastUsed 与旧 requestHeader，切换首步走新文本路由", async () => {
  const f = preStepFixture(
    ["text"],
    { provider: "new-provider", model: "new-text" },
    { provider: "old-provider", model: "old-vision" },
  );
  const decision = { kind: "enter", messages: [imageMessage([{ type: "image", attachment: attachment("sha256:pending") }])] };
  const result = await f.listener({ agent: f.agent }, async () => decision);
  assert.deepEqual(f.calls, [{ provider: "new-provider", model: "new-text" }]);
  assert.match(transcriptionOf(result.messages[0]), /识别:sha256:pending/);
});

test("历史修复 replace 保留 sourceEventSeqs；append 失败不标完成，成功后幂等", async () => {
  const f = fixture();
  const original = imageMessage([{ type: "image", attachment: attachment("sha256:history") }]);
  const event = { seq: 7, type: "user/message", data: original };
  const appends = [];
  let failAppend = true;
  const session = {
    snapshotEvents: () => [event],
    append(type, data, options) {
      assert.deepEqual(options, {
        surfaceOp: { op: "replace", startSeq: 7, endSeq: 7 },
        sourceEventSeqs: [7],
      });
      appends.push({ type, data, options });
      if (failAppend) throw new Error("surface 已变化");
    },
  };
  const repaired = new Set();
  await repairLoggedImages(f.ctx, session, f, repaired);
  assert.equal(repaired.has(7), false);
  assert.equal(appends.length, 1);
  assert.deepEqual(f.recognitions, ["sha256:history"]);

  failAppend = false;
  await repairLoggedImages(f.ctx, session, f, repaired);
  assert.equal(repaired.has(7), true);
  assert.equal(appends.length, 2);
  assert.equal(appends[1].type, "user/message");
  assert.deepEqual(appends[1].options, {
    surfaceOp: { op: "replace", startSeq: 7, endSeq: 7 },
    sourceEventSeqs: [7],
  });
  assert.strictEqual(appends[1].data.content[0], original.content[0]);
  // 写回的内容保持干净：原图在、转写不进 content。
  assert.equal(appends[1].data.content.length, 1);
  assert.match(transcriptionOf(appends[1].data), /识别:sha256:history/);

  await repairLoggedImages(f.ctx, session, f, repaired);
  assert.equal(appends.length, 2);
  assert.deepEqual(f.recognitions, ["sha256:history", "sha256:history"]);
});

test("替换事件在二次扫描及重启后屏蔽原图，识图与 append 均只执行一次", async () => {
  const f = fixture();
  const original = imageMessage([{ type: "image", attachment: attachment("sha256:restart") }]);
  const event = { seq: 7, type: "user/message", data: original, surfaceOp: "append" };
  const appends = [];
  const logged = [event];
  const session = {
    snapshotEvents: () => logged,
    append(type, data, options) {
      assert.deepEqual(options, {
        surfaceOp: { op: "replace", startSeq: 7, endSeq: 7 },
        sourceEventSeqs: [7],
      });
      const appended = { seq: 8, type, data, ...options };
      appends.push(appended);
      logged.push(appended);
      return appended;
    },
  };

  const repaired = new Set();
  await repairLoggedImages(f.ctx, session, f, repaired);
  assert.equal(appends.length, 1);
  assert.deepEqual(f.recognitions, ["sha256:restart"]);
  assert.equal(repaired.has(7), true);

  await repairLoggedImages(f.ctx, session, f, repaired);
  assert.equal(appends.length, 1);
  assert.deepEqual(f.recognitions, ["sha256:restart"]);

  await repairLoggedImages(f.ctx, session, f, new Set());
  assert.equal(appends.length, 1);
  assert.deepEqual(f.recognitions, ["sha256:restart"]);
  assert.deepEqual(f.reads, ["sha256:restart"]);
});

test("完整标记段有精确起止边界", () => {
  const block = transcriptionBlock(attachment("sha256:mark"), 0, "abc");
  assert.ok(block.text.startsWith(BRIDGE_START));
  assert.ok(block.text.endsWith(BRIDGE_END));
});

test("成功与失败转写均注入可执行的附件复核提示，且完整隐藏", () => {
  for (const block of [
    transcriptionBlock(attachment("sha256:review"), 0, "可能不完整的转写"),
    failedTranscriptionBlock(attachment("sha256:review"), 0, new Error("读取失败")),
  ]) {
    assert.match(block.text, /转写可能有误/);
    assert.match(block.text, /inspect_image/);
    assert.match(block.text, /attachmentId=sha256:review/);
    assert.match(block.text, /针对性 question/);
    assert.match(block.text, /不要仅凭转写猜测/);
    assert.ok(block.text.indexOf("复核提示") > block.text.indexOf(BRIDGE_START));
    assert.ok(block.text.indexOf("复核提示") < block.text.lastIndexOf(BRIDGE_END));
    assert.equal(stripBridgedText(`前文${block.text}后文`), "前文后文");
  }
});

test("没有实际 attachmentId 时不注入无法执行的复核提示", () => {
  for (const ref of [{ name: "无ID.png" }, { attachmentId: "  ", name: "空白ID.png" }]) {
    for (const block of [
      transcriptionBlock(ref, 0, "转写"),
      failedTranscriptionBlock(ref, 0, "失败"),
    ]) {
      assert.doesNotMatch(block.text, /复核提示|重看原图|调用 inspect_image/);
      assert.equal(stripBridgedText(block.text), "");
    }
  }
});


test("转写过长时：转写块只留摘要，全文写进文件并带上路径", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avb-bridge-"));
  try {
    const longText = "细节".repeat(400);
    const f = fixture({
      client: {
        async recognize() { return longText; },
      },
      getConfig: () => ({ ...testConfig(), dumpThreshold: 100, summaryLength: 50, dumpDir: dir }),
    });
    const image = { type: "image", attachment: attachment("sha256:long", "long.png") };
    const result = await bridgeMessages([imageMessage([image])], f);
    const transcript = transcriptionOf(result.messages[0]);
    assert.ok(transcript.length > 0, "应有转写");
    assert.ok(transcript.length < longText.length + 200, "转写不应塞进全文");
    assert.match(transcript, /转写全文过长，共 \d+ 字符，已存文件：/);
    const file = transcript.match(/已存文件：(.+?)；/)?.[1];
    assert.ok(file, "应能解析出文件路径");
    assert.ok(file.startsWith(dir));
    assert.equal(await readFile(file, "utf8"), longText);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("转写较短时：全文直接进转写，不落盘", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avb-bridge-"));
  try {
    const f = fixture({
      getConfig: () => ({ ...testConfig(), dumpThreshold: 500, dumpDir: dir }),
    });
    const image = { type: "image", attachment: attachment("sha256:short", "short.png") };
    const result = await bridgeMessages([imageMessage([image])], f);
    const transcript = transcriptionOf(result.messages[0]);
    assert.match(transcript, /识别:sha256:short/);
    assert.doesNotMatch(transcript, /已存文件/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
