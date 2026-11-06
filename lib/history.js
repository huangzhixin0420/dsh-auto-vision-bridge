// 识图历史账本：每张图一条记录，落盘到 DSH 的 storageDomain。
//
// 为什么用 storageDomain 而不是自己写 JSONL：
//   DSH 官方的 dsh-schedule 就是这个机制（~/.dsh/storages/schedule.json 同款），
//   自带原子写（临时文件 + fsync + rename）、坏记录隔离与版本兼容。
//   域名字母只允许 [a-z][a-z0-9_]*，所以用下划线而不是插件名的连字符。
//
// 为什么每张图一条而不是每条消息一条：
//   用户要能看出「哪张图用了哪个模型」。多图并发时每张图的耗时、结果、
//   实际命中的模型都可能不同，聚合到消息级会丢掉这些信息。
//
// 记录里存 sessionId 而不是标题：识图发生在 pre-step，此刻标题多半还没生成
// （标题是 DSH 事后用模型生成的），取数响应时再按 sessionId 解析最新标题，
// 标题因此总是最新的，也不会把标题复制进每条记录。

import z from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";

/** 域名字面量：storageDomain 的名字必须匹配 /^[a-z][a-z0-9_]*$/。 */
export const HISTORY_DOMAIN_NAME = "auto_vision_bridge";

/** 记录表名。 */
export const HISTORY_TABLE = "events";

/** 默认保留天数。 */
export const DEFAULT_RETENTION_DAYS = 7;

/**
 * 一条识图记录的落盘形状。
 *
 * 时间用毫秒时间戳（number）：清理过期记录时要跟 Date.now() 比大小，
 * 字符串时间戳比大小不可靠。
 */
const historyRecordSchema = z.object({
  /** 毫秒时间戳。 */
  time: z.number(),
  /** 实际派发的 provider。 */
  provider: z.string(),
  /** 实际派发的模型。 */
  model: z.string(),
  /** 是否成功。 */
  ok: z.boolean(),
  /** 失败原因（已脱敏）；成功时为空串。 */
  error: z.string().default(""),
  /** 本次识图耗时（毫秒）。 */
  durationMs: z.number(),
  /** 是否命中缓存（命中则没有真正调用模型）。 */
  cached: z.boolean(),
  /** 图片的 attachmentId；没有时为空串。 */
  attachmentId: z.string().default(""),
  /** 图片文件名；没有时为空串。 */
  imageName: z.string().default(""),
  /** 来源：bridge=自动桥接，inspect=inspect_image 工具。 */
  source: z.string(),
  /** 所属会话 id。 */
  sessionId: z.string().default(""),
  /** 第几次尝试（1 起）。 */
  attempt: z.number().default(1),
});

/** storageDomain 的域声明。 */
export const historyDomainSpec = defineDomain({
  name: HISTORY_DOMAIN_NAME,
  version: 1,
  layout: "per-record",
  tables: {
    [HISTORY_TABLE]: domainTable(historyRecordSchema),
  },
});

/**
 * 记录键：时间戳 + 随机后缀。
 *
 * 同一毫秒内可能有多条记录（多图并发），所以要加随机后缀避免撞键。
 * 键里带时间戳，天然按时间有序，便于清理时找区间。
 */
export function historyKey(time, suffix) {
  return `${time}-${suffix}`;
}

/** 生成一个短随机后缀。 */
function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * 识图历史账本。
 *
 * 对外只暴露记录与查询；落盘细节（域、键、清理）都在这里收口。
 */
export class VisionHistory {
  /**
   * @param {object} options - 选项。
   * @param {object} options.table - storageDomain 的表实例。
   * @param {() => number} options.now - 取当前时间（便于测试注入）。
   * @param {() => number} options.random - 取随机后缀（便于测试注入）。
   */
  constructor({ table, now = () => Date.now(), random = randomSuffix } = {}) {
    this.table = table;
    this.now = now;
    this.random = random;
    /** 写队列：storageDomain 的写是异步的，串起来避免并发写乱序。 */
    this.pending = Promise.resolve();
  }

