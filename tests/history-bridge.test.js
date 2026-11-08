import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeMessages } from "../lib/bridge.js";
import { createInspectImageTool } from "../lib/inspect-image.js";
import { attachment, fakeAttachments, imageMessage, testConfig, transcriptionOf } from "./helpers.js";

/** 收集记账内容的假账本。 */
function fakeHistory() {
  const records = [];
  return {
    records,
    async record(record) { records.push(record); },
  };
}

/** 假附件服务。 */
function fakeCtx() {
  return {
    attachments: fakeAttachments({
      readImage(ref) { return { data: Buffer.from("bytes"), mediaType: "image/png", ref }; },
    }),
    logger: { info() {}, warn() {} },
  };
}

test("自动桥接逐图记账：带上实际派发的模型、耗时与图片标识", async () => {
  const ctx = fakeCtx();
  const history = fakeHistory();
  const client = {
    async recognizeWithReport(image, question, signal) {
      return {
        text: "识别正文",
        provider: "c2a",
        model: "vision",
        durationMs: 2340,
        cached: false,
        attempt: 1,
      };
    },
  };
  const image = { type: "image", attachment: attachment("sha256:one", "shot.png") };
  const result = await bridgeMessages([imageMessage([image])], {
    ctx,
    client,
    getConfig: () => testConfig(),
    history,
    sessionId: "session-42",
  });
  assert.equal(result.changed, true);
  assert.equal(history.records.length, 1);
  const record = history.records[0];
  assert.equal(record.provider, "c2a");
  assert.equal(record.model, "vision");
  assert.equal(record.ok, true);
  assert.equal(record.durationMs, 2340);
  assert.equal(record.cached, false);
  assert.equal(record.attachmentId, "sha256:one");
  assert.equal(record.imageName, "shot.png");
  assert.equal(record.source, "bridge");
  assert.equal(record.sessionId, "session-42");
});

test("多图并发时每张图各记一条，图片与模型对应", async () => {
  const ctx = fakeCtx();
  const history = fakeHistory();
  const models = { "sha256:a": "model-a", "sha256:b": "model-b" };
  const client = {
    async recognizeWithReport(image) {
      const id = image.attachmentId;
      return {
        text: `识别:${id}`,
        provider: "c2a",
        model: models[id] ?? "unknown",
        durationMs: 100,
        cached: false,
        attempt: 1,
      };
    },
  };
  const a = { type: "image", attachment: attachment("sha256:a", "a.png") };
  const b = { type: "image", attachment: attachment("sha256:b", "b.png") };
  await bridgeMessages([imageMessage([a, b])], {
    ctx,
    client,
    getConfig: () => testConfig(),
    history,
    sessionId: "s",
  });
  assert.equal(history.records.length, 2);
  const byId = new Map(history.records.map((r) => [r.attachmentId, r]));
  assert.equal(byId.get("sha256:a").model, "model-a");
  assert.equal(byId.get("sha256:b").model, "model-b");
});

test("识图失败也记账，带失败原因", async () => {
  const ctx = fakeCtx();
  const history = fakeHistory();
  const client = {
    async recognizeWithReport() { throw new Error("视觉请求超时（60000ms）"); },
  };
  const image = { type: "image", attachment: attachment("sha256:bad", "bad.png") };
  await bridgeMessages([imageMessage([image])], {
    ctx,
    client,
    getConfig: () => testConfig(),
    history,
    sessionId: "s",
  });
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0].ok, false);
  assert.match(history.records[0].error, /超时/);
  assert.equal(history.records[0].imageName, "bad.png");
});

test("记账失败不影响识图结果", async () => {
  const ctx = fakeCtx();
  const client = {
    async recognizeWithReport() {
      return { text: "识别正文", provider: "c2a", model: "vision", durationMs: 10, cached: false, attempt: 1 };
    },
  };
  const history = {
    async record() { throw new Error("账本挂了"); },
  };
  const image = { type: "image", attachment: attachment("sha256:x") };
  const result = await bridgeMessages([imageMessage([image])], {
    ctx,
    client,
    getConfig: () => testConfig(),
    history,
    sessionId: "s",
  });
  assert.equal(result.changed, true);
  assert.match(transcriptionOf(result.messages[0]), /识别正文/);
});

test("inspect_image 工具链路记账，来源标为 inspect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avb-history-"));
  try {
    const file = join(dir, "tool.png");
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const ctx = fakeCtx();
    const history = fakeHistory();
    const client = {
      async recognizeWithReport() {
        return { text: "工具识别", provider: "c2a", model: "vision", durationMs: 500, cached: false, attempt: 1 };
      },
    };
    const tool = createInspectImageTool((definition) => definition, {
      ctx,
      client,
      getConfig: () => testConfig(),
      history,
    });
    const result = await tool.execute({ path: file }, {
      agent: { session: { id: "session-7" } },
    });
    assert.equal(result[0].ok, true);
    assert.equal(history.records.length, 1);
    assert.equal(history.records[0].source, "inspect");
    assert.equal(history.records[0].sessionId, "session-7");
    assert.equal(history.records[0].model, "vision");
    assert.equal(history.records[0].imageName, "tool.png");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("旧客户端只有 recognize 时仍能识图，记账里没有模型信息", async () => {
  const ctx = fakeCtx();
  const history = fakeHistory();
  const client = {
    async recognize() { return "旧接口结果"; },
  };
  const image = { type: "image", attachment: attachment("sha256:old") };
  const result = await bridgeMessages([imageMessage([image])], {
    ctx,
    client,
    getConfig: () => testConfig(),
    history,
    sessionId: "s",
  });
  assert.match(transcriptionOf(result.messages[0]), /旧接口结果/);
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0].provider, "");
  assert.equal(history.records[0].model, "");
  assert.equal(history.records[0].ok, true);
});
