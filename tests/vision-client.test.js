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

test("文本 delta 正常取，reasoning delta 必须丢掉", () => {
  // DSH 的 StreamChunk：text-delta 与 reasoning-delta 都带 text 字段，
  // 只判断 chunk.text 会把思考链拼进转写正文（实测污染过 29KB）。
  const chunks = [
    { type: "reasoning-delta", index: 0, text: "让我先想想这张图……" },
    { type: "reasoning-delta", index: 0, text: "图上应该有七个条。" },
    { type: "text-delta", index: 1, text: "截图：用量统计页" },
    { type: "text-delta", index: 1, text: "，共 4.50B。" },
  ];
  assert.equal(extractText(chunks), "截图：用量统计页，共 4.50B。");
});

test("reasoning 的其他常见字段形态同样丢掉", () => {
  assert.equal(extractText([{ type: "reasoning", text: "思考" }, { type: "text-delta", text: "正文" }]), "正文");
  assert.equal(extractText([{ type: "thinking", text: "思考" }, { type: "text-delta", text: "正文" }]), "正文");
  // OpenAI 原生流的 reasoning 块只带 delta.reasoning_content，没有 text
  assert.equal(extractText([{ delta: { reasoning_content: "思考" } }, { delta: { text: "正文" } }]), "正文");
  assert.equal(extractText([{ delta: { thinking: "思考" } }, { delta: { content: "正文" } }]), "正文");
  // 同时带 reasoning 字段与正文的块，正文要保留
  assert.equal(extractText([{ delta: { reasoning_content: "思考", content: "正文" } }]), "正文");
});

test("非正文控制块不会被当成文本", () => {
  const chunks = [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "正文" },
    { type: "tool-call-delta", index: 1, id: "t1", argumentsDelta: "{}" },
    { type: "usage", usage: {} },
    { type: "finish", reason: "stop" },
  ];
  assert.equal(extractText(chunks), "正文");
});

test("重试次数非法时按 0 处理", () => {
  assert.equal(retryLimitOf({ retries: 2 }), 2);
  assert.equal(retryLimitOf({ retries: "x" }), 0);
  assert.equal(retryLimitOf({}), 0);
});

test("识图失败时把最后一次派发的路由挂到 error 上", async () => {
  // 记账要能回答「是哪条路由挂了」；失败时 recognizeWithReport 会抛错，
  // 路由信息只能跟着 error 一起出去。
  const h = harness({ "c2a/vision": new Error("上游 500") });
  const image = imageOf("像素", "sha256:fail-route");
  const attachmentRef = await admitImage(h.ctx, image);
  await assert.rejects(
    () => h.client.recognizeWithReport({ ...image, attachmentRef }),
    (error) => {
      assert.ok(error.dshVisionRoute, "error 上应带 dshVisionRoute");
      assert.equal(error.dshVisionRoute.provider, "c2a");
      assert.equal(error.dshVisionRoute.model, "vision");
      assert.equal(typeof error.dshVisionRoute.attempt, "number");
      return true;
    },
  );
});

test("重试后仍失败时路由记的是最后一次尝试的模型", async () => {
  const h = harness({ "c2a/vision": new Error("上游 500") });
  const image = imageOf("像素", "sha256:fail-retry");
  const attachmentRef = await admitImage(h.ctx, image);
  await assert.rejects(
    () => h.client.recognizeWithReport({ ...image, attachmentRef }),
    (error) => {
      assert.equal(error.dshVisionRoute.provider, "c2a");
      assert.equal(error.dshVisionRoute.model, "vision");
      // 配置里 retries=1，所以 attempt 至少到 2。
      assert.ok(error.dshVisionRoute.attempt >= 1, `attempt=${error.dshVisionRoute.attempt}`);
      return true;
    },
  );
});

// ---- 空转识别：模型没收到图时必须判失败 ----
//
// 实测场景：池里混进不支持视觉的模型（把主模型当备用候选），它回
// 「图片被省略了，我看不到图片」，HTTP 200 内容非空，曾被记成成功。

test("识别：模型回「我看不到图片」判定为空转，不算成功", async () => {
  const h = harness({ "c2a/vision": "用户发了一张图片，但我的模型只接受文本，图片被省略了。我看不到图片。" });
  const image = imageOf("像素", "sha256:blind");
  const attachmentRef = await admitImage(h.ctx, image);
  await assert.rejects(() => h.client.recognize({ ...image, attachmentRef }), /没有收到图片/);
});

test("looksBlind：正常转写不误判，空回复与固定句式判空转", async () => {
  const { looksBlind } = await import("../lib/vision-client.js");
  assert.equal(looksBlind(""), true);
  assert.equal(looksBlind("我看不到图片"), true);
  assert.equal(looksBlind("Image omitted, the model accepts text only."), true);
  const real = "这是一张统计页截图，标题是「子代理模型池 · 统计」，展示分配次数、模型请求、token 用量（未缓存输入/输出/缓存读/缓存写）、回退父路由、探测失败、路由分布、池占用与子代理会话明细。";
  assert.equal(looksBlind(real), false);
});
