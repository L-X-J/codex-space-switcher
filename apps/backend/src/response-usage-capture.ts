/**
 * 本文件负责从 `/responses` 的 JSON 或 SSE 中提取 token 用量。
 * 由于官方账号和第三方兼容实现的字段略有差异，解析逻辑会优先做结构归一化，再提取 usage。
 */

export interface CapturedUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface SseUsageCollectorOptions {
  onOutputStarted?: () => void;
}

/**
 * 从完整 JSON 响应体中提取 token 用量。
 *
 * @param payload 已反序列化的 JSON。
 * @returns 若能识别 usage 则返回标准化结果，否则返回 `null`。
 */
export function extractUsageFromPayload(payload: unknown): CapturedUsage | null {
  const unwrapped = unwrapPayload(payload);
  if (!unwrapped) {
    return null;
  }

  const responseUsage = findResponseUsage(unwrapped);
  if (responseUsage) {
    return responseUsage;
  }

  return findTokenCountUsage(unwrapped);
}

/**
 * 增量解析 SSE 文本流中的 token 用量事件。
 */
export class SseUsageCollector {
  private readonly decoder = new TextDecoder();

  private buffer = "";

  private best: CapturedUsage | null = null;

  constructor(private readonly options: SseUsageCollectorOptions = {}) {}

  /**
   * 喂入一段原始 SSE 字节，并尝试提取最新 usage。
   *
   * @param chunk 上游返回的字节块。
   * @returns 无返回值。
   */
  pushChunk(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    this.consumeFrames();
  }

  /**
   * 结束解析并返回识别到的最佳 usage 结果。
   *
   * @returns 当前累计得到的最佳 usage。
   */
  finish(): CapturedUsage | null {
    this.buffer += this.decoder.decode().replace(/\r\n/g, "\n");
    this.consumeFrames(true);
    return this.best;
  }

  /**
   * 消费当前缓存中完整的 SSE 帧。
   *
   * @param flush 是否将尾部残留文本也视为完整帧。
   * @returns 无返回值。
   */
  private consumeFrames(flush = false): void {
    while (true) {
      const separatorIndex = this.buffer.indexOf("\n\n");
      if (separatorIndex < 0) {
        break;
      }

      const frame = this.buffer.slice(0, separatorIndex);
      this.buffer = this.buffer.slice(separatorIndex + 2);
      this.consumeFrame(frame);
    }

    if (flush && this.buffer.trim().length > 0) {
      this.consumeFrame(this.buffer);
      this.buffer = "";
    }
  }

  /**
   * 解析单个 SSE 帧。
   *
   * @param frame 原始帧文本。
   * @returns 无返回值。
   */
  private consumeFrame(frame: string): void {
    const dataLines = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line.length > 0 && line !== "[DONE]");

    if (dataLines.length === 0) {
      return;
    }

    const data = dataLines.join("\n");
    try {
      const payload = JSON.parse(data);
      if (isOutputDeltaPayload(payload)) {
        this.options.onOutputStarted?.();
      }
      const usage = extractUsageFromPayload(payload);
      if (usage && shouldReplaceUsage(this.best, usage)) {
        this.best = usage;
      }
    } catch {
      // 某些帧只承载文本片段，不包含 JSON usage，这里直接忽略。
    }
  }
}

/**
 * 判断事件是否表示模型已经开始输出内容。
 *
 * @param payload 已解析的响应事件。
 * @returns 是输出 delta 时返回 `true`。
 */
export function isOutputDeltaPayload(payload: unknown): boolean {
  const unwrapped = unwrapPayload(payload);
  if (!unwrapped) {
    return false;
  }

  const payloadType =
    typeof unwrapped["type"] === "string" ? unwrapped["type"] : null;
  if (
    payloadType !== "response.output_text.delta" &&
    payloadType !== "response.function_call_arguments.delta"
  ) {
    return false;
  }

  const delta = unwrapped["delta"];
  return typeof delta !== "string" || delta.length > 0;
}

/**
 * 判断新 usage 是否比当前缓存结果更适合作为最终统计。
 *
 * @param current 当前最佳结果。
 * @param candidate 新候选结果。
 * @returns 应替换时返回 `true`。
 */
function shouldReplaceUsage(
  current: CapturedUsage | null,
  candidate: CapturedUsage,
): boolean {
  if (!current) {
    return true;
  }

  return candidate.totalTokens >= current.totalTokens;
}

