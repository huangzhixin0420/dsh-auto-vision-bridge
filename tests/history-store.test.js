import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileStore, defaultHistoryDir, legacyHistoryDir } from "../lib/history-store.js";

/**
 * 文件存储是识图历史的落盘层，替代了 DSH 的 storageDomain。
 *
 * 换掉的动机：storageDomain 每次 put 都 emit("domain/changed")，前端收到会重渲染
 * 消息列表，图片组件被重建、重新 createObjectURL，用户看到「整张图闪一下」。
 * 因此这里必须保证：写入只碰文件，不产生任何事件（也没有事件可产生）。
 *
 * 代价是自己实现 storageDomain 原本自带的两件事：原子写、坏记录隔离。下面的
 * 用例就是盯这两点。
 */

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), "avb-store-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const sample = (overrides = {}) => ({
  time: 1700000000000,
  provider: "c2a",
  model: "vision",
  ok: true,
  error: "",
  durationMs: 1234,
  cached: false,
  attachmentId: "sha256:abc",
  imageName: "a.png",
  source: "bridge",
  sessionId: "s1",
  attempt: 1,
  ...overrides,
});

test("文件存储：写入后可读回，落盘格式与 storageDomain 时代一致", async () => {
  await withStore(async (dir) => {
    const store = createFileStore({ dir });
    await store.put("1700000000000-abc", sample());
    const names = await readdir(dir);
    assert.deepEqual(names, ["1700000000000-abc.json"]);
    const raw = JSON.parse(await readFile(join(dir, "1700000000000-abc.json"), "utf8"));
    assert.equal(raw.version, 1);
    assert.equal(raw.record.model, "vision");

    const got = await store.get("1700000000000-abc");
    assert.equal(got.provider, "c2a");
    const rows = await store.entries();
    assert.equal(rows.length, 1);
    assert.equal(rows[0][0], "1700000000000-abc");
  });
});

test("文件存储：写到一半不留残骸（先写 .tmp 再 rename）", async () => {
  await withStore(async (dir) => {
    const store = createFileStore({ dir });
    await store.put("1700000000001-tmp", sample());
    // 成功后不应留下 .tmp 文件，且读目录只看到正式的 .json。
    const names = await readdir(dir);
    assert.deepEqual(names, ["1700000000001-tmp.json"]);
  });
});

test("文件存储：坏文件只跳过该条，不影响其他记录", async () => {
  await withStore(async (dir) => {
    const store = createFileStore({ dir });
    await store.put("1700000000002-ok1", sample({ model: "good" }));
    // 半截 JSON：模拟写到一半断电
    await writeFile(join(dir, "1700000000003-bad.json"), '{"version":1,"record":{"time":', "utf8");
    // 字段缺失：没有 time
    await writeFile(join(dir, "1700000000004-nokey.json"), JSON.stringify({ version: 1, record: { model: "x" } }), "utf8");

    const rows = await store.entries();
    assert.equal(rows.length, 1);
    assert.equal(rows[0][1].model, "good");
  });
});

test("文件存储：只读目录里的旧数据也能读到，且写只落到主目录", async () => {
  await withStore(async (dir) => {
    const legacy = await mkdtemp(join(tmpdir(), "avb-legacy-"));
    try {
      await writeFile(
        join(legacy, "1600000000000-old.json"),
        JSON.stringify({ version: 1, record: sample({ time: 1600000000000, model: "legacy" }) }),
        "utf8",
      );
      const store = createFileStore({ dir, readDirs: [legacy] });
      const rows = await store.entries();
      assert.equal(rows.length, 1);
      assert.equal(rows[0][1].model, "legacy");

      await store.put("1700000000005-new", sample({ model: "fresh" }));
      assert.deepEqual(await readdir(dir), ["1700000000005-new.json"]);
      assert.deepEqual(await readdir(legacy), ["1600000000000-old.json"]);
    } finally {
      await rm(legacy, { recursive: true, force: true });
    }
  });
});

test("文件存储：拒绝含路径成分的键，不会写到目录外", async () => {
  await withStore(async (dir) => {
    const store = createFileStore({ dir });
    await assert.rejects(() => store.put("../../etc/passwd", sample()), /非法记录键/);
    assert.equal(await store.get("../../etc/passwd"), undefined);
    assert.equal(await store.delete("../../etc/passwd"), false);
  });
});

test("文件存储：不存在的主目录被自动创建，删除返回是否真的删掉", async () => {
  await withStore(async (dir) => {
    const nested = join(dir, "deep", "history");
    const store = createFileStore({ dir: nested });
    await store.put("1700000000006-new", sample());
    assert.equal((await store.entries()).length, 1);
    assert.equal(await store.delete("1700000000006-new"), true);
    assert.equal(await store.delete("1700000000006-new"), false);
    assert.equal((await store.entries()).length, 0);
  });
});

test("目录常量指向插件自己的地盘，旧目录只读兼容", () => {
  assert.match(defaultHistoryDir(), /\/\.dsh\/auto-vision-bridge\/history$/);
  assert.match(legacyHistoryDir(), /\/\.dsh\/storages\/auto_vision_bridge\/events$/);
});
