/**
 * 识图模型池：把多个「DSH 模型目录里的视觉模型」组成池，按并发占用均衡派发。
 *
 * 池条目结构（与设置页数组字段一一对应）：
 *   { provider, model, maxConcurrent, priority }
 *
 * - provider/model 直接取自 DSH 的实时模型目录（ctx.remote.session.modelCatalog）。
 *   插件不经手 baseURL 与凭据：识别请求走 DSH 自己的 llm 通道。
 * - 缺 provider 或 model 的条目不参与派发。
 * - maxConcurrent 缺省为 1；小于 1 按 1 处理，避免池被配置成不可用。
 * - priority 缺省为 1，数字越小越优先；只认 >= 1 的有限整数，
 *   其余（0、负数、小数、数字字符串、NaN、Infinity）一律回落为 1。
 * - 派发先按 priority 分层：优先用高优先级层的条目，该层满载才降级到下一层；
 *   同层内按轮转挑选未满的条目。全部层满载时排队等待，空出位置后先来先服务唤醒。
 */

const DEFAULT_MAX_CONCURRENT = 1;
/** 默认优先级：所有条目同级，等价于纯轮转。 */
const DEFAULT_PRIORITY = 1;

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}

/**
 * 优先级比 maxConcurrent 更严格：只认 >= 1 的有限整数，不做宽容转换
 * （floor 会把 2.7 变成 2，Number 会把 "2" 变成 2）。半合法值一旦参与
 * 分层，派发顺序会随层的划分悄悄漂移，比回落到默认层更难排查。
 */
function priorityInteger(value, fallback) {
  if (!Number.isInteger(value) || value < 1) return fallback;
  return value;
}

/** 条目名只用于界面展示与日志，派发不依赖唯一性。 */
export function poolEntryName(entry, index) {
  const model = typeof entry?.model === "string" ? entry.model.trim() : "";
  if (model) return model;
  const provider = typeof entry?.provider === "string" ? entry.provider.trim() : "";
  if (provider) return provider;
  return `视觉模型 ${index + 1}`;
}

/** 条目路由键：同一 provider 下的同一模型视为同一条目。 */
export function poolEntryKey(entry) {
  const provider = typeof entry?.provider === "string" ? entry.provider.trim() : "";
  const model = typeof entry?.model === "string" ? entry.model.trim() : "";
  return `${provider}${model}`;
}

/**
 * 从配置里解析出可派发的池。
 * 缺 provider 或 model 的条目被剔除；重复的 provider+model 只留第一个。
 */
export function resolvePool(config) {
  const raw = Array.isArray(config?.pool) ? config.pool : [];
  const entries = [];
  const seen = new Set();
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
    const model = typeof entry.model === "string" ? entry.model.trim() : "";
    if (!provider || !model) return;
    const key = poolEntryKey(entry);
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({
      index,
      key,
      name: poolEntryName(entry, index),
      provider,
      model,
      maxConcurrent: positiveInteger(entry.maxConcurrent, DEFAULT_MAX_CONCURRENT),
      priority: priorityInteger(entry.priority, DEFAULT_PRIORITY),
    });
  });
  return entries;
}

/** 池不可用时的报错文案：区分「没配池」和「配了但条目不完整」。 */
export function poolEmptyMessage(config) {
  const raw = Array.isArray(config?.pool) ? config.pool : [];
  if (raw.length === 0) return "识图模型池为空：请在设置里至少选择一个视觉模型。";
  return "识图模型池没有可用条目：每个条目都需要选定提供方与模型。";
}

/**
 * 池调度器：维护每个条目的在途数量，派发时挑未满的条目；
 * 全部满载时排队等待，空出位置后按先来先服务唤醒。
 *
 * getLimit 返回全局并发上限（多图并发的总闸门）。
 */
export class PoolScheduler {
  /**
   * @param {() => Array} getPool - 取当前池配置。
   * @param {() => number} [getLimit] - 全局并发上限。
   * @param {object} [breaker] - 熔断器，提供 isTripped(key) 判断条目是否该跳过。
   */
  constructor(getPool, getLimit = null, breaker = null) {
    this.getPool = getPool;
    this.getLimit = getLimit;
    this.breaker = breaker;
    this.inflight = new Map();
    this.waiters = [];
    this.cursor = 0;
  }

