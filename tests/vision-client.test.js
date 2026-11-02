import test from "node:test";
import assert from "node:assert/strict";
import { callVision, resolveApiKey, VisionClient } from "../lib/vision-client.js";
import { imageOf, jsonResponse, testConfig, visionResponse } from "./helpers.js";

test("视觉请求使用 chat/completions、text + data URL，并支持自定义问题", async () => {
  let captured;
  const answer = await callVision(testConfig(), imageOf("像素"), "图中写了什么？", undefined, async (url, options) => {
    captured = { url, options };
    return visionResponse("识别结果");
  });
  assert.equal(answer, "识别结果");
  assert.equal(captured.url.href, "https://vision.example/v1/chat/completions");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers.Authorization, "Bearer test-secret");
  assert.ok(captured.options.signal instanceof AbortSignal);
  const body = JSON.parse(captured.options.body);
  assert.equal(body.model, "vision-test");
  assert.equal(body.max_tokens, 512);
  assert.equal(body.messages[0].content[0].text, "图中写了什么？");
  assert.equal(body.messages[0].content[1].type, "image_url");
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test("缺 key 明确报错且零网络调用；apiKeyEnv 可独立提供密钥", async () => {
  let calls = 0;
  await assert.rejects(
    callVision(testConfig({ apiKey: "", apiKeyEnv: " definitely_unset " }), imageOf("x"), undefined, undefined, async () => {
      calls++;
      return visionResponse("不应成功");
    }),
    /key 缺失/,
  );
  assert.equal(calls, 0);
  assert.equal(resolveApiKey({ apiKey: "", apiKeyEnv: "CUSTOM" }, { CUSTOM: " env-key " }), "env-key");
});

test("超时、外部 AbortSignal、非 2xx、空响应均有明确错误", async (t) => {
  await t.test("超时", async () => {
    await assert.rejects(callVision(testConfig({ timeoutMs: 10 }), imageOf("x"), undefined, undefined, (_url, options) =>
      new Promise((_, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      })), /超时/);
  });
  await t.test("外部取消", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(callVision(testConfig(), imageOf("x"), undefined, controller.signal, async () => {
      throw new Error("不应发起");
    }), /已取消/);
  });
  await t.test("非 2xx 且不泄露 key", async () => {
    await assert.rejects(callVision(testConfig(), imageOf("x"), undefined, undefined, async () =>
      jsonResponse({ error: { message: "bad key test-secret" } }, { status: 401, statusText: "Unauthorized" })),
    (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.doesNotMatch(error.message, /test-secret/);
      assert.match(error.message, /\[已隐藏\]/);
      return true;
    });
  });
  await t.test("空响应与空文本", async () => {
    await assert.rejects(callVision(testConfig(), imageOf("x"), undefined, undefined, async () =>
      new Response("", { status: 200 })), /空响应或非 JSON/);
    await assert.rejects(callVision(testConfig(), imageOf("x"), undefined, undefined, async () =>
      visionResponse("  ")), /空识别文本/);
  });
});

test("共享缓存做 in-flight 去重、成功复用、失败移除及配置隔离", async () => {
  let config = testConfig();
  let calls = 0;
  let release;
  const client = new VisionClient(() => config, {
    fetchImpl: () => {
      calls++;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  const image = imageOf("相同图片", "sha256:same");
  const first = client.recognize(image);
  const second = client.recognize(image);
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  release(visionResponse("共享结果"));
  assert.equal(await first, "共享结果");
  assert.equal(await second, "共享结果");
  assert.equal(await client.recognize(image), "共享结果");
  assert.equal(calls, 1);

  const fast = new VisionClient(() => config, {
    fetchImpl: async () => { calls++; return visionResponse(`调用 ${calls}`); },
  });
  await fast.recognize(image);
  config = testConfig({ baseURL: "https://other.example/v1" });
  await fast.recognize(image);
  config = testConfig({ model: "other-model" });
  await fast.recognize(image);
  config = testConfig({ prompt: "另一个提示" });
  await fast.recognize(image);
  await fast.recognize(image, "另一个问题");
  assert.equal(calls, 6); // 首次 1 次 + 四项语义变化各 1 次 + 前面的慢请求 1 次

  let fail = true;
  let retries = 0;
  const failing = new VisionClient(() => testConfig(), {
    fetchImpl: async () => {
      retries++;
      if (fail) throw new Error("临时失败");
      return visionResponse("恢复");
    },
  });
  await assert.rejects(failing.recognize(image), /临时失败/);
  assert.equal(failing.size, 0);
  fail = false;
  assert.equal(await failing.recognize(image), "恢复");
  assert.equal(retries, 2);
});

test("缓存有界并淘汰最旧项", async () => {
  const client = new VisionClient(() => testConfig(), {
    maxEntries: 2,
    fetchImpl: async () => visionResponse("ok"),
  });
  await client.recognize(imageOf("1"));
  await client.recognize(imageOf("2"));
  await client.recognize(imageOf("3"));
  assert.equal(client.size, 2);
});
