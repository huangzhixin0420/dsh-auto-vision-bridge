import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectImageRefs,
  isCompleteAttachmentId,
  loadAttachmentById,
  truncatedIdMessage,
} from "../lib/image-source.js";
import { testConfig } from "./helpers.js";

/**
 * 把 HOME 指到空目录：全局附件库回落读 `${homedir()}/.dsh/attachments/...`，
 * 不隔离的话测试会摸到本机真实附件库 —— 之前 `FULL_B` 就在真库里存在，
 * 表现出来是「本该找不到却读回了图」，非常难查。
 */
let sandbox;
before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "avb-attachment-test-"));
  process.env.HOME = sandbox;
});
after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

/** 真实长度的附件 ID：sha256: + 64 位 hex。 */
const FULL_A = "sha256:b72ce640f2d6b6762efa429866ca7c8d560a1eba6e60fed2b1ba8eb809c67602";
const FULL_B = "sha256:124ff1f591974c9c4bcb844372bd40a379bea78d5eae7d8775e273bc0b25025d";
const FULL_C = "sha256:b9990000111122223333444455556666aaaa7777888899990000111122223333";

/** 造一个只带图片的会话。 */
function sessionWith(refs) {
  return {
    header: { cwd: "/tmp" },
    snapshotEvents: () => [{
      type: "user/message",
      data: { content: refs.map((ref) => ({ type: "image", attachment: ref })) },
    }],
  };
}

/** 一个图片引用。 */
function imageRef(id, name) {
  return { attachmentId: id, mediaType: "image/png", name, bytes: 4 };
}

/** 一个不会真的读到磁盘的 ctx。 */
function readOnlyCtx(read) {
  return {
    attachments: {
      async readImage(ref) {
        read.push(ref.attachmentId);
        return { data: Buffer.from("x"), mediaType: "image/png", ref };
      },
    },
    logger: { info() {}, warn() {} },
  };
}

test("isCompleteAttachmentId：只认完整 64 位", () => {
  assert.equal(isCompleteAttachmentId(FULL_A), true);
  assert.equal(isCompleteAttachmentId("sha256:" + FULL_A.slice(7).toUpperCase()), true, "大小写不影响完整性");
  assert.equal(isCompleteAttachmentId("  " + FULL_A + "  "), true, "首尾空白不影响完整性");
  assert.equal(isCompleteAttachmentId(FULL_A.slice(7)), true, "缺 sha256: 前缀但 64 位仍是完整 ID");

  assert.equal(isCompleteAttachmentId("sha256:b72ce640"), false, "8 位前缀不是完整 ID");
  assert.equal(isCompleteAttachmentId("sha256:b72ce640f2d6"), false, "12 位前缀不是完整 ID");
  assert.equal(isCompleteAttachmentId("sha256:"), false);
  assert.equal(isCompleteAttachmentId(""), false);
  assert.equal(isCompleteAttachmentId("   "), false);
  assert.equal(isCompleteAttachmentId(undefined), false);
  assert.equal(isCompleteAttachmentId(FULL_A + "0"), false, "超过 64 位也不算");
});

test("truncatedIdMessage：说清位数、列出全部完整 ID、要求重抄", () => {
  const available = [imageRef(FULL_A, "a.png"), imageRef(FULL_C, "c.png")];
  const message = truncatedIdMessage("sha256:b72ce640", available);
  assert.match(message, /不完整/);
  assert.match(message, /8 位/);
  assert.match(message, /64 位/);
  assert.match(message, new RegExp(FULL_A), "必须给出完整 ID 供重抄");
  assert.match(message, new RegExp(FULL_C));
  assert.match(message, /重试/);
});

test("truncatedIdMessage：会话里没有图片时明说", () => {
  const message = truncatedIdMessage("sha256:b72ce640", []);
  assert.match(message, /不完整/);
  assert.match(message, /没有任何图片附件/);
});

