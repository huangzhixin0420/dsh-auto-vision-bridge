import test from "node:test";
import assert from "node:assert/strict";
import { PoolScheduler, resolvePool } from "../lib/pool.js";
import { admitImage, retryLimitOf, VisionClient } from "../lib/vision-client.js";
import { fakeAttachments, fakeLlm, imageOf, testConfig } from "./helpers.js";

function poolEntry(overrides = {}) {
  return {
    provider: "c2a",
    model: "vision",
    maxConcurrent: 1,
    ...overrides,
  };
}

function harness(routes, options = {}) {
  const attachments = fakeAttachments();
  const llm = fakeLlm(routes, options);
  const ctx = { attachments, llm, get(name) { return this[name]; } };
  return { ctx, llm, attachments };
}

test("重试次数读取：非法值按 0 处理", () => {
  assert.equal(retryLimitOf(testConfig({ retries: 3 })), 3);
  assert.equal(retryLimitOf(testConfig({ retries: 0 })), 0);
  assert.equal(retryLimitOf(testConfig({ retries: -1 })), 0);
  assert.equal(retryLimitOf(testConfig({ retries: "x" })), 0);
});

test("识图失败按配置重试，达到最大次数后才失败", async () => {
  const h = harness({ "c2a/vision": "" });
  const config = testConfig({ retries: 2, retryDelayMs: 0, pool: [poolEntry()] });
  const client = new VisionClient(() => config, { ctx: h.ctx, llm: h.llm });
  const image = imageOf("x");
  const attachmentRef = await admitImage(h.ctx, image);
  await assert.rejects(client.recognize({ ...image, attachmentRef }), /空识别文本/);
  assert.equal(h.llm.calls.length, 3);
});

test("重试期间可恢复的失败最终成功", async () => {
  let attempt = 0;
  const h = harness({
    "c2a/vision": () => {
      attempt += 1;
      if (attempt < 3) throw new Error("端点抖动");
      return "恢复成功";
    },
  });
  const config = testConfig({ retries: 3, retryDelayMs: 0, pool: [poolEntry()] });
  const client = new VisionClient(() => config, { ctx: h.ctx, llm: h.llm });
  const image = imageOf("x");
  const attachmentRef = await admitImage(h.ctx, image);
  assert.equal(await client.recognize({ ...image, attachmentRef }), "恢复成功");
  assert.equal(h.llm.calls.length, 3);
});

test("池为空时报错，不发任何请求", async () => {
  const h = harness({});
  const config = testConfig({ pool: [] });
  const client = new VisionClient(() => config, { ctx: h.ctx, llm: h.llm });
  const image = imageOf("x");
  const attachmentRef = await admitImage(h.ctx, image);
  await assert.rejects(client.recognize({ ...image, attachmentRef }), /模型池为空/);
  assert.equal(h.llm.calls.length, 0);
});

test("并发请求被派发到不同端点", async () => {
  const h = harness({
    "c2a/vision": "甲",
    "c2a/other": "乙",
  }, { delayMs: 30 });
  const config = testConfig({
    pool: [poolEntry({ model: "vision" }), poolEntry({ model: "other" })],
  });
  const client = new VisionClient(() => config, { ctx: h.ctx, llm: h.llm });
  const image = imageOf("x");
  const attachmentRef = await admitImage(h.ctx, image);
  const results = await Promise.all([
    client.recognize({ ...image, attachmentRef, attachmentId: "a" }),
    client.recognize({ ...image, attachmentRef, attachmentId: "b" }),
  ]);
  assert.deepEqual(results.sort(), ["乙", "甲"]);
  assert.equal(new Set(h.llm.calls.map((c) => c.model)).size, 2);
});

test("单条目并发上限为 1 时请求串行", async () => {
  const h = harness({ "c2a/vision": "甲" }, { delayMs: 25 });
  const config = testConfig({ pool: [poolEntry({ maxConcurrent: 1 })] });
  const client = new VisionClient(() => config, { ctx: h.ctx, llm: h.llm });
  const image = imageOf("x");
  const attachmentRef = await admitImage(h.ctx, image);
  await Promise.all([
    client.recognize({ ...image, attachmentRef, attachmentId: "a" }),
    client.recognize({ ...image, attachmentRef, attachmentId: "b" }),
  ]);
  assert.equal(h.llm.peak, 1);
});

test("池指纹变化会让缓存失效", () => {
  const client = new VisionClient(() => testConfig(), { llm: { prepareCall() {} } });
  const image = imageOf("x");
  const first = client.cacheKey(image, undefined, testConfig({ pool: [poolEntry({ model: "vision" })] }));
  const second = client.cacheKey(image, undefined, testConfig({ pool: [poolEntry({ model: "other" })] }));
  assert.notEqual(first, second);
  const same = client.cacheKey(image, undefined, testConfig({ pool: [poolEntry({ model: "vision" })] }));
  assert.equal(first, same);
});

test("池条目缺 provider 或 model 时不参与派发", async () => {
  const h = harness({ "c2a/vision": "甲" });
  const config = testConfig({
    pool: [poolEntry({ provider: "" }), poolEntry({ model: "vision" })],
  });
  const client = new VisionClient(() => config, { ctx: h.ctx, llm: h.llm });
  const image = imageOf("x");
  const attachmentRef = await admitImage(h.ctx, image);
  assert.equal(await client.recognize({ ...image, attachmentRef }), "甲");
  assert.equal(h.llm.calls.length, 1);
  assert.equal(h.llm.calls[0].provider, "c2a");
});

test("调度器按池配置限制每条目并发", async () => {
  const pool = resolvePool({
    ...testConfig(),
    pool: [poolEntry({ model: "a", maxConcurrent: 2 }), poolEntry({ model: "b", maxConcurrent: 1 })],
  });
  const scheduler = new PoolScheduler(() => pool);
  const first = await scheduler.acquire();
  const second = await scheduler.acquire();
  assert.equal(scheduler.usage(first.index), 1);
  assert.equal(scheduler.usage(second.index), 1);
  scheduler.release(first.index);
  scheduler.release(second.index);
});
