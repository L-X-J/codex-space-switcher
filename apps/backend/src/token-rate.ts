/**
 * 本文件集中维护 token 速率的计算口径。
 * 优先使用首个输出到响应结束的生成周期，只有缺少流式时间点时才回退到整次请求耗时。
 */

export interface TokenRateMetrics {
  firstOutputLatencyMs: number | null;
  outputDurationMs: number | null;
  tokenRatePerSecond: number;
}

export interface TokenRateMetricInput {
  outputTokens: number;
  latencyMs: number;
  firstOutputLatencyMs?: number | null;
  outputDurationMs?: number | null;
}

export interface OutputTimingSnapshot {
  firstOutputLatencyMs: number | null;
  outputDurationMs: number | null;
}

/**
 * 跟踪一次流式响应的输出时间点。
 * `startedAtMs` 使用调用方已有的请求开始时间，避免 HTTP 与 WebSocket 路径各自定义口径。
 */
export class OutputTimingTracker {
  private firstOutputAtMs: number | null = null;

  constructor(
    private readonly startedAtMs: number,
    private readonly nowMs: () => number = Date.now,
  ) {}

  /**
   * 记录首个输出 delta 到达的时间。
   *
   * @returns 无返回值；多次调用只保留第一次，避免后续 delta 覆盖首字耗时。
   */
  markOutputStarted(): void {
    if (this.firstOutputAtMs !== null) {
      return;
    }

    this.firstOutputAtMs = this.nowMs();
  }

  /**
   * 在响应结束时生成时间快照。
   *
   * @returns 首字耗时与生成周期；没有观察到输出 delta 时两个字段均为 `null`。
   */
  finish(): OutputTimingSnapshot {
    if (this.firstOutputAtMs === null) {
      return {
        firstOutputLatencyMs: null,
        outputDurationMs: null,
      };
    }

    const finishedAtMs = this.nowMs();
    return {
      firstOutputLatencyMs: normalizeNonNegativeDuration(
        this.firstOutputAtMs - this.startedAtMs,
      ),
      outputDurationMs: normalizeNonNegativeDuration(
        finishedAtMs - this.firstOutputAtMs,
      ),
    };
  }
}

/**
 * 按输出 token 和有效生成周期估算生成速率。
 *
 * @param input 生成速率所需的 token 与时间数据。
 * @returns 统一的首字耗时、生成周期和 token/秒。
 */
export function buildTokenRateMetrics(
  input: TokenRateMetricInput,
): TokenRateMetrics {
  const firstOutputLatencyMs = normalizeNullableDuration(
    input.firstOutputLatencyMs,
  );
  const outputDurationMs = normalizeNullableDuration(input.outputDurationMs);
  const fallbackLatencyMs = normalizeNullableDuration(input.latencyMs);
  const rateDurationMs = normalizePositiveDuration(outputDurationMs) ?? fallbackLatencyMs;

  return {
    firstOutputLatencyMs,
    outputDurationMs,
    tokenRatePerSecond: calculateTokenRatePerSecond(
      input.outputTokens,
      rateDurationMs,
    ),
  };
}

/**
 * 按输出 token 和给定时间周期估算生成速率。
 *
 * @param outputTokens 本次请求生成的输出 token 数量。
 * @param durationMs 输出生成周期，优先为首个输出到结束的耗时。
 * @returns token/秒；耗时非法或无输出 token 时返回 0，避免展示无意义的 Infinity。
 */
export function calculateTokenRatePerSecond(
  outputTokens: number,
  durationMs: number | null | undefined,
): number {
  if (
    !Number.isFinite(outputTokens) ||
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs)
  ) {
    return 0;
  }

  const safeOutputTokens = Math.max(outputTokens, 0);
  const safeDurationMs = Math.max(durationMs ?? 0, 0);
  if (safeOutputTokens === 0 || safeDurationMs === 0) {
    return 0;
  }

  return safeOutputTokens / (safeDurationMs / 1000);
}

/**
 * 规整可为空的耗时字段。
 *
 * @param value 原始耗时毫秒数。
 * @returns 非负耗时；缺失或非法时返回 `null`。
 */
function normalizeNullableDuration(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return normalizeNonNegativeDuration(value as number);
}

/**
 * 规整非负耗时字段。
 *
 * @param value 原始耗时毫秒数。
 * @returns 非负耗时。
 */
function normalizeNonNegativeDuration(value: number): number {
  return Math.max(value, 0);
}

/**
 * 规整参与速率分母的耗时。
 *
 * @param value 原始耗时毫秒数。
 * @returns 大于 0 的耗时；0 或非法值返回 `null`，让调用方有机会回退到整次耗时。
 */
function normalizePositiveDuration(value: number | null): number | null {
  if (value === null || value <= 0) {
    return null;
  }

  return value;
}