  /**
   * 记一条识图记录。
   *
   * 写失败只记日志，绝不把错误抛给识图链路 —— 历史记录是旁路，
   * 不能因为它失败而让用户的识图失败。
   *
   * @param {object} record - 记录内容。
   * @param {string} [record.logger] - 可选的 logger。
   * @returns {Promise<void>} 落盘完成（或失败被吞掉）。
   */
  async record(record, logger) {
    if (!this.table) return;
    const time = typeof record.time === "number" ? record.time : this.now();
    const key = historyKey(time, this.random());
    const value = {
      time,
      provider: String(record.provider ?? ""),
      model: String(record.model ?? ""),
      ok: record.ok === true,
      error: String(record.error ?? ""),
      durationMs: Number.isFinite(record.durationMs) ? record.durationMs : 0,
      cached: record.cached === true,
      attachmentId: String(record.attachmentId ?? ""),
      imageName: String(record.imageName ?? ""),
      source: String(record.source ?? "bridge"),
      sessionId: String(record.sessionId ?? ""),
      attempt: Number.isFinite(record.attempt) ? record.attempt : 1,
    };
    this.pending = this.pending.then(async () => {
      try {
        await this.table.put(key, value);
      } catch (error) {
        logger?.warn?.(`[auto-vision-bridge] 识图历史写入失败：${error?.message ?? error}`);
      }
    });
    await this.pending;
  }

  /**
   * 读全部记录，按时间倒序（新的在前）。
   *
   * @param {number} [limit] - 最多返回多少条。
   * @returns {Promise<object[]>} 记录数组。
   */
  async list(limit) {
    if (!this.table) return [];
    const rows = [];
    try {
      for (const [, value] of this.table.entries()) {
        if (value && typeof value === "object") rows.push(value);
      }
    } catch (error) {
      return [];
    }
    rows.sort((left, right) => (right.time ?? 0) - (left.time ?? 0));
    return Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;
  }

  /**
   * 清理过期记录。
   *
   * @param {number} retentionDays - 保留天数；小于等于 0 表示不清理。
   * @returns {Promise<number>} 删掉的条数。
   */
  async prune(retentionDays) {
    if (!this.table || !(retentionDays > 0)) return 0;
    const cutoff = this.now() - retentionDays * 24 * 60 * 60 * 1000;
    const expired = [];
    try {
      for (const [key, value] of this.table.entries()) {
        if (!value || typeof value.time !== "number") continue;
        if (value.time < cutoff) expired.push(key);
      }
      if (expired.length === 0) return 0;
      return await this.table.deleteMany(expired);
    } catch (error) {
      return 0;
    }
  }

  /**
   * 汇总统计。
   *
   * @param {object[]} records - 记录数组。
   * @returns {object} 汇总结果。
   */
  static summarize(records) {
    const rows = Array.isArray(records) ? records : [];
    let ok = 0;
    let cached = 0;
    let durationTotal = 0;
    let durationCount = 0;
    const byModel = new Map();
    for (const row of rows) {
      if (row.ok) ok += 1;
      if (row.cached) cached += 1;
      if (row.ok && !row.cached && Number.isFinite(row.durationMs)) {
        durationTotal += row.durationMs;
        durationCount += 1;
      }
      const key = `${row.provider ?? ""}/${row.model ?? ""}`;
      const bucket = byModel.get(key) ?? { provider: row.provider ?? "", model: row.model ?? "", total: 0, failed: 0 };
      bucket.total += 1;
      if (!row.ok) bucket.failed += 1;
      byModel.set(key, bucket);
    }
    return {
      total: rows.length,
      ok,
      failed: rows.length - ok,
      cached,
      successRate: rows.length === 0 ? 0 : ok / rows.length,
      cacheRate: rows.length === 0 ? 0 : cached / rows.length,
      avgDurationMs: durationCount === 0 ? 0 : Math.round(durationTotal / durationCount),
      models: [...byModel.values()].sort((left, right) => right.total - left.total),
    };
  }
}
