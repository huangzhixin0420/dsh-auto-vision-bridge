import test from "node:test";
import assert from "node:assert/strict";
import { attachModelSideInjection } from "../lib/bridge.js";
import { injectTranscriptions, transcriptionOf } from "../lib/transcription.js";

/** 收集 llm/stream 钩子，便于直接调用。 */
function streamFixture() {
  const handlers = [];
  const ctx = {
    on(name, handler) {
      handlers.push({ name, handler });
      return () => {};
    },
  };
  attachModelSideInjection(ctx);
  const handler = handlers.find((item) => item.name === "llm/stream")?.handler;
  assert.ok(handler, "应注册 llm/stream 钩子");
  return handler;
}

/** 记录 next 收到的参数。 */
function runHook(handler, options) {
  const seen = [];
  const result = handler(options, (next) => {
    seen.push(next);
    return next;
  });
  return { result, seen };
}

test("模型侧注入：带转写的消息被追加 text 块，原始消息不变", () => {
  const message = {
    id: "m1",
    role: "user",
    content: [{ type: "text", text: "用户文字" }],
    source: { kind: "user" },
    transcription: "转写正文",
  };
  const injected = injectTranscriptions([message]);
  assert.notStrictEqual(injected[0], message);
  assert.equal(injected[0].content.length, 2);
  assert.deepEqual(injected[0].content[1], { type: "text", text: "转写正文" });
  // 原消息不变：会话事件里的 content 保持干净。
  assert.equal(message.content.length, 1);
});

test("模型侧注入：没有转写的消息原样返回，不产生新数组", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "无图" }], source: { kind: "user" } },
    { role: "assistant", content: [{ type: "text", text: "回复" }] },
  ];
  const injected = injectTranscriptions(messages);
  assert.strictEqual(injected, messages);
  assert.strictEqual(injected[0], messages[0]);
});

test("模型侧注入：只改带转写的那条消息", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "无图" }], source: { kind: "user" } },
    { role: "user", content: [{ type: "text", text: "看图" }], source: { kind: "user" }, transcription: "转写正文" },
  ];
  const injected = injectTranscriptions(messages);
  assert.strictEqual(injected[0], messages[0]);
  assert.notStrictEqual(injected[1], messages[1]);
  assert.equal(injected[1].content.length, 2);
});

test("llm/stream 钩子：把转写注入模型侧消息，前端读到的 content 不变", () => {
  const handler = streamFixture();
  const message = {
    id: "m1",
    role: "user",
    content: [{ type: "text", text: "看这张图" }],
    source: { kind: "user" },
    transcription: "转写正文",
  };
  const options = { provider: "c2a", model: "paid", sessionId: "s1", messages: [message] };
  let forwarded;
  handler(options, (next) => {
    forwarded = next;
    return next;
  });
  assert.ok(forwarded, "应调用 next");
  assert.notStrictEqual(forwarded.messages, options.messages);
  assert.equal(forwarded.messages[0].content.length, 2);
  assert.match(forwarded.messages[0].content[1].text, /转写正文/);
  // 前端读的是会话事件里的 content，仍是干净的。
  assert.equal(message.content.length, 1);
});

test("llm/stream 钩子：没有 sessionId 的调用不注入（标题生成等旁路）", () => {
  const handler = streamFixture();
  const message = {
    role: "user",
    content: [{ type: "text", text: "看图" }],
    source: { kind: "user" },
    transcription: "转写正文",
  };
  const options = { provider: "c2a", model: "paid", messages: [message] };
  let forwarded;
  handler(options, (next) => {
    forwarded = next;
    return next;
  });
  assert.strictEqual(forwarded, undefined, "旁路调用不应改写 options");
});

test("llm/stream 钩子：没有转写时原样透传", () => {
  const handler = streamFixture();
  const message = { role: "user", content: [{ type: "text", text: "无图" }], source: { kind: "user" } };
  const options = { provider: "c2a", model: "paid", sessionId: "s1", messages: [message] };
  let forwarded;
  handler(options, (next) => {
    forwarded = next;
    return next;
  });
  assert.strictEqual(forwarded, undefined, "无可注入内容时不应重建 options");
});

test("transcriptionOf 只认非空字符串", () => {
  assert.equal(transcriptionOf({ transcription: "内容" }), "内容");
  assert.equal(transcriptionOf({ transcription: "" }), null);
  assert.equal(transcriptionOf({}), null);
  assert.equal(transcriptionOf(null), null);
});
