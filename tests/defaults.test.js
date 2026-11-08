import test from "node:test";
import assert from "node:assert/strict";
import { Config, resolveConfig } from "../index.js";
import { DEFAULT_PROMPT } from "../lib/vision-client.js";
import {
  DEFAULT_DUMP_THRESHOLD,
  DEFAULT_SUMMARY_LENGTH,
  dumpThresholdOf,
  summaryLengthOf,
} from "../lib/transcript-store.js";

/**
 * 默认值这一层最容易静默失效：改了 schema 里的 .default()，看着像改了，
 * 运行时却根本没套上。这一组测试把「默认值必须真的到达运行时」锁住。
 */

test("volatile schema 不填默认值——所以运行时必须走 resolveConfig", () => {
  // 这是本插件所有默认值问题的根源，写成测试免得以后有人把 resolveConfig 拆掉。
  assert.equal(Config({}).timeoutMs, undefined, "volatile 调用拿不到默认值");
  const resolved = resolveConfig({});
  assert.equal(resolved.timeoutMs, 180000);
});

test("resolveConfig({}) 给出完整的运行期默认值", () => {
  const config = resolveConfig({});
  // 视觉请求实测成功耗时 15.5s–117.2s，60s 会稳定卡掉大图。
  assert.equal(config.timeoutMs, 180000);
  // 视觉失败以超时为主，重试一次常能过。
  assert.equal(config.retries, 1);
  assert.equal(config.retryDelayMs, 500);
  assert.equal(config.maxConcurrent, 6);
  // 一张手机截图转写实测 2000–3000 字符；阈值 500 会把每张图都截成摘要。
  assert.equal(config.dumpThreshold, DEFAULT_DUMP_THRESHOLD);
  assert.equal(config.summaryLength, DEFAULT_SUMMARY_LENGTH);
  assert.ok(DEFAULT_DUMP_THRESHOLD >= 4000, "阈值必须容得下一张普通截图的全量转写");
  assert.ok(DEFAULT_SUMMARY_LENGTH >= 2000);
  assert.equal(config.failureThreshold, 3);
  assert.equal(config.cooldownMs, 60000);
  assert.equal(config.enabled, true);
  assert.equal(config.prompt, DEFAULT_PROMPT);
  assert.deepEqual(config.pool, []);
  assert.equal(config.providerBridge, undefined, "桥接默认关闭");
});

test("显式配置优先，未配的字段才补默认", () => {
  const config = resolveConfig({
    timeoutMs: 300000,
    dumpThreshold: 5000,
    retries: 0,
    pool: [{ provider: "c2a", model: "vision", priority: 1, maxConcurrent: 6 }],
  });
  assert.equal(config.timeoutMs, 300000);
  assert.equal(config.dumpThreshold, 5000);
  assert.equal(config.retries, 0, "显式 0 不能被默认值顶掉");
  assert.equal(config.summaryLength, DEFAULT_SUMMARY_LENGTH, "未配的字段仍补默认");
  assert.equal(config.pool.length, 1);
  assert.equal(config.pool[0].maxConcurrent, 6);
  assert.equal(config.pool[0].priority, 1);
});

test("池条目的子字段也有默认值", () => {
  const config = resolveConfig({ pool: [{ provider: "c2a", model: "vision" }] });
  assert.equal(config.pool[0].maxConcurrent, 1);
  assert.equal(config.pool[0].priority, 1);
});

test("落盘阈值与摘要有兜底，非法值不污染运行时", () => {
  assert.equal(dumpThresholdOf({}), DEFAULT_DUMP_THRESHOLD);
  assert.equal(dumpThresholdOf({ dumpThreshold: -1 }), DEFAULT_DUMP_THRESHOLD);
  assert.equal(dumpThresholdOf({ dumpThreshold: "abc" }), DEFAULT_DUMP_THRESHOLD);
  assert.equal(summaryLengthOf({}), DEFAULT_SUMMARY_LENGTH);
  assert.equal(summaryLengthOf({ summaryLength: 0 }), DEFAULT_SUMMARY_LENGTH);
});

test("默认提示词要求结构化转写、禁止复述任务、末尾给摘要", () => {
  // 复述任务的开头会被 stripModelPrelude 剥掉，等于白花 token。
  assert.match(DEFAULT_PROMPT, /不要复述任务/);
  // 表格不还原成表格，模型读到的行列关系就丢了。
  assert.match(DEFAULT_PROMPT, /Markdown 表格/);
  // 数字被「换算」「补零」过就不可引用。
  assert.match(DEFAULT_PROMPT, /原样照抄/);
  // 不确定就得标出来，不能让模型猜。
  assert.match(DEFAULT_PROMPT, /\[\?\]/);
  // 摘要落在末尾 —— 转写超阈值时摘要保留头尾，末尾这条正好保住。
  assert.match(DEFAULT_PROMPT, /摘要：/);
  assert.ok(DEFAULT_PROMPT.length < 500, "提示词别长到喧宾夺主");
});
