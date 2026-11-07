import test from "node:test";
import assert from "node:assert/strict";
import { createVisionBridgeAdapter } from "../lib/provider-bridge.js";
import { VisionClient } from "../lib/vision-client.js";
import { attachment, fakeAttachments, fakeLlm, imageMessage, testConfig } from "./helpers.js";

const BRIDGE_PROVIDER = "vision-bridge";
const INNER_PROVIDER = "c2a";
const TEXT_MODEL = "text";
const VISION_MODEL = "vision";

/**
 * 模拟真实 dsh-llm 的 prepareCall 契约：stream 前逐字段比对控制参数。
 *
 * 实测宿主会比对 provider/model/temperature/maxTokens/reasoningEffort/stop，
 * 有一项不同就抛 INVALID_PREPARED_CALL。假 llm 不校验的话，包装层把整包
 * options 原样丢给内部流的错误就测不出来。
 */
function strictLlm(llm) {
  const prepareCall = llm.prepareCall.bind(llm);
  llm.prepareCall = async (config, signal) => {
    const call = await prepareCall(config, signal);
    return {
      ...call,
      config: { ...config },
      stream(options) {
        for (const key of ["provider", "model", "temperature", "maxTokens", "reasoningEffort"]) {
          assert.equal(options?.[key], call.config?.[key], `内部流收到不一致的 ${key}`);
        }
        return call.stream(options);
      },
    };
  };
  return llm;
}

/**
 * 装一套桥接环境。
 *
 * 内部 provider 同时扮演两个角色：主模型（c2a/text）与视觉模型（c2a/vision），
 * 和真实部署一致 —— 转写走的是宿主的 llm 通道，不是另一条 HTTP 连接。
 */
function harness({ providerBridge = {}, recognition = "图里是一只橘猫", recognitionError = null } = {}) {
  const seen = [];
  const reads = [];
  const recognitions = [];
  const attachments = fakeAttachments({
    readImage(ref) {
      reads.push(ref.attachmentId);
      return { ref, data: Buffer.from(`bytes:${ref.attachmentId}`) };
    },
  });
  const llm = fakeLlm({
    [`${INNER_PROVIDER}/${VISION_MODEL}`]: recognition,
    [`${INNER_PROVIDER}/${TEXT_MODEL}`]: (options) => {
      seen.push(options);
      return "主模型回复";
    },
  });
  // 真实 dsh-llm 由适配器提供这两项能力查询；假 llm 只模拟派发，这里补齐最小契约。
  llm.resolveModelInfo = async (provider, model) => ({
    provider,
    id: model,
    name: `模型 ${model}`,
    inputModalities: ["text"],
  });
  llm.listModels = async (provider) => [{ provider, id: TEXT_MODEL, name: "文本模型", inputModalities: ["text"] }];
  strictLlm(llm);

  const ctx = {
    attachments,
    get(name) { return this[name]; },
    logger: { info() {}, warn() {} },
  };
  const client = {
    async recognizeWithReport(image) {
      if (recognitionError) throw recognitionError;
      recognitions.push({ attachmentId: image.attachmentId, ref: image.attachmentRef });
      const text = typeof recognition === "function" ? await recognition(image) : recognition;
      return { text, provider: INNER_PROVIDER, model: VISION_MODEL, durationMs: 1, cached: false, attempt: 1 };
    },
  };
  const getConfig = () => testConfig({ providerBridge });
  const adapter = createVisionBridgeAdapter({
    ctx,
    llm,
    getConfig,
    client,
    innerProvider: INNER_PROVIDER,
    modelId: TEXT_MODEL,
    logger: ctx.logger,
  });
  return { adapter, ctx, llm, client, attachments, seen, reads, recognitions, getConfig };
}

/** 走一次完整的 prepared call，返回宿主会收到的 chunk。 */
async function streamOnce(adapter, messages) {
  const call = await adapter.prepareCall(BRIDGE_PROVIDER, TEXT_MODEL, undefined);
  const chunks = [];
  for await (const chunk of call.stream({ provider: BRIDGE_PROVIDER, model: TEXT_MODEL, messages })) {
    chunks.push(chunk);
  }
  return chunks;
}

