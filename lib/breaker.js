/**
 * 模型级熔断：某个视觉模型连续失败到阈值后，临时把它从派发里摘掉。
 *
 * 分两类失败：
 * - 可恢复（限流、配额耗尽、5xx、网络抖动）：计入连续失败计数，
 *   到阈值就进入冷却，冷却期内不再派发给它。
 * - 不可恢复（参数错误、鉴权失败、空响应）：立刻让这个模型退出派发，
 *   不必等重试次数耗尽——重试也不会变好。
 *
 * 冷却结束后进入半开：只放一个探测请求过去。成功则清零计数恢复常态，
 * 失败则重新冷却并把冷却时长翻倍。
 *
 * 状态只存在进程内存里：重启后重新计数是可接受语义，
 * 也避免把运行状态写进用户的配置。
 */

/** 连续失败多少次后熔断；小于 1 表示不熔断。 */
export const DEFAULT_FAILURE_THRESHOLD = 3;
/** 熔断冷却时长（毫秒）。 */
export const DEFAULT_COOLDOWN_MS = 60000;
/** 冷却时长的最大倍数，避免指数退避无限增长。 */
const MAX_COOLDOWN_FACTOR = 8;

/**
 * 判断一次失败是否值得计入熔断计数。
 *
 * 依据错误信息里的关键词判断上游语义：限流/配额/额度/熔断等属于「上游暂时
 * 不可用」，重试或换模型有意义；参数错误/鉴权失败属于「这个模型用不了」。
 *
 * @param {unknown} error - 捕获到的错误。
 * @returns {"recoverable"|"unrecoverable"|"unknown"} 失败类别。
 */
export function classifyFailure(error) {
  const text = String(error?.message ?? error ?? "").toLowerCase();
  if (!text) return "unknown";
  // 明确不可恢复：请求本身有问题，重试多少次都一样。
  const unrecoverable = [
    "unsupported_content",
    "unsupported content",
    "invalid_request",
    "invalid request",
    "invalid model",
    "unknown model",
    "not found",
    "unauthorized",
    "invalid api key",
    "no api key",
    "missing_credential",
    "authentication",
    "permission denied",
    "不支持",
  ];
  for (const needle of unrecoverable) {
    if (text.includes(needle)) return "unrecoverable";
  }
  // 明确可恢复：上游暂时不可用，换模型或等一会就好。
  const recoverable = [
    "429",
    "rate limit",
    "ratelimit",
    "too many requests",
    "quota",
    "quota exhausted",
    "insufficient credits",
    "insufficient",
    "credit balance",
    "额度",
    "配额",
    "限流",
    "余额不足",
    "冷却",
    "服务不可用",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
    "internal server error",
    "timeout",
    "超时",
    "econnreset",
    "econnrefused",
    "socket hang up",
    "network",
  ];
  for (const needle of recoverable) {
    if (text.includes(needle)) return "recoverable";
  }
  return "unknown";
}

/**
 * 熔断器：按条目 key 记录连续失败次数与冷却截止时间。
 *
 * 熔断状态挂在条目 key（provider+model）上，而不是配置数组下标上：
 * 用户调整条目顺序或删除条目都不该让计数错位。
 */
export class CircuitBreaker {
  /**
   * @param {() => {failureThreshold?: number, cooldownMs?: number}} getConfig - 读当前配置。
   */
  constructor(getConfig) {
    this.getConfig = getConfig;
    /** @type {Map<string, {failures: number, cooldownUntil: number, cooldownFactor: number}>} */
    this.states = new Map();
  }

  /** 熔断阈值与冷却时长；配置非法时回落到默认。 */
  limits() {
    const config = this.getConfig?.() ?? {};
    const threshold = Number(config.failureThreshold);
    const cooldown = Number(config.cooldownMs);
    return {
      // 阈值 0 是显式的「不熔断」，必须与「未配置」区分开。
      threshold: Number.isFinite(threshold) && threshold >= 0
        ? Math.floor(threshold)
        : DEFAULT_FAILURE_THRESHOLD,
      cooldown: Number.isFinite(cooldown) && cooldown >= 0 ? Math.floor(cooldown) : DEFAULT_COOLDOWN_MS,
    };
  }

  stateOf(key) {
    return this.states.get(key);
  }

  /**
   * 该条目当前是否应被跳过。
   *
   * @param {string} key - 条目路由键。
   * @param {number} [now] - 当前时间戳，便于测试注入。
   * @returns {boolean} true 表示熔断中，不应派发。
   */
  isTripped(key, now = Date.now()) {
    const { threshold } = this.limits();
    if (threshold < 1) return false;
    const state = this.states.get(key);
    if (!state) return false;
    if (state.cooldownUntil > now) return true;
    if (state.cooldownUntil > 0 && state.cooldownUntil <= now) {
      // 冷却已过：进入半开，允许一次探测。
      state.cooldownUntil = 0;
      return false;
    }
    return false;
  }

  /** 剩余冷却毫秒数；未熔断返回 0。 */
  remainingCooldown(key, now = Date.now()) {
    const state = this.states.get(key);
    if (!state) return 0;
    return Math.max(0, state.cooldownUntil - now);
  }

  /**
   * 记录一次失败。
   *
   * @param {string} key - 条目路由键。
   * @param {"recoverable"|"unrecoverable"|"unknown"} kind - 失败类别。
   * @returns {boolean} true 表示该条目已被熔断。
   */
  recordFailure(key, kind) {
    const { threshold, cooldown } = this.limits();
    if (threshold < 1) return false;
    const state = this.states.get(key) ?? { failures: 0, cooldownUntil: 0, cooldownFactor: 1 };
    this.states.set(key, state);

    // 不可恢复的失败不等待阈值：立刻摘除这个模型。
    if (kind === "unrecoverable") {
      state.failures = threshold;
      state.cooldownFactor = MAX_COOLDOWN_FACTOR;
    } else {
      state.failures += 1;
    }

    if (state.failures < threshold) return false;

    const factor = Math.min(state.cooldownFactor, MAX_COOLDOWN_FACTOR);
    state.cooldownUntil = Date.now() + cooldown * factor;
    state.cooldownFactor = Math.min(state.cooldownFactor * 2, MAX_COOLDOWN_FACTOR);
    return true;
  }

  /** 记录一次成功：清零计数并结束冷却。 */
  recordSuccess(key) {
    const state = this.states.get(key);
    if (!state) return;
    state.failures = 0;
    state.cooldownUntil = 0;
    state.cooldownFactor = 1;
  }

  /** 丢弃某个条目的全部状态（配置变更或条目被删除时调用）。 */
  reset(key) {
    this.states.delete(key);
  }

  /** 清空全部状态。 */
  clear() {
    this.states.clear();
  }

  /** 当前处于熔断状态的条目键列表，用于诊断输出。 */
  trippedKeys(now = Date.now()) {
    const out = [];
    for (const [key, state] of this.states) {
      if (state.cooldownUntil > now) out.push(key);
    }
    return out;
  }
}
