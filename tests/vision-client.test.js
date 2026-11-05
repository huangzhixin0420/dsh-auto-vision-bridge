import test from "node:test";
import assert from "node:assert/strict";
import { admitImage, extractText, retryLimitOf, VisionClient } from "../lib/vision-client.js";
import { fakeAttachments, fakeLlm, imageOf, testConfig } from "./helpers.js";

/** 带 llm 通道的测试上下文。 */
function harness(routes = { "c2a/vision": "识别结果" }, options = {}) {
  const attachments = fakeAttachments();
  const llm = fakeLlm(routes, options);
  const ctx = { attachments, llm, get(name) { return this[name]; } };
  const config = testConfig({ pool: [{ provider: "c2a", model: "vision", maxConcurrent: 2 }] });
  const client = new VisionClient(() => config, { ctx, llm });
  return { ctx, llm, client, config, attachments };
}

test("视觉请求走 llm 通道，携带 provider 与模型", async () => {
  const h = harness();
  const image = imageOf("像素", "sha256:x");
  const attachmentRef = await admitImage(h.ctx, image);
  const answer = await h.client.recognize({ ...image, attachmentRef });
  assert.equal(answer, "识别结果");
  assert.equal(h.llm.calls.length, 1);
  assert.equal(h.llm.calls[0].provider, "c2a");
  assert.equal(h.llm.calls[0].model, "vision");
});

test("图片先经附件服务落成持久引用", async () => {
  const h = harness();
  const image = imageOf("像素");
  const ref = await admitImage(h.ctx, image);
  assert.ok(ref.attachmentId);
  assert.equal(h.attachments.saved.length, 1);
  assert.ok(h.attachments.saved[0].bytes.byteLength > 0);
});

test("attachments 服务不可用时明确报错", async () => {
  const ctx = { get() { return undefined; } };
  await assert.rejects(admitImage(ctx, imageOf("x")), /attachments 服务不可用/);
});

test("超时、空识别文本、路由不存在均有明确错误", async () => {
  const h1 = harness({ "c2a/vision": "慢" }, { delayMs: 200 });
  const config = testConfig({ timeoutMs: 10, pool: [{ provider: "c2a", model: "vision" }] });
  const client1 = new VisionClient(() => config, { ctx: h1.ctx, llm: h1.llm });
  const image1 = imageOf("x");
  const ref1 = await admitImage(h1.ctx, image1);
  await assert.rejects(client1.recognize({ ...image1, attachmentRef: ref1 }), /超时/);

  const h2 = harness({ "c2a/vision": "" });
  const image2 = imageOf("x");
  const ref2 = await admitImage(h2.ctx, image2);
  await assert.rejects(h2.client.recognize({ ...image2, attachmentRef: ref2 }), /空识别文本/);

  const h3 = harness({});
  const image3 = imageOf("x");
  const ref3 = await admitImage(h3.ctx, image3);
  await assert.rejects(h3.client.recognize({ ...image3, attachmentRef: ref3 }), /未配置的路由/);
});

test("同图同提示复用缓存，不重复发请求", async () => {
  const h = harness();
  const image = imageOf("像素");
  const attachmentRef = await admitImage(h.ctx, image);
  await h.client.recognize({ ...image, attachmentRef });
  await h.client.recognize({ ...image, attachmentRef });
  assert.equal(h.llm.calls.length, 1);
});

test("流式响应的文本能从多种 chunk 形态里取出来", () => {
  assert.equal(extractText([{ text: "甲" }, { delta: { text: "乙" } }]), "甲乙");
  assert.equal(extractText([{ delta: { content: "丙" } }, { content: "丁" }]), "丙丁");
  assert.equal(extractText(["戊"]), "戊");
  assert.equal(extractText([]), "");
});

test("重试次数非法时按 0 处理", () => {
  assert.equal(retryLimitOf({ retries: 2 }), 2);
  assert.equal(retryLimitOf({ retries: "x" }), 0);
  assert.equal(retryLimitOf({}), 0);
});