  /** 条目当前是否处于熔断冷却中。 */
  isTripped(entry) {
    if (!this.breaker || typeof this.breaker.isTripped !== "function") return false;
    try {
      return this.breaker.isTripped(entry.key) === true;
    } catch {
      return false;
    }
  }

  /** 当前条目在途数量。 */
  usage(index) {
    return this.inflight.get(index) ?? 0;
  }

  /** 全局在途数量。 */
  totalUsage() {
    let total = 0;
    for (const value of this.inflight.values()) total += value;
    return total;
  }

  /**
   * 找一个未满的条目；全部满载时返回 undefined。
   *
   * 分层派发：按 priority 从小到大逐层检查，高优先级层有可用条目就用它，
   * 该层全部满载才降级到下一层。层内仍按游标轮转，轮转节奏与纯轮转一致。
   */
  pick() {
    const pool = this.getPool();
    if (pool.length === 0) return undefined;
    const limit = Number(this.getLimit?.());
    if (Number.isFinite(limit) && limit >= 1 && this.totalUsage() >= limit) return undefined;

    // 收集池里出现过的优先级并升序排列；数字越小越优先。
    const levels = [];
    for (let i = 0; i < pool.length; i += 1) {
      const priority = pool[i].priority ?? DEFAULT_PRIORITY;
      if (!levels.includes(priority)) levels.push(priority);
    }
    levels.sort((a, b) => a - b);

    for (const priority of levels) {
      const best = this.pickWithin(priority, pool);
      if (!best) continue;
      this.inflight.set(best.index, this.usage(best.index) + 1);
      return best;
    }
    return undefined;
  }

  /**
   * 在某一优先级层里按游标轮转挑一个未满的条目。
   *
   * 扫描从游标位置起绕整池一圈，只看属于该层的条目：这样层内轮转的起点
   * 与全局轮转一致，不会因为分层而改变原有的分单节奏。比较时对 priority
   * 做与 pick() 划层相同的缺省兜底，两条路径口径一致才不会漏选条目。
   */
  pickWithin(priority, pool) {
    for (let step = 0; step < pool.length; step += 1) {
      const entry = pool[(this.cursor + step) % pool.length];
      if ((entry.priority ?? DEFAULT_PRIORITY) !== priority) continue;
      if (this.usage(entry.index) >= entry.maxConcurrent) continue;
      // 熔断冷却中的条目直接跳过，不占用它的并发名额。
      if (this.isTripped(entry)) continue;
      this.cursor = (this.cursor + step + 1) % pool.length;
      return entry;
    }
    return undefined;
  }

  /**
   * 池里是否所有条目都处于熔断冷却中。
   *
   * 全部熔断时不该无限排队：调用方应立刻拿到明确失败，而不是干等到超时。
   */
  allTripped() {
    const pool = this.getPool();
    if (pool.length === 0) return false;
    return pool.every((entry) => this.isTripped(entry));
  }

  /**
   * 占用一个条目；池为空时返回 undefined（调用方给出准确原因），
   * 池非空但全部满载时排队等待。
   */
  acquire(signal) {
    const entry = this.pick();
    if (entry) return Promise.resolve(entry);
    if (this.getPool().length === 0) return Promise.resolve(undefined);
    // 全部条目都在冷却：立刻失败，错误文案说明是熔断而不是排队。
    if (this.allTripped()) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, settled: false };
      waiter.cancel = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("视觉请求已取消"));
      };
      if (signal) {
        if (signal.aborted) {
          waiter.cancel();
          return;
        }
        signal.addEventListener("abort", waiter.cancel, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /** 释放占用并唤醒等待者。 */
  release(index) {
    const current = this.usage(index);
    if (current <= 1) this.inflight.delete(index);
    else this.inflight.set(index, current - 1);
    this.drain();
  }

  drain() {
    while (this.waiters.length > 0) {
      if (this.allTripped()) {
        // 全池熔断：排队等待已无意义，唤醒并让调用方拿到明确失败。
        const waiters = this.waiters.splice(0, this.waiters.length);
        for (const waiter of waiters) {
          waiter.settled = true;
          waiter.reject(new Error("识图模型池全部处于熔断冷却中"));
        }
        return;
      }
      const entry = this.pick();
      if (!entry) return;
      const waiter = this.waiters.shift();
      if (!waiter || waiter.settled) continue;
      waiter.settled = true;
      waiter.resolve(entry);
    }
  }

  clear() {
    this.inflight.clear();
    this.waiters = [];
    this.cursor = 0;
  }
}
