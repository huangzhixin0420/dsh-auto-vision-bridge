import test from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker, classifyFailure } from "../lib/breaker.js";

function breakerWith(config = {}) {
  return new CircuitBreaker(() => ({ failureThreshold: 3, cooldownMs: 60000, ...config }));
}

test("失败分类：限流与配额类归为可恢复", () => {
  assert.equal(classifyFailure(new Error("HTTP 429 too many requests")), "recoverable");
  assert.equal(classifyFailure(new Error("额度耗尽（窗口未知）")), "recoverable");
  assert.equal(classifyFailure(new Error("insufficient credits")), "recoverable");
  assert.equal(classifyFailure(new Error("视觉请求超时（60000ms）")), "recoverable");
  assert.equal(classifyFailure(new Error("socket hang up")), "recoverable");
});

test("失败分类：参数与鉴权类归为不可恢复", () => {
  assert.equal(classifyFailure(new Error("unsupported content type 'image_url'")), "unrecoverable");
  assert.equal(classifyFailure(new Error("unknown model: gpt-4o")), "unrecoverable");
  assert.equal(classifyFailure(new Error("no API key for provider route")), "unrecoverable");
});

test("失败分类：无法判断时归为未知", () => {
  assert.equal(classifyFailure(new Error("某个说不清的错误")), "unknown");
  assert.equal(classifyFailure(null), "unknown");
});

test("连续失败达到阈值后熔断，未达阈值不熔断", () => {
  const breaker = breakerWith({ failureThreshold: 3, cooldownMs: 60000 });
  assert.equal(breaker.isTripped("a"), false);
  breaker.recordFailure("a", "recoverable");
  assert.equal(breaker.isTripped("a"), false);
  breaker.recordFailure("a", "recoverable");
  assert.equal(breaker.isTripped("a"), false);
  breaker.recordFailure("a", "recoverable");
  assert.equal(breaker.isTripped("a"), true);
});

test("不可恢复的失败立刻熔断，不必等阈值", () => {
  const breaker = breakerWith({ failureThreshold: 3, cooldownMs: 60000 });
  breaker.recordFailure("a", "unrecoverable");
  assert.equal(breaker.isTripped("a"), true);
});

test("成功一次即清零计数并解除熔断", () => {
  const breaker = breakerWith({ failureThreshold: 2, cooldownMs: 60000 });
  breaker.recordFailure("a", "recoverable");
  breaker.recordFailure("a", "recoverable");
  assert.equal(breaker.isTripped("a"), true);
  breaker.recordSuccess("a");
  assert.equal(breaker.isTripped("a"), false);
  assert.equal(breaker.stateOf("a").failures, 0);
});

test("阈值设为 0 时不熔断", () => {
  const breaker = breakerWith({ failureThreshold: 0, cooldownMs: 60000 });
  breaker.recordFailure("a", "unrecoverable");
  breaker.recordFailure("a", "unrecoverable");
  assert.equal(breaker.isTripped("a"), false);
});

test("冷却结束后进入半开：允许探测，再次失败重新冷却", () => {
  const breaker = breakerWith({ failureThreshold: 1, cooldownMs: 50 });
  breaker.recordFailure("a", "recoverable");
  assert.equal(breaker.isTripped("a"), true);
  // 冷却未到期仍在熔断。
  assert.equal(breaker.isTripped("a", Date.now() + 10), true);
  // 冷却到期后放行一次探测。
  assert.equal(breaker.isTripped("a", Date.now() + 100), false);
  // 探测失败，重新冷却。
  breaker.recordFailure("a", "recoverable");
  assert.equal(breaker.isTripped("a"), true);
});

test("冷却时长逐次翻倍并封顶", () => {
  const breaker = breakerWith({ failureThreshold: 1, cooldownMs: 1000 });
  const base = Date.now();
  breaker.recordFailure("a", "recoverable");
  const first = breaker.remainingCooldown("a", base);
  assert.ok(first > 0 && first <= 1000);
  breaker.recordFailure("a", "recoverable");
  const second = breaker.remainingCooldown("a", base);
  assert.ok(second > first, `冷却应变长：${second} > ${first}`);
});

test("熔断状态按条目键隔离，互不影响", () => {
  const breaker = breakerWith({ failureThreshold: 1, cooldownMs: 60000 });
  breaker.recordFailure("a", "recoverable");
  assert.equal(breaker.isTripped("a"), true);
  assert.equal(breaker.isTripped("b"), false);
  assert.deepEqual(breaker.trippedKeys(), ["a"]);
});

test("reset 与 clear 清除熔断状态", () => {
  const breaker = breakerWith({ failureThreshold: 1, cooldownMs: 60000 });
  breaker.recordFailure("a", "recoverable");
  breaker.reset("a");
  assert.equal(breaker.isTripped("a"), false);
  breaker.recordFailure("b", "recoverable");
  breaker.clear();
  assert.deepEqual(breaker.trippedKeys(), []);
});
