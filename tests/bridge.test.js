import test from "node:test";
import assert from "node:assert/strict";
import { attachPreStepBridge, bridgeMessages, repairLoggedImages } from "../lib/bridge.js";
import { BRIDGE_END, BRIDGE_START, failedTranscriptionBlock, stripBridgedText, transcriptionBlock } from "../lib/markers.js";
import { attachment, imageMessage, imageOf, testConfig } from "./helpers.js";

function fixture(overrides = {}) {
  const reads = [];
  const recognitions = [];
  const ctx = {
    attachments: {
      async readImage(ref) {
        reads.push(ref.attachmentId);
        return { ref, data: Buffer.from(`bytes:${ref.attachmentId}`) };
      },
    },
    get(name) { return this[name]; },
    logger: { info() {}, warn() {} },
  };
  const client = {
    async recognize(image) {
      recognitions.push(image.attachmentId);
      return `识别:${image.attachmentId}`;
    },
  };
  return { ctx, client, reads, recognitions, getConfig: () => testConfig(), ...overrides };
}

test("纯文本消息保持同引用，且不读取附件、不调用视觉模型", async () => {
  const f = fixture();
  const messages = [imageMessage([{ type: "text", text: "纯文本" }])];
  const result = await bridgeMessages(messages, f);
  assert.strictEqual(result, messages);
  assert.strictEqual(result[0], messages[0]);
  assert.equal(f.reads.length, 0);
  assert.equal(f.recognitions.length, 0);
});

test("文本模型保留原图并紧随隐藏转写，附件身份和识别文本完整", async () => {
  const f = fixture();
  const image = { type: "image", attachment: attachment("sha256:one", "界面.png") };
  const userText = { type: "text", text: "请看这张图" };
  const message = imageMessage([userText, image], { id: "message-id" });
  const [result] = await bridgeMessages([message], f);
  assert.notStrictEqual(result, message);
  assert.equal(result.id, "message-id");
  assert.strictEqual(result.content[0], userText);
  assert.strictEqual(result.content[1], image);
  assert.equal(result.content[2].type, "text");
  assert.match(result.content[2].text, /界面\.png/);
  assert.match(result.content[2].text, /sha256:one/);
  assert.match(result.content[2].text, /识别:sha256:one/);
  assert.equal(stripBridgedText(result.content[2].text), "");
  assert.ok(Object.isFrozen(result));
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
  const [result] = await bridgeMessages([imageMessage(blocks)], f);
  assert.deepEqual(f.recognitions, ["sha256:a", "sha256:b"]);
  assert.strictEqual(result.content[0], blocks[0]);
  assert.strictEqual(result.content[1], a);
  assert.match(result.content[2].text, /识别:sha256:a/);
  assert.strictEqual(result.content[3], blocks[2]);
  assert.strictEqual(result.content[4], b);
  assert.match(result.content[5].text, /识别:sha256:b/);
  assert.strictEqual(result.content[6], blocks[4]);
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
  const [result] = await bridgeMessages([imageMessage([bad, good, tail])], f);
  assert.match(result.content[1].text, /图片识别失败：视觉 API key 缺失/);
  assert.doesNotMatch(result.content[1].text, /成功图片/);
  assert.match(result.content[3].text, /成功图片/);
  assert.strictEqual(result.content[4], tail);
  assert.deepEqual(f.recognitions, ["sha256:bad", "sha256:good"]);
});

test("已有完整标记的图片不重复识别，消息引用不变", async () => {
  const f = fixture();
  const image = { type: "image", attachment: attachment("sha256:done") };
  const marked = transcriptionBlock(image.attachment, 0, "旧结果");
  const messages = [imageMessage([image, marked])];
  const result = await bridgeMessages(messages, f);
  assert.strictEqual(result, messages);
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
    events: [],
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
  assert.match(result.messages[0].content[1].text, /识别:sha256:pending/);
});

test("历史修复 replace 保留 sourceEventSeqs；append 失败不标完成，成功后幂等", async () => {
  const f = fixture();
  const original = imageMessage([{ type: "image", attachment: attachment("sha256:history") }]);
  const event = { seq: 7, type: "user/message", data: original };
  const appends = [];
  let failAppend = true;
  const session = {
    events: [event],
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
  assert.match(appends[1].data.content[1].text, /识别:sha256:history/);

  await repairLoggedImages(f.ctx, session, f, repaired);
  assert.equal(appends.length, 2);
  assert.deepEqual(f.recognitions, ["sha256:history", "sha256:history"]);
});

test("替换事件在二次扫描及重启后屏蔽原图，识图与 append 均只执行一次", async () => {
  const f = fixture();
  const original = imageMessage([{ type: "image", attachment: attachment("sha256:restart") }]);
  const event = { seq: 7, type: "user/message", data: original, surfaceOp: "append" };
  const appends = [];
  const session = {
    events: [event],
    append(type, data, options) {
      assert.deepEqual(options, {
        surfaceOp: { op: "replace", startSeq: 7, endSeq: 7 },
        sourceEventSeqs: [7],
      });
      const appended = { seq: 8, type, data, ...options };
      appends.push(appended);
      session.events.push(appended);
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
