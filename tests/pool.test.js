import test from "node:test";
import assert from "node:assert/strict";
import { PoolScheduler, poolEmptyMessage, poolEntryKey, resolvePool } from "../lib/pool.js";
import { testConfig } from "./helpers.js";

function poolEntry(overrides = {}) {
  return {
    provider: "c2a",
    model: "vision",
    maxConcurrent: 1,
    ...overrides,
  };
}

test("池为空时不派发，报错文案指向设置页", () => {
  const config = testConfig();
  const pool = resolvePool(config);
  assert.equal(pool.length, 0);
  assert.match(poolEmptyMessage(config), /模型池为空/);
});

test("池条目解析出 provider 与模型，并补齐并发上限", () => {
  const pool = resolvePool({
    ...testConfig(),
    pool: [
      poolEntry({ model: "vision" }),
      poolEntry({ model: "other" }),
    ],
  });
  assert.deepEqual(pool.map((item) => item.model), ["vision", "other"]);
  assert.deepEqual(pool.map((item) => item.provider), ["c2a", "c2a"]);
  assert.deepEqual(pool.map((item) => item.maxConcurrent), [1, 1]);
  assert.equal(pool[0].key, poolEntryKey({ provider: "c2a", model: "vision" }));
});

test("缺 provider 或 model 的条目不参与派发", () => {
  const pool = resolvePool({
    ...testConfig(),
    pool: [
      poolEntry({ provider: "" }),
      poolEntry({ model: "" }),
      poolEntry({ provider: "  ", model: "x" }),
      poolEntry({ provider: "c2a", model: "ok" }),
    ],
  });
  assert.equal(pool.length, 1);
  assert.equal(pool[0].model, "ok");
});

test("重复的 provider+model 只保留第一个", () => {
  const pool = resolvePool({
    ...testConfig(),
    pool: [
      poolEntry({ model: "vision", maxConcurrent: 1 }),
      poolEntry({ model: "vision", maxConcurrent: 5 }),
    ],
  });
  assert.equal(pool.length, 1);
  assert.equal(pool[0].maxConcurrent, 1);
});

test("条目并发上限非法时按 1 处理", () => {
  const pool = resolvePool({
    ...testConfig(),
    pool: [
      poolEntry({ model: "a", maxConcurrent: 0 }),
      poolEntry({ model: "b", maxConcurrent: "x" }),
      poolEntry({ model: "c", maxConcurrent: 3 }),
    ],
  });
  assert.deepEqual(pool.map((item) => item.maxConcurrent), [1, 1, 3]);
});

test("池里条目都不完整时报错文案指向条目本身", () => {
  const config = testConfig({ pool: [poolEntry({ provider: "" })] });
  assert.equal(resolvePool(config).length, 0);
  assert.match(poolEmptyMessage(config), /没有可用条目/);
});

test("调度器按轮转派发，单条目并发上限满后跳到下一个", async () => {
  const pool = resolvePool({
    ...testConfig(),
    pool: [
      poolEntry({ model: "a", maxConcurrent: 1 }),
      poolEntry({ model: "b", maxConcurrent: 1 }),
    ],
  });
  const scheduler = new PoolScheduler(() => pool);
  const first = await scheduler.acquire();
  const second = await scheduler.acquire();
  assert.notEqual(first.index, second.index);
  assert.equal(scheduler.totalUsage(), 2);

  // 全部满载时排队等待，释放后立刻唤醒。
  const waiting = scheduler.acquire();
  let settled = false;
  waiting.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  scheduler.release(first.index);
  const resumed = await waiting;
  assert.equal(resumed.index, first.index);
  scheduler.release(second.index);
  scheduler.release(resumed.index);
});

test("全局并发上限会拦住在途总数，超出的请求排队", async () => {
  const pool = resolvePool({
    ...testConfig(),
    pool: [poolEntry({ model: "a", maxConcurrent: 5 })],
  });
  const scheduler = new PoolScheduler(() => pool, () => 1);
  const first = await scheduler.acquire();
  assert.ok(first);
  const waiting = scheduler.acquire();
  let settled = false;
  waiting.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  scheduler.release(first.index);
  await waiting;
});

test("等待中的请求被取消时立即失败，不占用条目", async () => {
  const pool = resolvePool({
    ...testConfig(),
    pool: [poolEntry({ model: "a", maxConcurrent: 1 })],
  });
  const scheduler = new PoolScheduler(() => pool);
  const held = await scheduler.acquire();
  const controller = new AbortController();
  const waiting = scheduler.acquire(controller.signal);
  controller.abort();
  await assert.rejects(waiting, /已取消/);
  scheduler.release(held.index);
});