/**
 * 从响应对象中提取标准 usage 字段。
 *
 * @param payload 已解包后的 JSON。
 * @returns 标准化 usage；若未识别到则返回 `null`。
 */
function findResponseUsage(
  payload: Record<string, unknown>,
): CapturedUsage | null {
  const directUsage = asRecord(payload["usage"]);
  if (directUsage) {
    return normalizeUsageObject(directUsage);
  }

  const response = asRecord(payload["response"]);
  const responseUsage = asRecord(response?.["usage"]);
  if (responseUsage) {
    return normalizeUsageObject(responseUsage);
  }

  return null;
}

/**
 * 从 `token_count` 风格事件中提取累计 usage。
 *
 * @param payload 已解包后的 JSON。
 * @returns 标准化 usage；若未识别到则返回 `null`。
 */
function findTokenCountUsage(
  payload: Record<string, unknown>,
): CapturedUsage | null {
  const payloadType =
    typeof payload["type"] === "string" ? payload["type"] : null;
  if (payloadType !== "token_count") {
    return null;
  }

  const info = asRecord(payload["info"]);
  const totalUsage = asRecord(info?.["total_token_usage"]);
  const lastUsage = asRecord(info?.["last_token_usage"]);

  return (
    normalizeTokenCountUsage(totalUsage) ??
    normalizeTokenCountUsage(lastUsage)
  );
}

/**
 * 统一解开 `payload` / `msg` 等嵌套包装。
 *
 * @param value 原始 JSON。
 * @returns 最终承载业务字段的对象。
 */
function unwrapPayload(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const payload = asRecord(record["payload"]);
  if (payload && typeof payload["type"] === "string") {
    return payload;
  }

  const msg = asRecord(record["msg"]);
  if (msg && typeof msg["type"] === "string") {
    return msg;
  }

  return record;
}

/**
 * 把标准 `usage` 对象转换成统一结构。
 *
 * @param usage 原始 usage 对象。
 * @returns 标准化 usage；若没有可用数字则返回 `null`。
 */
function normalizeUsageObject(
  usage: Record<string, unknown>,
): CapturedUsage | null {
  const inputTokens = toNumber(usage["input_tokens"]);
  const outputTokens = toNumber(usage["output_tokens"]);
  const totalTokens = toNumber(usage["total_tokens"]);
  const inputDetails = asRecord(usage["input_tokens_details"]);
  const cachedInputTokens = toNumber(inputDetails?.["cached_tokens"]);

  if (
    inputTokens === null &&
    outputTokens === null &&
    totalTokens === null &&
    cachedInputTokens === null
  ) {
    return null;
  }

  const safeInputTokens = inputTokens ?? 0;
  const safeOutputTokens = outputTokens ?? 0;
  const safeCachedTokens = cachedInputTokens ?? 0;

  return {
    inputTokens: safeInputTokens,
    cachedInputTokens: safeCachedTokens,
    outputTokens: safeOutputTokens,
    totalTokens: totalTokens ?? safeInputTokens + safeOutputTokens,
  };
}

/**
 * 把 `token_count` 的累计字段转换成统一结构。
 *
 * @param usage 原始累计对象。
 * @returns 标准化 usage；若字段为空则返回 `null`。
 */
function normalizeTokenCountUsage(
  usage: Record<string, unknown> | null,
): CapturedUsage | null {
  if (!usage) {
    return null;
  }

  const inputTokens = toNumber(usage["input_tokens"]);
  const cachedInputTokens = toNumber(usage["cached_input_tokens"]);
  const outputTokens = toNumber(usage["output_tokens"]);
  const totalTokens = toNumber(usage["total_tokens"]);

  if (
    inputTokens === null &&
    cachedInputTokens === null &&
    outputTokens === null &&
    totalTokens === null
  ) {
    return null;
  }

  const safeInputTokens = inputTokens ?? 0;
  const safeOutputTokens = outputTokens ?? 0;

  return {
    inputTokens: safeInputTokens,
    cachedInputTokens: cachedInputTokens ?? 0,
    outputTokens: safeOutputTokens,
    totalTokens: totalTokens ?? safeInputTokens + safeOutputTokens,
  };
}

/**
 * 把未知值安全收敛为普通对象。
 *
 * @param value 任意值。
 * @returns 普通对象；若不是对象则返回 `null`。
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

/**
 * 把未知值收敛成数字。
 *
 * @param value 任意值。
 * @returns 有效数字；若无法转换则返回 `null`。
 */
function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}