test("collectImageRefs 覆盖 user/message、inbox 与 compaction 摘要里的图片", () => {
  const a = imageRef(FULL_A, "a.png");
  const b = imageRef(FULL_B, "b.png");
  const c = imageRef(FULL_C, "c.png");
  const session = {
    snapshotEvents: () => [
      { type: "user/message", data: { content: [{ type: "image", attachment: a }] } },
      { type: "agent/inbox/spliced", data: { inserted: [{ content: [{ type: "image", attachment: b }] }] } },
      { type: "compaction/summary", data: { summary: [{ type: "image", attachment: c }] } },
    ],
  };
  const ids = collectImageRefs(session).map((ref) => ref.attachmentId);
  assert.deepEqual(ids.sort(), [FULL_A, FULL_B, FULL_C].sort());
});

test("loadAttachmentById：完整 ID 命中会话内的图", async () => {
  const read = [];
  const session = sessionWith([imageRef(FULL_A, "a.png"), imageRef(FULL_C, "c.png")]);
  const image = await loadAttachmentById(readOnlyCtx(read), session, FULL_A, testConfig());
  assert.equal(image.attachmentId, FULL_A);
  assert.deepEqual(read, [FULL_A]);
});

test("loadAttachmentById：完整 ID 的大小写与空白都容忍", async () => {
  const read = [];
  const session = sessionWith([imageRef(FULL_A, "a.png")]);
  for (const written of ["SHA256:" + FULL_A.slice(7).toUpperCase(), "  " + FULL_A + "  ", FULL_A.slice(7)]) {
    const image = await loadAttachmentById(readOnlyCtx(read), session, written, testConfig());
    assert.equal(image.attachmentId, FULL_A, `应命中：${JSON.stringify(written.slice(0, 20))}`);
  }
});

test("loadAttachmentById：抄短的 ID 直接拒绝，不猜前缀", async () => {
  const read = [];
  const session = sessionWith([imageRef(FULL_A, "a.png"), imageRef(FULL_C, "c.png")]);
  await assert.rejects(
    () => loadAttachmentById(readOnlyCtx(read), session, "sha256:b72ce640", testConfig()),
    (error) => {
      assert.match(error.message, /不完整/);
      assert.match(error.message, new RegExp(FULL_A), "报错要给出可重抄的完整 ID");
      assert.match(error.message, new RegExp(FULL_C));
      return true;
    },
  );
  assert.deepEqual(read, [], "拒绝时不应读图");
});

test("loadAttachmentById：即使前缀唯一命中也要拒绝（不静默补全）", async () => {
  // FULL_A 的前 8 位在会话里唯一，旧实现会直接补全；现在必须报错。
  const read = [];
  const session = sessionWith([imageRef(FULL_A, "a.png")]);
  await assert.rejects(
    () => loadAttachmentById(readOnlyCtx(read), session, "sha256:b72ce640", testConfig()),
    (error) => {
      assert.match(error.message, /不完整/);
      return true;
    },
  );
  assert.deepEqual(read, [], "唯一前缀也不应被接受");
});

test("loadAttachmentById：空 ID 拒绝", async () => {
  const read = [];
  const session = sessionWith([imageRef(FULL_A, "a.png")]);
  for (const empty of ["", "   ", "sha256:"]) {
    await assert.rejects(
      () => loadAttachmentById(readOnlyCtx(read), session, empty, testConfig()),
      (error) => {
        assert.match(error.message, /不完整|为空/);
        return true;
      },
      `空值应拒绝：${JSON.stringify(empty)}`,
    );
  }
  assert.deepEqual(read, []);
});

test("loadAttachmentById：完整但会话里没有时，列出可用图片", async () => {
  const read = [];
  const session = sessionWith([imageRef(FULL_A, "a.png")]);
  await assert.rejects(
    () => loadAttachmentById(readOnlyCtx(read), session, FULL_B, testConfig()),
    (error) => {
      assert.match(error.message, /当前会话未找到图片附件/);
      assert.match(error.message, new RegExp(FULL_A), "列出可用图片的完整 ID，供模型纠正");
      return true;
    },
  );
});