test("池条目的优先级归一：非法值回落为 1，合法值原样保留", () => {
  const pool = resolvePool({
    ...testConfig(),
    pool: [
      poolEntry({ model: "a", priority: 3 }),
      poolEntry({ model: "b", priority: 0 }),
      poolEntry({ model: "c", priority: -2 }),
      poolEntry({ model: "d", priority: 2.7 }),
      poolEntry({ model: "e", priority: "2" }),
      poolEntry({ model: "f", priority: Number.NaN }),
      poolEntry({ model: "g", priority: Number.POSITIVE_INFINITY }),
      poolEntry({ model: "h" }),
    ],
  });
  // priority 只认 >= 1 的有限整数：不 floor 小数、不转换数字字符串，
  // 半合法值直接回落，避免悄悄改变分层顺序。
  assert.deepEqual(pool.map((item) => item.priority), [3, 1, 1, 1, 1, 1, 1, 1]);
});

test("分层派发：优先级数字更小的条目先被选中", async () => {
  const pool = resolvePool({
    ...testConfig(),
    pool: [
      poolEntry({ model: "low", priority: 3, maxConcurrent: 5 }),
      poolEntry({ model: "high", priority: 1, maxConcurrent: 5 }),
      poolEntry({ model: "mid", priority: 2, maxConcurrent: 5 }),
    ],
  });
  const scheduler = new PoolScheduler(() => pool);
  const first = await scheduler.acquire();
  const second = await scheduler.acquire();
  assert.equal(first.model, "high");
  assert.equal(second.model, "high");
  scheduler.release(first.index);
  scheduler.release(second.index);
});

test("分层派发：高优先级层满载后降级到下一层", async () => {
  const pool = resolvePool({
    ...testConfig(),
    pool: [
      poolEntry({ model: "high", priority: 1, maxConcurrent: 1 }),
      poolEntry({ model: "mid", priority: 2, maxConcurrent: 1 }),
      poolEntry({ model: "low", priority: 3, maxConcurrent: 1 }),
    ],
  });
  const scheduler = new PoolScheduler(() => pool);
  const first = await scheduler.acquire();
  assert.equal(first.model, "high");
  const second = await scheduler.acquire();
  assert.equal(second.model, "mid");
  const third = await scheduler.acquire();
  assert.equal(third.model, "low");
  // 所有层都满载时返回 undefined，调用方排队等待。
  assert.equal(scheduler.pick(), undefined);
  scheduler.release(first.index);
  scheduler.release(second.index);
  scheduler.release(third.index);
});

test("分层派发：同层内仍按轮转分单，不因分层改变节奏", async () => {
  const pool = resolvePool({
    ...testConfig(),
    pool: [
      poolEntry({ model: "a", priority: 1, maxConcurrent: 2 }),
      poolEntry({ model: "b", priority: 1, maxConcurrent: 2 }),
    ],
  });
  const scheduler = new PoolScheduler(() => pool);
  const first = await scheduler.acquire();
  const second = await scheduler.acquire();
  assert.deepEqual([first.model, second.model], ["a", "b"]);
  scheduler.release(first.index);
  scheduler.release(second.index);
});

test("分层派发：优先级相同时行为与纯轮转一致", async () => {
  const pool = resolvePool({
    ...testConfig(),
    pool: [
      poolEntry({ model: "a", maxConcurrent: 1 }),
      poolEntry({ model: "b", maxConcurrent: 1 }),
      poolEntry({ model: "c", maxConcurrent: 1 }),
    ],
  });
  const scheduler = new PoolScheduler(() => pool);
  const picked = [];
  for (let i = 0; i < 3; i += 1) {
    const entry = await scheduler.acquire();
    picked.push(entry.model);
    scheduler.release(entry.index);
  }
  assert.deepEqual(picked, ["a", "b", "c"]);
});

test("分层派发：全部条目显式配置同一优先级时仍是纯轮转", async () => {
  const pool = resolvePool({
    ...testConfig(),
    pool: [
      poolEntry({ model: "a", priority: 2, maxConcurrent: 1 }),
      poolEntry({ model: "b", priority: 2, maxConcurrent: 1 }),
      poolEntry({ model: "c", priority: 2, maxConcurrent: 1 }),
    ],
  });
  const scheduler = new PoolScheduler(() => pool);
  const picked = [];
  for (let i = 0; i < 3; i += 1) {
    const entry = await scheduler.acquire();
    picked.push(entry.model);
    scheduler.release(entry.index);
  }
  assert.deepEqual(picked, ["a", "b", "c"]);
});

test("分层派发：高优先级条目释放后，后续派发回到高优先级层", async () => {
  const pool = resolvePool({
    ...testConfig(),
    pool: [
      poolEntry({ model: "high", priority: 1, maxConcurrent: 1 }),
      poolEntry({ model: "low", priority: 2, maxConcurrent: 1 }),
    ],
  });
  const scheduler = new PoolScheduler(() => pool);
  const first = await scheduler.acquire();
  assert.equal(first.model, "high");
  const second = await scheduler.acquire();
  assert.equal(second.model, "low");
  scheduler.release(first.index);
  const third = await scheduler.acquire();
  assert.equal(third.model, "high");
  scheduler.release(second.index);
  scheduler.release(third.index);
});
