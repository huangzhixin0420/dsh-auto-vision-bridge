import test from "node:test";
import assert from "node:assert/strict";
import { VisionHistory, historyKey } from "../lib/history.js";
import { retentionDaysOf } from "../lib/runtime.js";

/** 可控的假表：记录 put/delete/deleteMany 调用。 */
function fakeTable(rows = []) {
  const map = new Map(rows);
  const calls = { put: [], delete: [], deleteMany: [] };
  return {
    map,
    calls,
    async put(key, value) { calls.put.push([key, value]); map.set(key, value); },
    async get(key) { return map.get(key); },
    entries() { return map.entries(); },
    async delete(key) { calls.delete.push(key); return map.delete(key); },
    async deleteMany(keys) {
      calls.deleteMany.push([...keys]);
      let count = 0;
      for (const key of keys) if (map.delete(key)) count += 1;
      return count;
    },
  };
}

/** 一条记录。 */
function record(overrides = {}) {
  return {
    provider: "c2a",
    model: "vision",
    ok: true,
    error: "",
    durationMs: 1200,
    cached: false,
    attachmentId: "sha256:abc",
    imageName: "shot.png",
    source: "bridge",
    sessionId: "session-1",
    attempt: 1,
    ...overrides,
  };
}

test("记录落盘带全部字段，时间戳由账本补齐", async () => {
  const table = fakeTable();
  const history = new VisionHistory({ store: table, now: () => 1000, random: () => "aaa" });
  await history.record(record());
  assert.equal(table.calls.put.length, 1);
  const [key, value] = table.calls.put[0];
  assert.equal(key, "1000-aaa");
  assert.equal(value.time, 1000);
  assert.equal(value.provider, "c2a");
  assert.equal(value.model, "vision");
  assert.equal(value.ok, true);
  assert.equal(value.durationMs, 1200);
  assert.equal(value.cached, false);
  assert.equal(value.attachmentId, "sha256:abc");
  assert.equal(value.imageName, "shot.png");
  assert.equal(value.source, "bridge");
  assert.equal(value.sessionId, "session-1");
  assert.equal(value.attempt, 1);
});

test("失败记录也落盘，带失败原因", async () => {
  const table = fakeTable();
  const history = new VisionHistory({ store: table, now: () => 1, random: () => "b" });
  await history.record(record({ ok: false, error: "视觉请求超时（60000ms）", provider: "", model: "" }));
  const [, value] = table.calls.put[0];
  assert.equal(value.ok, false);
  assert.equal(value.error, "视觉请求超时（60000ms）");
  assert.equal(value.provider, "");
});

test("写失败只记日志，不抛给调用方", async () => {
  const table = fakeTable();
  table.put = async () => { throw new Error("磁盘满了"); };
  const history = new VisionHistory({ store: table, now: () => 1, random: () => "c" });
  const warnings = [];
  await history.record(record(), { warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /识图历史写入失败/);
});

test("列表按时间倒序，可限量", async () => {
  const table = fakeTable([
    ["k1", { time: 100, ok: true }],
    ["k2", { time: 300, ok: true }],
    ["k3", { time: 200, ok: true }],
  ]);
  const history = new VisionHistory({ store: table });
  const all = await history.list();
  assert.deepEqual(all.map((r) => r.time), [300, 200, 100]);
  const limited = await history.list(2);
  assert.deepEqual(limited.map((r) => r.time), [300, 200]);
});

test("清理按时间删除过期记录", async () => {
  const now = 1_800_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  const table = fakeTable([
    ["old1", { time: now - 3 * day, ok: true }],
    ["old2", { time: now - 2 * day, ok: true }],
    ["fresh", { time: now - 1000, ok: true }],
  ]);
  const history = new VisionHistory({ store: table, now: () => now });
  const removed = await history.prune(1);
  assert.equal(removed, 2);
  assert.deepEqual(table.calls.deleteMany[0].sort(), ["old1", "old2"]);
  assert.equal(table.map.has("fresh"), true);
});

test("保留天数为 0 时不清理", async () => {
  const table = fakeTable([["k", { time: 1, ok: true }]]);
  const history = new VisionHistory({ store: table, now: () => 10_000_000 });
  assert.equal(await history.prune(0), 0);
  assert.equal(table.calls.deleteMany.length, 0);
});

test("汇总统计：成功率、平均耗时、缓存命中与模型分布", () => {
  const summary = VisionHistory.summarize([
    { provider: "c2a", model: "vision", ok: true, cached: false, durationMs: 1000 },
    { provider: "c2a", model: "vision", ok: true, cached: false, durationMs: 3000 },
    { provider: "c2a", model: "vision", ok: false, cached: false, durationMs: 500 },
    { provider: "other", model: "vl", ok: true, cached: true, durationMs: 0 },
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.ok, 3);
  assert.equal(summary.failed, 1);
  assert.equal(summary.cached, 1);
  assert.equal(summary.successRate, 0.75);
  assert.equal(summary.cacheRate, 0.25);
  // 平均耗时只算成功的真实调用（缓存命中不计入）。
  assert.equal(summary.avgDurationMs, 2000);
  assert.equal(summary.models.length, 2);
  assert.equal(summary.models[0].provider, "c2a");
  assert.equal(summary.models[0].total, 3);
  assert.equal(summary.models[0].failed, 1);
});

test("空数据汇总不除零", () => {
  const summary = VisionHistory.summarize([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.successRate, 0);
  assert.equal(summary.avgDurationMs, 0);
  assert.deepEqual(summary.models, []);
});

test("保留天数读取：非法值退回默认，0 表示不清理", () => {
  assert.equal(retentionDaysOf({ historyRetentionDays: 3 }), 3);
  assert.equal(retentionDaysOf({ historyRetentionDays: 0 }), 0);
  assert.equal(retentionDaysOf({ historyRetentionDays: -1 }), 7);
  assert.equal(retentionDaysOf({ historyRetentionDays: "abc" }), 7);
  assert.equal(retentionDaysOf({}), 7);
});

test("记录键含时间戳与随机后缀，避免同毫秒并发撞键", () => {
  assert.equal(historyKey(100, "aaa"), "100-aaa");
  assert.notEqual(historyKey(100, "aaa"), historyKey(100, "bbb"));
});