test("图片块被换成转写文本，转发给内部 provider 的消息里不再有 image", async () => {
  const h = harness({ recognition: "页面标题是统计" });
  const messages = [imageMessage([
    { type: "text", text: "这是什么" },
    { type: "image", attachment: attachment("sha256:aaa", "猫.png") },
  ])];

  const chunks = await streamOnce(h.adapter, messages);

  assert.equal(h.seen.length, 1, "内部流应该被调用一次");
  const forwarded = h.seen[0];
  assert.equal(forwarded.provider, INNER_PROVIDER, "转发时 provider 必须切回内部 provider");
  assert.equal(forwarded.model, TEXT_MODEL);
  const content = forwarded.messages[0].content;
  assert.equal(content.some((block) => block.type === "image"), false, "图片块必须已被替换");
  assert.ok(
    content.some((block) => block.type === "text" && block.text.includes("页面标题是统计")),
    "转写文本应作为 text 块出现",
  );
  assert.deepEqual(chunks, [{ text: "主模型回复" }], "内部 chunk 原样透传");
});

test("包装模型的 inputModalities 必须含 image，否则宿主会先把图剥成占位符", async () => {
  const h = harness();
  const info = await h.adapter.resolveModel(BRIDGE_PROVIDER, TEXT_MODEL);
  assert.ok(info.inputModalities.includes("image"));
  assert.deepEqual(info.inputModalities, ["text", "image"], "原有模态不能被覆盖掉");
  // 归属与 id 必须改写成包装 provider 名下的，否则宿主校验过不去。
  assert.equal(info.provider, BRIDGE_PROVIDER);
  assert.equal(info.id, TEXT_MODEL);

  const call = await h.adapter.prepareCall(BRIDGE_PROVIDER, TEXT_MODEL);
  assert.ok(call.model.inputModalities.includes("image"));
  assert.equal(call.model.provider, BRIDGE_PROVIDER);
});

test("转写失败只降级成说明文字，不把整轮请求打掉", async () => {
  const h = harness({ recognitionError: new Error("视觉路由 429") });
  const messages = [imageMessage([
    { type: "text", text: "看看这张" },
    { type: "image", attachment: attachment("sha256:bad", "坏图.png") },
  ])];

  const chunks = await streamOnce(h.adapter, messages);

  assert.equal(h.seen.length, 1, "主模型仍要收到请求");
  const content = h.seen[0].messages[0].content;
  assert.equal(content.some((block) => block.type === "image"), false);
  const text = content.map((block) => block.text ?? "").join("\n");
  assert.match(text, /图片转写失败/);
  assert.match(text, /429/, "失败原因要带给主模型");
  assert.deepEqual(chunks, [{ text: "主模型回复" }]);
});

test("同一 attachmentId 只转写一次：同轮重复引用与跨轮重复都命中缓存", async () => {
  const h = harness();
  const shared = attachment("sha256:dup", "同一张.png");
  const messages = [imageMessage([
    { type: "image", attachment: shared },
    { type: "text", text: "再看一眼" },
    { type: "image", attachment: shared },
  ])];

  await streamOnce(h.adapter, messages);
  assert.equal(h.recognitions.length, 1, "同一轮里两次引用只该转写一次");

  await streamOnce(h.adapter, messages);
  await streamOnce(h.adapter, messages);
  assert.equal(h.recognitions.length, 1, "后续轮次仍是同一张图，应该直接命中缓存");
});

test("没有图片的消息原样透传，完全不碰视觉模型", async () => {
  const h = harness();
  const messages = [imageMessage([{ type: "text", text: "纯文本" }])];

  const chunks = await streamOnce(h.adapter, messages);

  assert.strictEqual(h.seen[0].messages, messages, "无图时应保持同一引用");
  assert.equal(h.recognitions.length, 0, "没有图就不该调视觉模型");
  assert.equal(h.reads.length, 0);
  assert.equal(h.seen[0].messages[0].content.length, 1);
  assert.deepEqual(chunks, [{ text: "主模型回复" }]);
});

test("显式 enabled: false 时完全透传，既不转写也不声明 image", async () => {
  const h = harness({ providerBridge: { enabled: false } });
  const messages = [imageMessage([{ type: "image", attachment: attachment("sha256:off") }])];

  const info = await h.adapter.resolveModel(BRIDGE_PROVIDER, TEXT_MODEL);
  assert.deepEqual(info.inputModalities, ["text"], "关闭时保持内部模态，让宿主自己投影");

  await streamOnce(h.adapter, messages);
  assert.equal(h.recognitions.length, 0);
  assert.strictEqual(h.seen[0].messages, messages);
});

