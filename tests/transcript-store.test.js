import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DUMP_THRESHOLD,
  dumpDirOf,
  dumpThresholdOf,
  storeTranscript,
  summaryLengthOf,
} from "../lib/transcript-store.js";

test("未超过阈值时全文进上下文，不落盘", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avb-store-"));
  try {
    const text = "短转写内容";
    const result = await storeTranscript(text, { config: { dumpThreshold: 500, dumpDir: dir } });
    assert.equal(result.text, text);
    assert.equal(result.file, null);
    assert.equal(result.truncated, false);
    assert.equal(result.totalLength, text.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("超过阈值时截断成摘要，全文写进文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avb-store-"));
  try {
    const text = "长".repeat(1200);
    const result = await storeTranscript(text, {
      config: { dumpThreshold: 500, summaryLength: 100, dumpDir: dir },
      hint: "shot.png",
    });
    assert.equal(result.truncated, true);
    assert.ok(result.file, "应返回文件路径");
    assert.ok(result.file.startsWith(dir), "文件应落在配置的目录下");
    assert.match(result.file, /shot\.png-[0-9a-f]{16}\.md$/, "文件名应带提示与内容哈希");
    // 摘要进上下文，并带上全文路径。
    assert.match(result.text, /^长{50}/, "摘要开头应是前 50 字");
    // 摘要后面还会接落盘提示行，所以结尾用包含判断。
    assert.ok(result.text.includes("长".repeat(50)), "摘要应含后 50 字");
    assert.match(result.text, /中间已省略/, "应标明中间省略");
    assert.match(result.text, /转写全文过长，共 \d+ 字符，已存文件：/);
    assert.match(result.text, /直接读这个文件取全文/);
    assert.ok(result.text.includes(result.file), "摘要里应带文件路径");
    // 文件内容是全文。
    assert.equal(await readFile(result.file, "utf8"), text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("摘要保留开头与结尾：结论在末尾也不会被切掉", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avb-store-"));
  try {
    const text = `前面铺垫${"填".repeat(600)}唯一码是 AVBALPHA74261`;
    const result = await storeTranscript(text, {
      config: { dumpThreshold: 100, summaryLength: 100, dumpDir: dir },
    });
    assert.equal(result.truncated, true);
    assert.ok(result.text.includes("AVBALPHA74261"), "结尾的结论应保留在摘要里");
    assert.ok(result.text.includes("前面铺垫"), "开头的上下文应保留在摘要里");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("同一份转写重复落盘覆盖同一个文件，不堆文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avb-store-"));
  try {
    const text = "内容".repeat(400);
    const config = { dumpThreshold: 100, summaryLength: 50, dumpDir: dir };
    const first = await storeTranscript(text, { config, hint: "a.png" });
    const second = await storeTranscript(text, { config, hint: "a.png" });
    assert.equal(first.file, second.file);
    // 不同内容 → 不同文件。
    const other = await storeTranscript("别的".repeat(400), { config, hint: "a.png" });
    assert.notEqual(first.file, other.file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("落盘失败时退回全文进上下文，不连累识图结果", async () => {
  // 目录路径指向一个文件，写入必然失败。
  const result = await storeTranscript("长".repeat(1200), {
    config: { dumpThreshold: 100, summaryLength: 50, dumpDir: "/dev/null/impossible" },
  });
  assert.equal(result.truncated, false);
  assert.equal(result.file, null);
  assert.equal(result.text.length, 1200);
});

test("阈值设为 0 表示不截断，全文进上下文", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avb-store-"));
  try {
    const text = "长".repeat(1200);
    const result = await storeTranscript(text, { config: { dumpThreshold: 0, dumpDir: dir } });
    assert.equal(result.text, text);
    assert.equal(result.file, null);
    assert.equal(result.truncated, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("配置容错：非法值回落默认，合法值原样保留", () => {
  assert.equal(dumpThresholdOf({ dumpThreshold: 1000 }), 1000);
  assert.equal(dumpThresholdOf({ dumpThreshold: 0 }), 0);
  assert.equal(dumpThresholdOf({}), DEFAULT_DUMP_THRESHOLD);
  assert.equal(dumpThresholdOf({ dumpThreshold: -5 }), DEFAULT_DUMP_THRESHOLD);
  assert.equal(dumpThresholdOf({ dumpThreshold: "x" }), DEFAULT_DUMP_THRESHOLD);
  assert.equal(summaryLengthOf({ summaryLength: 50 }), 50);
  assert.equal(summaryLengthOf({ summaryLength: 0 }), 400);
  assert.equal(dumpDirOf({ dumpDir: "  " }).length > 0, true);
  assert.match(dumpDirOf({ dumpDir: "/tmp/custom" }), /custom$/);
});
