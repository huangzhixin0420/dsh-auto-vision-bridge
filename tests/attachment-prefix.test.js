import test from "node:test";
import assert from "node:assert/strict";
import {
  collectImageRefs,
  findUserImageAttachmentByPrefix,
  loadAttachmentById,
} from "../lib/image-source.js";
import { testConfig } from "./helpers.js";

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

test("前缀唯一匹配：只抄前 8 位也能定位到完整 ID", () => {
  const ref = imageRef(FULL_A, "a.png");
  const session = sessionWith([ref, imageRef(FULL_B, "b.png")]);
  const { ref: matched, candidates } = findUserImageAttachmentByPrefix(session, "sha256:b72ce640");
  assert.strictEqual(matched, ref, "应返回原始 ref 对象（保留 bytes 等字段）");
  assert.equal(candidates.length, 1);
});

test("前缀匹配容忍大小写、缺失 sha256: 前缀与首尾空白", () => {
  const ref = imageRef(FULL_A, "a.png");
  const session = sessionWith([ref, imageRef(FULL_B, "b.png")]);
  for (const written of [
    "sha256:B72CE640",
    "b72ce640",
    "  sha256:b72ce640  ",
    FULL_A,
  ]) {
    const { ref: matched } = findUserImageAttachmentByPrefix(session, written);
    assert.strictEqual(matched, ref, `应匹配：${JSON.stringify(written)}`);
  }
});

test("前缀撞车时不猜，把候选全部返回", () => {
  const session = sessionWith([imageRef(FULL_A, "a.png"), imageRef(FULL_C, "c.png")]);
  // FULL_A 与 FULL_C 都以 b 开头，但 b72 只有 A 有；这里用共同的 b 前缀制造撞车。
  const { ref: matched, candidates } = findUserImageAttachmentByPrefix(session, "sha256:b");
  assert.equal(matched, undefined, "多匹配时不应返回唯一结果");
  assert.equal(candidates.length, 2);
});

test("空 ID 不匹配任何东西（空串是所有 ID 的前缀）", () => {
  const session = sessionWith([imageRef(FULL_A, "a.png")]);
  for (const empty of ["", "   ", "sha256:", "SHA256:"]) {
    const { ref: matched, candidates } = findUserImageAttachmentByPrefix(session, empty);
    assert.equal(matched, undefined, `空值不应匹配：${JSON.stringify(empty)}`);
    assert.equal(candidates.length, 0);
  }
});

test("完全对不上时返回空结果，交给原错误路径处理", () => {
  const session = sessionWith([imageRef(FULL_A, "a.png")]);
  const { ref: matched, candidates } = findUserImageAttachmentByPrefix(session, "sha256:ffff0000");
  assert.equal(matched, undefined);
  assert.equal(candidates.length, 0);
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

test("loadAttachmentById：精确命中优先于前缀匹配", async () => {
  const exact = imageRef(FULL_A, "a.png");
  const session = sessionWith([exact, imageRef(FULL_C, "c.png")]);
  const read = [];
  const ctx = {
    attachments: {
      async readImage(ref) {
        read.push(ref.attachmentId);
        return { data: Buffer.from("x"), mediaType: "image/png", ref };
      },
    },
    logger: { info() {}, warn() {} },
  };
  const image = await loadAttachmentById(ctx, session, FULL_A, testConfig());
  assert.equal(image.attachmentId, FULL_A);
  assert.deepEqual(read, [FULL_A]);
});

test("loadAttachmentById：精确失败时用前缀补全，并记一条 info 日志", async () => {
  const session = sessionWith([imageRef(FULL_A, "a.png"), imageRef(FULL_C, "c.png")]);
  const logs = [];
  const ctx = {
    attachments: {
      async readImage(ref) {
        return { data: Buffer.from("x"), mediaType: "image/png", ref };
      },
    },
    logger: { info: (m) => logs.push(m), warn() {} },
  };
  const image = await loadAttachmentById(ctx, session, "sha256:b72ce640", testConfig());
  assert.equal(image.attachmentId, FULL_A);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /按前缀补全/);
});

test("loadAttachmentById：前缀撞车时报错并列出候选，不擅自选一张", async () => {
  const session = sessionWith([imageRef(FULL_A, "a.png"), imageRef(FULL_C, "c.png")]);
  const ctx = {
    attachments: {
      async readImage(ref) { return { data: Buffer.from("x"), mediaType: "image/png", ref }; },
    },
    logger: { info() {}, warn() {} },
  };
  await assert.rejects(
    () => loadAttachmentById(ctx, session, "sha256:b", testConfig()),
    (error) => {
      assert.match(error.message, /匹配到 2 张图片/);
      assert.match(error.message, /请改用完整 ID/);
      assert.match(error.message, new RegExp(FULL_A));
      assert.match(error.message, new RegExp(FULL_C));
      return true;
    },
  );
});

test("loadAttachmentById：完全找不到时仍走原来的「列出可用图片」提示", async () => {
  const session = sessionWith([imageRef(FULL_A, "a.png")]);
  const ctx = {
    attachments: {
      async readImage(ref) { return { data: Buffer.from("x"), mediaType: "image/png", ref }; },
    },
    logger: { info() {}, warn() {} },
  };
  await assert.rejects(
    () => loadAttachmentById(ctx, session, "sha256:ffff0000", testConfig()),
    (error) => {
      assert.match(error.message, /当前会话未找到图片附件/);
      assert.match(error.message, /当前会话可用的图片附件/);
      return true;
    },
  );
});
