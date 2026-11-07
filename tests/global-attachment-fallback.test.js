import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { loadAttachmentById, sniffMediaType } from "../lib/image-source.js";
import { testConfig } from "./helpers.js";

/**
 * 全局对象库回落：宿主把附件按 sha256 落在
 * ~/.dsh/attachments/v1/objects/<前2位>/<完整hex>，跨会话、跨重启都在。
 * 只查会话的话，换个会话就再也看不到旧图（实测踩过）。
 */
const OBJ = join(homedir(), ".dsh", "attachments", "v1", "objects");

/** 从真实全局库里找一个附件名；库是空的就跳过（CI 或新机器）。 */
async function anyGlobalObject() {
  let dirs;
  try {
    dirs = await readdir(OBJ);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    let names;
    try {
      names = await readdir(join(OBJ, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      // 全局库里也有非图片附件，挑一张真图，否则回落逻辑会（正确地）拒绝它。
      try {
        const data = await readFile(join(OBJ, dir, name));
        if (sniffMediaType(data) && data.byteLength <= testConfig().maxImageBytes) return name;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

const emptySession = { id: "session-empty", events: [] };

test("会话里没有时从全局对象库补读（完整 ID）", async (t) => {
  const target = await anyGlobalObject();
  if (!target) return t.skip("本机全局附件库为空");
  const got = await loadAttachmentById({}, emptySession, `sha256:${target}`, testConfig());
  assert.equal(got.attachmentId, `sha256:${target}`);
  assert.ok(got.data.byteLength > 0);
  assert.match(got.mediaType, /^image\//);
});

test("会话里没有时，短前缀被直接拒绝（不猜前缀，避免静默读错图）", async (t) => {
  const target = await anyGlobalObject();
  if (!target) return t.skip("本机全局附件库为空");
  await assert.rejects(
    () => loadAttachmentById({}, emptySession, `sha256:${target.slice(0, 8)}`, testConfig()),
    /不完整/,
  );
});

/** 绝不可能存在的完整 ID：64 位 hex，撞上真实对象的概率可忽略。 */
const ABSENT = `sha256:${"0123456789abcdef".repeat(4)}`;

test("全局库里也没有时报「未找到」", async () => {
  await assert.rejects(
    () => loadAttachmentById({}, emptySession, ABSENT, testConfig()),
    /未找到图片附件/,
  );
});

test("非十六进制 ID 不会被当成路径去扫", async () => {
  // 不完整 / 非 hex 一律在进入文件系统之前被拒，永远走不到拼路径那一步。
  await assert.rejects(
    () => loadAttachmentById({}, emptySession, "sha256:../../etc/passwd", testConfig()),
    /不完整/,
  );
  // 长度补齐但含非 hex 字符的，也不能被拼成路径。
  await assert.rejects(
    () => loadAttachmentById({}, emptySession, `sha256:${"z".repeat(64)}`, testConfig()),
    /不完整/,
  );
});
