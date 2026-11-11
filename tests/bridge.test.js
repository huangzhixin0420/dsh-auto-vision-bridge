import test from "node:test";
import assert from "node:assert/strict";
import { attachPreStepBridge, bridgeMessages, noticeSummaryOf, repairLoggedImages, TRANSCRIPTION_SOURCE_KIND } from "../lib/bridge.js";
import { failedTranscriptionBlock, transcriptionBlock } from "../lib/markers.js";
import { attachment, fakeAttachments, imageMessage, testConfig, transcriptionOf, transcriptionPart } from "./helpers.js";

// 2026-11-10 架构变更：转写不再并进原消息的 content，而是**独立成一条
// user/message 事件**（source.kind = "auto-vision-bridge"、form = "notice"）。
// 宿主据此把它渲染成折叠的上下文卡片，用户气泡永远干净；
// 模型侧照常读到（事件即输入）。

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

/** 取一组消息里的转写消息（source.kind 是插件自己的那一种）。 */
function transcriptionMessages(messages) {
  return messages.filter((message) => message?.source?.kind === TRANSCRIPTION_SOURCE_KIND);
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

test("转写成为独立事件：原消息 content 保持干净，模型侧仍能读到文字", async () => {
  const f = fixture();
  const image = { type: "image", attachment: attachment("sha256:one", "界面.png") };
  const userText = { type: "text", text: "请看这张图" };
  const message = imageMessage([userText, image], { id: "message-id" });
  const result = await bridgeMessages([message], f);
  assert.equal(result.changed, true);

  // 原消息 content 原样保留（消息本身是带标记的副本）。
  assert.equal(result.messages[0].content.length, 2, "转写绝不进原消息的 content");
  assert.strictEqual(result.messages[0].content[0], userText);
  assert.strictEqual(result.messages[0].content[1], image);
  // 消息本体带上「已转写」标记，避免历史修复重复识别同一张图。
  assert.ok(result.messages[0].transcribed > 0, "原消息必须带已转写标记");

  // 转写是独立的一条消息，source 让宿主归类为上下文注入而非用户气泡。
  assert.equal(result.messages.length, 2);
  const transcribed = result.messages[1];
  assert.equal(transcribed.source.kind, TRANSCRIPTION_SOURCE_KIND);
  assert.equal(transcribed.source.form, "notice");
  assert.ok(typeof transcribed.source.summary === "string" && transcribed.source.summary.length > 0,
    "notice 的 summary 必须非空，否则前端退化成 opaque");
  assert.equal(transcribed.role, "user");
  assert.ok(typeof transcribed.id === "string" && transcribed.id.length > 0, "消息必须有 id");

  // 附件身份与识别文本完整。
  const text = transcribed.content[0].text;
  assert.match(text, /界面\.png/);
  assert.match(text, /sha256:one/);
  assert.match(text, /识别:sha256:one/);
  assert.equal(transcribed.transcription, undefined, "不再依赖 transcription 字段");
});

test("混合文字与多图：原消息一条，转写每图一条且按原顺序", async () => {
  const f = fixture();
  const a = { type: "image", attachment: attachment("sha256:a", "a.png") };
  const b = { type: "image", attachment: attachment("sha256:b", "b.png") };
  const blocks = [
    { type: "text", text: "开头" }, a,
    { type: "text", text: "中间" }, b,
    { type: "text", text: "结尾" },
  ];
  const result = await bridgeMessages([imageMessage(blocks)], f);
  assert.deepEqual(f.recognitions, ["sha256:a", "sha256:b"]);

  // 原消息一条，content 原样。
  assert.equal(result.messages.length, 3);
  assert.strictEqual(result.messages[0].content[0], blocks[0]);
  assert.strictEqual(result.messages[0].content[1], a);
  assert.strictEqual(result.messages[0].content[2], blocks[2]);
  assert.strictEqual(result.messages[0].content[3], b);
  assert.strictEqual(result.messages[0].content[4], blocks[4]);
  assert.equal(result.messages[0].content.length, 5, "原消息 content 不加任何块");

  // 每张图一条转写，顺序与原图一致。
  const transcribed = transcriptionMessages(result.messages);
  assert.equal(transcribed.length, 2);
  assert.match(transcribed[0].content[0].text, /识别:sha256:a/);
  assert.match(transcribed[1].content[0].text, /识别:sha256:b/);
  assert.match(transcriptionPart(result.messages, 0), /识别:sha256:a/);
  assert.match(transcriptionPart(result.messages, 1), /识别:sha256:b/);
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
  assert.equal(peak, 3);
  assert.deepEqual(order.sort(), ["sha256:a", "sha256:b", "sha256:c"]);

  // 并发识别，但转写仍按原图顺序落位。
  const transcribed = transcriptionMessages(result.messages);
  assert.equal(transcribed.length, 3);
  assert.match(transcribed[0].content[0].text, /识别:sha256:a/);
  assert.match(transcribed[1].content[0].text, /识别:sha256:b/);
  assert.match(transcribed[2].content[0].text, /识别:sha256:c/);
});

test("单图失败注入明确失败说明，其他图片与文字继续", async () => {
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
  const transcribed = transcriptionMessages(result.messages);
  assert.match(transcribed[0].content[0].text, /图片识别失败：视觉 API key 缺失/);
  assert.doesNotMatch(transcribed[0].content[0].text, /成功图片/);
  assert.match(transcribed[1].content[0].text, /成功图片/);
  // 失败只让那一张变成失败说明；原图与用户文字都保留。
  assert.strictEqual(result.messages[0].content[0], bad);
  assert.strictEqual(result.messages[0].content[1], good);
  assert.strictEqual(result.messages[0].content[2], tail);
  assert.equal(result.messages[0].content.length, 3);
  assert.deepEqual(f.recognitions, ["sha256:bad", "sha256:good"]);
});

test("已有旧式标记的图片不重复识别，消息引用不变", async () => {
  const f = fixture();
  const image = { type: "image", attachment: attachment("sha256:done") };
  // v0.4.x 的旧形态：转写块带 START/END 标记并进 content。
  const marked = {
    type: "text",
    text: "\u200b[auto-vision-bridge:start]\n[附件：x]\n旧结果\n\u200b[auto-vision-bridge:end]",
  };
  const messages = [imageMessage([image, marked])];
  const result = await bridgeMessages(messages, f);
  assert.strictEqual(result.messages, messages);
  assert.equal(result.changed, false);
  assert.equal(f.recognitions.length, 0);
});

test("已带 transcription 字段的旧消息不重复识别", async () => {
  const f = fixture();
  const image = { type: "image", attachment: attachment("sha256:done") };
  const messages = [imageMessage([image], { transcription: "旧结果" })];
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
  assert.match(transcriptionOf(result.messages), /识别:sha256:pending/);
});

test("历史修复：原消息 replace 写回，转写另起一条 append 事件", async () => {
  const f = fixture();
  const original = imageMessage([{ type: "image", attachment: attachment("sha256:history") }]);
  const event = { seq: 7, type: "user/message", data: original };
  const appends = [];
  let failAppend = true;
  const session = {
    snapshotEvents: () => [event],
    append(type, data, options) {
      appends.push({ type, data, options });
      if (failAppend) throw new Error("surface 已变化");
    },
  };
  const repaired = new Set();
  await repairLoggedImages(f.ctx, session, f, repaired);
  // replace 抛错 → 整条修复中止（转写那条也不 append），不标完成，下次重扫。
  assert.equal(repaired.has(7), false);
  assert.equal(appends.length, 1);
  assert.deepEqual(f.recognitions, ["sha256:history"]);

  failAppend = false;
  await repairLoggedImages(f.ctx, session, f, repaired);
  assert.equal(repaired.has(7), true);
  // 原消息 replace + 转写 append，各一次。
  assert.equal(appends.length, 3);
  assert.equal(appends[1].type, "user/message");
  assert.deepEqual(appends[1].options, {
    surfaceOp: { op: "replace", startSeq: 7, endSeq: 7 },
    sourceEventSeqs: [7],
  });
  assert.strictEqual(appends[1].data.content[0], original.content[0]);
  assert.equal(appends[1].data.content.length, 1, "写回的原消息 content 保持干净");
  // 原消息带上「已转写」标记，否则下次扫描会重复识别同一张图。
  assert.ok(appends[1].data.transcribed > 0, "写回的原消息必须带已转写标记");

  assert.equal(appends[2].type, "user/message");
  assert.deepEqual(appends[2].options, { surfaceOp: "append" });
  assert.equal(appends[2].data.source.kind, TRANSCRIPTION_SOURCE_KIND);
  assert.match(appends[2].data.content[0].text, /识别:sha256:history/);

  await repairLoggedImages(f.ctx, session, f, repaired);
  assert.equal(appends.length, 3);
});

test("替换事件在二次扫描及重启后屏蔽原图，识图与 append 均只执行一次", async () => {
  const f = fixture();
  const original = imageMessage([{ type: "image", attachment: attachment("sha256:restart") }]);
  const event = { seq: 7, type: "user/message", data: original, surfaceOp: "append" };
  const appends = [];
  const logged = [event];
  const session = {
    // 真实宿主的 snapshotEvents() 返回快照；这里也返回拷贝，
    // 免得测试自己制造出「遍历追着自己 append 的事件跑」的死循环。
    snapshotEvents: () => [...logged],
    append(type, data, options) {
      const appended = { seq: logged.length + 7, type, data, ...options };
      appends.push(appended);
      logged.push(appended);
      return appended;
    },
  };

  const repaired = new Set();
  await repairLoggedImages(f.ctx, session, f, repaired);
  // 原消息 replace + 转写 append，各一次。
  assert.equal(appends.length, 2);
  assert.deepEqual(f.recognitions, ["sha256:restart"]);
  assert.equal(repaired.has(7), true);

  await repairLoggedImages(f.ctx, session, f, repaired);
  assert.equal(appends.length, 2);
  assert.deepEqual(f.recognitions, ["sha256:restart"]);

  await repairLoggedImages(f.ctx, session, f, new Set());
  assert.equal(appends.length, 2);
  assert.deepEqual(f.recognitions, ["sha256:restart"]);
  assert.deepEqual(f.reads, ["sha256:restart"]);
});

test("成功与失败转写均注入可执行的附件复核提示", () => {
  for (const block of [
    transcriptionBlock(attachment("sha256:review"), 0, "可能不完整的转写"),
    failedTranscriptionBlock(attachment("sha256:review"), 0, new Error("读取失败")),
  ]) {
    assert.match(block.text, /转写可能有误/);
    assert.match(block.text, /inspect_image/);
    assert.match(block.text, /attachmentId=sha256:review/);
    assert.match(block.text, /针对性 question/);
    assert.match(block.text, /不要仅凭转写猜测/);
  }
});

test("没有实际 attachmentId 时不注入无法执行的复核提示", () => {
  for (const ref of [{ name: "无ID.png" }, { attachmentId: "  ", name: "空白ID.png" }]) {
    for (const block of [
      transcriptionBlock(ref, 0, "转写"),
      failedTranscriptionBlock(ref, 0, "失败"),
    ]) {
      assert.doesNotMatch(block.text, /复核提示|重看原图|调用 inspect_image/);
    }
  }
});

test("转写全文进上下文：不截断、不落盘", async () => {
  const full = "细节".repeat(400);
  const f = fixture({
    client: {
      async recognize() { return full; },
    },
  });
  const image = { type: "image", attachment: attachment("sha256:long", "long.png") };
  const result = await bridgeMessages([imageMessage([image])], f);
  const transcript = transcriptionOf(result.messages);
  // 全文都在，且不再有「已存文件」那套截断提示。
  assert.ok(transcript.includes(full), "转写全文应原样进上下文");
  assert.doesNotMatch(transcript, /已存文件/);
  assert.doesNotMatch(transcript, /中间已省略/);
});

test("notice 摘要取转写第一行，且按官方上限 120 截断", () => {
  assert.equal(noticeSummaryOf("第一行\n第二行"), "第一行");
  assert.equal(noticeSummaryOf("\n[附件：a.png]\n正文"), "正文");
  // 标记行与附件行不作为摘要。
  assert.equal(
    noticeSummaryOf("\u200b[auto-vision-bridge:start]\n[附件：a.png]\n真正的摘要"),
    "真正的摘要",
  );
  // 空文本退回固定文案（notice 的 summary 必须非空）。
  assert.equal(noticeSummaryOf(""), "图片已转写为文字");
  // 超长按 120 截断。
  const long = "长".repeat(300);
  const summary = noticeSummaryOf(long);
  assert.equal(summary.length, 121, "120 字符 + 省略号");
  assert.ok(summary.endsWith("…"));
});
