import test from "node:test";
import assert from "node:assert/strict";
import { admitImage, VisionClient } from "../lib/vision-client.js";
import { fakeAttachments, fakeLlm, imageOf, testConfig } from "./helpers.js";

function poolEntry(overrides = {}) {
  return {
    provider: "c2a",
    model: "vision",
    maxConcurrent: 1,
    priority: 1,
    ...overrides,
  };
}

function harness(routes, options = {}) {
  const attachments = fakeAttachments();
  const llm = fakeLlm(routes, options);
  const ctx = { attachments, llm, get(name) { return this[name]; } };
  return { ctx, llm, attachments };
}

test("连续失败到阈值后，该模型被熔断不再派发", async () => {
  let calls = 0;
  const h = harness({
    "c2a/vision": () => {
      calls += 1;
      throw new Error("HTTP 429 too many requests");
    },
  });
  const config = testConfig({
    retries: 0,
    retryDelayMs: 0,
    failureThreshold: 2,
    cooldownMs: 60000,
    pool: [poolEntry()],
  });
  const client = new VisionClient(() => config, { ctx: h.ctx, llm: h.llm });
  const image = imageOf("x");
  const attachmentRef = await admitImage(h.ctx, image);

  // 第一次失败：还没到阈值。
  await assert.rejects(client.recognize({ ...image, attachmentRef }), /429/);
  assert.equal(calls, 1);
  // 第二次失败：达到阈值，熔断。
  await assert.rejects(client.recognize({ ...image, attachmentRef }), /429/);
  assert.equal(calls, 2);
  assert.equal(client.breaker.isTripped("c2avision"), true);

  // 第三次：熔断中，直接失败且不发请求。
  await assert.rejects(client.recognize({ ...image, attachmentRef }), /熔断/);
  assert.equal(calls, 2);
});

test("熔断后重试改派到其他模型", async () => {
  const h = harness({
    "c2a/vision": () => { throw new Error("HTTP 429 too many requests"); },
    "c2a/other": "备用模型识别结果",
  });
  const config = testConfig({
    retries: 1,
    retryDelayMs: 0,
    failureThreshold: 1,
    cooldownMs: 60000,
    pool: [poolEntry({ model: "vision" }), poolEntry({ model: "other", priority: 2 })],
  });
  const client = new VisionClient(() => config, { ctx: h.ctx, llm: h.llm });
  const image = imageOf("x");
  const attachmentRef = await admitImage(h.ctx, image);

  // 首选模型失败后，重试改派到备用模型并成功。
  assert.equal(await client.recognize({ ...image, attachmentRef }), "备用模型识别结果");
  assert.equal(client.breaker.isTripped("c2avision"), true);
  assert.equal(client.breaker.isTripped("c2aother"), false);
});

test("不可恢复的失败立刻熔断，不必等阈值", async () => {
  const h = harness({
    "c2a/vision": () => { throw new Error("unknown model: gpt-4o"); },
  });
  const config = testConfig({
    retries: 0,
    retryDelayMs: 0,
    failureThreshold: 5,
    cooldownMs: 60000,
    pool: [poolEntry()],
  });
  const client = new VisionClient(() => config, { ctx: h.ctx, llm: h.llm });
  const image = imageOf("x");
  const attachmentRef = await admitImage(h.ctx, image);

  await assert.rejects(client.recognize({ ...image, attachmentRef }), /unknown model/);
  // 阈值是 5，但不可恢复的失败一次就熔断。
  assert.equal(client.breaker.isTripped("c2avision"), true);
});

test("模型恢复成功后清零计数", async () => {
  let calls = 0;
  const h = harness({
    "c2a/vision": () => {
      calls += 1;
      if (calls === 1) throw new Error("HTTP 429 too many requests");
      return "恢复成功";
    },
  });
  const config = testConfig({
    retries: 0,
    retryDelayMs: 0,
    failureThreshold: 1,
    cooldownMs: 60000,
    pool: [poolEntry()],
  });
  const client = new VisionClient(() => config, { ctx: h.ctx, llm: h.llm });
  const image = imageOf("x");
  const attachmentRef = await admitImage(h.ctx, image);

  await assert.rejects(client.recognize({ ...image, attachmentRef }), /429/);
  assert.equal(client.breaker.isTripped("c2avision"), true);

  // 手动解除冷却后重试成功，计数归零。
  client.breaker.stateOf("c2avision").cooldownUntil = 0;
  assert.equal(await client.recognize({ ...image, attachmentRef }), "恢复成功");
  assert.equal(client.breaker.isTripped("c2avision"), false);
  assert.equal(client.breaker.stateOf("c2avision").failures, 0);
});

test("阈值设为 0 时不熔断，失败照常重试", async () => {
  const h = harness({
    "c2a/vision": () => { throw new Error("HTTP 429 too many requests"); },
  });
  const config = testConfig({
    retries: 1,
    retryDelayMs: 0,
    failureThreshold: 0,
    cooldownMs: 60000,
    pool: [poolEntry()],
  });
  const client = new VisionClient(() => config, { ctx: h.ctx, llm: h.llm });
  const image = imageOf("x");
  const attachmentRef = await admitImage(h.ctx, image);

  await assert.rejects(client.recognize({ ...image, attachmentRef }), /429/);
  assert.equal(client.breaker.isTripped("c2avision"), false);
  assert.equal(h.llm.calls.length, 2);
});

test("全池熔断时报出明确原因，而不是无限排队", async () => {
  const h = harness({
    "c2a/vision": () => { throw new Error("HTTP 429 too many requests"); },
  });
  const config = testConfig({
    retries: 0,
    retryDelayMs: 0,
    failureThreshold: 1,
    cooldownMs: 60000,
    pool: [poolEntry()],
  });
  const client = new VisionClient(() => config, { ctx: h.ctx, llm: h.llm });
  const image = imageOf("x");
  const attachmentRef = await admitImage(h.ctx, image);

  await assert.rejects(client.recognize({ ...image, attachmentRef }), /429/);
  assert.equal(client.breaker.isTripped("c2avision"), true);
  // 再次请求：全池熔断，立刻给出可读错误。
  await assert.rejects(client.recognize({ ...image, attachmentRef }), /熔断冷却/);
  assert.equal(h.llm.calls.length, 1);
});

test("真实 c2a 额度耗尽错误会触发熔断并改派", async () => {
  // c2a 配额耗尽时的真实错误文案（实测取自 127.0.0.1:8788 的 502 响应）。
  const quotaError = 'all candidates failed: skipped: 额度耗尽（窗口未知）· 预计 08:00 恢复（依据：retry-after）';
  const h = harness({
    "c2a/vision": () => { throw new Error(quotaError); },
    "c2a/other": "备用模型识别结果",
  });
  const config = testConfig({
    retries: 1,
    retryDelayMs: 0,
    failureThreshold: 1,
    cooldownMs: 60000,
    pool: [poolEntry({ model: "vision" }), poolEntry({ model: "other", priority: 2 })],
  });
  const client = new VisionClient(() => config, { ctx: h.ctx, llm: h.llm });
  const image = imageOf("x");
  const attachmentRef = await admitImage(h.ctx, image);

  // 首选模型真实配额耗尽 → 熔断 → 重试改派备用模型并成功。
  assert.equal(await client.recognize({ ...image, attachmentRef }), "备用模型识别结果");
  assert.equal(client.breaker.isTripped("c2avision"), true);
  assert.equal(client.breaker.isTripped("c2aother"), false);
});