test("已卸载（offloaded）的图不读字节、不转写，但要留下说明文字", async () => {
  const h = harness();
  const messages = [imageMessage([
    { type: "image", attachment: attachment("sha256:gone"), offloaded: true },
    { type: "text", text: "继续" },
  ])];

  await streamOnce(h.adapter, messages);

  assert.equal(h.reads.length, 0, "卸载的图没有可读字节");
  assert.equal(h.recognitions.length, 0);
  const content = h.seen[0].messages[0].content;
  assert.equal(content.some((block) => block.type === "image"), false, "绝不能把 image 块原样转给文本模型");
  assert.match(content[0].text, /已因上下文压缩被省略/);
});

test("adapter 契约：providerInfo 对齐 id、listModels 改归属、重试策略转发", async () => {
  const h = harness();
  assert.deepEqual(h.adapter.providerInfo(BRIDGE_PROVIDER), { id: BRIDGE_PROVIDER, name: "视觉桥接" });

  const models = await h.adapter.listModels(BRIDGE_PROVIDER);
  assert.equal(models.length, 1);
  assert.equal(models[0].provider, BRIDGE_PROVIDER);
  assert.ok(models[0].inputModalities.includes("image"));

  // 实测 dsh-llm 的 prepareRoutes 会无条件调用本方法，缺了直接 TypeError。
  assert.equal(typeof h.adapter.providerRetryPolicy, "function");
  assert.equal(h.adapter.providerRetryPolicy(BRIDGE_PROVIDER), undefined);
});

test("内层 provider 配成自己时给出可读报错，不会递归到栈溢出", async () => {
  const h = harness();
  const self = createVisionBridgeAdapter({
    ctx: h.ctx,
    llm: h.llm,
    getConfig: h.getConfig,
    client: h.client,
    innerProvider: BRIDGE_PROVIDER,
  });
  await assert.rejects(self.prepareCall(BRIDGE_PROVIDER, TEXT_MODEL), /不能是本 provider 自己/);
});

test("走真实 VisionClient 时整条链路仍然成立", async () => {
  const h = harness();
  const config = testConfig({
    pool: [{ provider: INNER_PROVIDER, model: VISION_MODEL, maxConcurrent: 1 }],
  });
  const client = new VisionClient(() => config, { ctx: h.ctx, llm: h.llm });
  const adapter = createVisionBridgeAdapter({
    ctx: h.ctx,
    llm: h.llm,
    getConfig: () => config,
    client,
    innerProvider: INNER_PROVIDER,
    modelId: TEXT_MODEL,
  });
  const messages = [imageMessage([{ type: "image", attachment: attachment("sha256:real", "真图.png") }])];

  const call = await adapter.prepareCall(BRIDGE_PROVIDER, TEXT_MODEL, undefined);
  for await (const _chunk of call.stream({ provider: BRIDGE_PROVIDER, model: TEXT_MODEL, messages })) {
    // 只关心链路跑通，chunk 内容由前面的用例覆盖。
  }

  // 视觉调用与主模型调用各一次，且都走了同一个 llm 通道。
  assert.deepEqual(h.llm.calls, [
    { provider: INNER_PROVIDER, model: VISION_MODEL },
    { provider: INNER_PROVIDER, model: TEXT_MODEL },
  ]);
  const text = h.seen[0].messages[0].content.map((block) => block.text).join("\n");
  assert.match(text, /图里是一只橘猫/);
});

test("历史 assistant 消息的归属改回内部 provider，否则 reasoning 回放会被宿主剥掉", async () => {
  const { adapter, seen } = harness({ recognition: "转写结果" });
  const history = [
    {
      role: "assistant",
      source: {
        kind: "model",
        provider: BRIDGE_PROVIDER,
        model: TEXT_MODEL,
        replayState: { blob: "reasoning-1" },
      },
      content: [{ type: "text", text: "上一轮回答" }],
    },
  ];
  await streamOnce(adapter, history);

  // 宿主的 forAdapter() 按 source.provider 找 adapter，认不出就把 replayState 删掉，
  // 推理模型的多轮 reasoning 回放会因此失效。请求确实发给了内层，所以归属要改回去。
  const forwarded = seen.at(-1).messages[0];
  assert.equal(forwarded.source.provider, INNER_PROVIDER);
  assert.deepEqual(forwarded.source.replayState, { blob: "reasoning-1" }, "replayState 必须还在");
  assert.equal(forwarded.role, "assistant");
});
