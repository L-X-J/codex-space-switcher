import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  LatestTokenUsageSnapshot,
  SpaceKind,
  TokenTotals,
  TokenUsageByKind,
  TokenUsageSummary,
  TokenUsageWindow,
} from "../../../packages/shared/src/index.ts";
import { SESSION_ARCHIVE_ROOT, SESSION_HISTORY_ROOT } from "./config.ts";
import { isNodeError, looksLikePlus, looksLikeTeam } from "./utils.ts";

/**
 * 本文件负责从 Codex 本地 rollout JSONL 中聚合 token 消耗。
 * 这里的统计完全来自本机落盘事件，因此不依赖任何未公开网络接口。
 */

const DEFAULT_SCAN_ROOTS = [SESSION_HISTORY_ROOT, SESSION_ARCHIVE_ROOT];
const DEFAULT_MAX_FILES = 240;

interface ParsedRolloutUsage {
  capturedAt: string;
  kind: SpaceKind;
  totals: TokenTotals;
  sourceFile: string;
}

interface MutableByKindBucket {
  totals: TokenTotals;
  sessions: number;
}

/**
 * 读取最近一批本地 rollout，并聚合成适合面板展示的 token 总览。
 *
 * @param options 可选读取配置，主要用于测试或限制扫描范围。
 * @param options.roots 需要扫描的根目录列表。
 * @param options.maxFiles 最多读取多少个 rollout 文件。
 * @param options.now 用于窗口切分的当前时间。
 * @returns 归一化后的 token 用量总览。
 */
export async function loadTokenUsageSummary(options?: {
  roots?: string[];
  maxFiles?: number;
  now?: Date;
}): Promise<TokenUsageSummary> {
  const roots = options?.roots ?? DEFAULT_SCAN_ROOTS;
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
  const now = options?.now ?? new Date();
  const files = await listRecentRolloutFiles(roots, maxFiles);
  const rollouts: ParsedRolloutUsage[] = [];

  for (const filePath of files) {
    const parsed = await parseRolloutUsageFile(filePath);
    if (parsed) {
      rollouts.push(parsed);
    }
  }

  return buildTokenUsageSummary(rollouts, now);
}

/**
 * 把 rollout 级别的 token 记录汇总成固定窗口统计。
 *
 * @param rollouts rollout 摘要数组。
 * @param now 当前时间，用于决定今天和近 7 天窗口。
 * @returns 面板用的 token 总览。
 */
export function buildTokenUsageSummary(
  rollouts: ParsedRolloutUsage[],
  now: Date,
): TokenUsageSummary {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const sevenDaysStart = new Date(todayStart);
  sevenDaysStart.setDate(sevenDaysStart.getDate() - 6);

  const latestSession =
    [...rollouts].sort(
      (left, right) =>
        new Date(right.capturedAt).getTime() - new Date(left.capturedAt).getTime(),
    )[0] ?? null;

  return {
    generatedAt: now.toISOString(),
    today: aggregateWindow(
      "今日",
      rollouts.filter((item) => new Date(item.capturedAt).getTime() >= todayStart.getTime()),
      todayStart.toISOString(),
      now.toISOString(),
    ),
    last7Days: aggregateWindow(
      "近 7 天",
      rollouts.filter(
        (item) => new Date(item.capturedAt).getTime() >= sevenDaysStart.getTime(),
      ),
      sevenDaysStart.toISOString(),
      now.toISOString(),
    ),
    latestSession: latestSession
      ? {
          capturedAt: latestSession.capturedAt,
          kind: latestSession.kind,
          totals: latestSession.totals,
          sourceFile: latestSession.sourceFile,
        }
      : null,
  };
}

/**
 * 从单个 JSONL 行里提取 token 使用快照。
 *
 * @param line 原始 JSONL 行文本。
 * @param sourceFile 来源文件路径，仅用于诊断。
 * @returns 若该行包含可用 token 统计则返回摘要，否则返回 `null`。
 */
export function parseTokenUsageLine(
  line: string,
  sourceFile: string,
): ParsedRolloutUsage | null {
  if (!line.includes("\"token_count\"")) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const payload = asRecord(record["payload"]);
  if (!payload || payload["type"] !== "token_count") {
    return null;
  }

  const info = asRecord(payload["info"]);
  if (!info) {
    return null;
  }

  const totalUsage = asRecord(info["total_token_usage"]);
  const lastUsage = asRecord(info["last_token_usage"]);
  const totals = normalizeTokenTotals(totalUsage, lastUsage);
  if (!totals) {
    return null;
  }

  const rateLimits = asRecord(payload["rate_limits"]);
  const capturedAt =
    typeof record["timestamp"] === "string" ? record["timestamp"] : new Date().toISOString();

  return {
    capturedAt,
    kind: inferKindFromRateLimits(rateLimits),
    totals,
    sourceFile,
  };
}

/**
 * 聚合一个时间窗口内的 rollout 列表。
 *
 * @param label 窗口名称。
 * @param rollouts 落入该窗口的 rollout 摘要。
 * @param windowStart 窗口开始时间。
 * @param windowEnd 窗口结束时间。
 * @returns 聚合后的窗口统计。
 */
function aggregateWindow(
  label: string,
  rollouts: ParsedRolloutUsage[],
  windowStart: string,
  windowEnd: string,
): TokenUsageWindow {
  const totals = createEmptyTokenTotals();
  const byKind = new Map<SpaceKind, MutableByKindBucket>();

  for (const rollout of rollouts) {
    addTokenTotals(totals, rollout.totals);

    if (rollout.kind === "unknown") {
      continue;
    }

    const bucket =
      byKind.get(rollout.kind) ??
      {
        totals: createEmptyTokenTotals(),
        sessions: 0,
      };
    addTokenTotals(bucket.totals, rollout.totals);
    bucket.sessions += 1;
    byKind.set(rollout.kind, bucket);
  }

  return {
    label,
    windowStart,
    windowEnd,
    totals,
    sessions: rollouts.length,
    byKind: [...byKind.entries()]
      .map(([kind, bucket]): TokenUsageByKind => ({
        kind,
        totals: bucket.totals,
        sessions: bucket.sessions,
      }))
      .sort((left, right) => right.totals.totalTokens - left.totals.totalTokens),
  };
}

/**
 * 扫描给定目录下最近的 rollout 文件。
 *
 * @param roots 根目录列表。
 * @param maxFiles 最多返回的文件数量。
 * @returns 去重后的绝对路径列表。
 */
async function listRecentRolloutFiles(
  roots: string[],
  maxFiles: number,
): Promise<string[]> {
  const allFiles = new Map<string, string>();

  for (const root of roots) {
    const files = await collectRolloutFiles(root);
    for (const filePath of files) {
      allFiles.set(path.basename(filePath), filePath);
    }
  }

  return [...allFiles.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .slice(0, maxFiles)
    .map(([, absolutePath]) => absolutePath);
}

/**
 * 递归收集某个根目录下的 rollout 文件。
 *
 * @param root 扫描根目录。
 * @returns rollout 文件绝对路径数组。
 */
async function collectRolloutFiles(root: string): Promise<string[]> {
  const collected: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) {
        collected.push(absolutePath);
      }
    }
  }

  await walk(root);
  return collected;
}

/**
 * 从单个 rollout 文件中提取整场会话的 token 总量。
 *
 * @param filePath rollout 文件路径。
 * @returns 该 rollout 的最佳摘要；若没有可用 token 数据则返回 `null`。
 */
async function parseRolloutUsageFile(filePath: string): Promise<ParsedRolloutUsage | null> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  let best: ParsedRolloutUsage | null = null;
  let bestKnownKind: SpaceKind = "unknown";

  for (const line of lines) {
    const parsed = parseTokenUsageLine(line, filePath);
    if (!parsed) {
      continue;
    }

    if (parsed.kind !== "unknown") {
      bestKnownKind = parsed.kind;
    }

    if (!best || parsed.totals.totalTokens > best.totals.totalTokens) {
      best = parsed;
      continue;
    }

    if (
      parsed.totals.totalTokens === best.totals.totalTokens &&
      new Date(parsed.capturedAt).getTime() > new Date(best.capturedAt).getTime()
    ) {
      best = parsed;
    }
  }

  if (!best) {
    return null;
  }

  if (best.totals.totalTokens <= 0) {
    return null;
  }

  return {
    ...best,
    kind: best.kind === "unknown" ? bestKnownKind : best.kind,
  };
}

/**
 * 把原始 token 对象转换成统一结构。
 * 当 `total_token_usage` 仍是全零而 `last_token_usage` 已有值时，优先回退到后者，避免新 rollout 起始阶段被统计成 0。
 *
 * @param totalUsage `total_token_usage` 原始对象。
 * @param lastUsage `last_token_usage` 原始对象。
 * @returns 标准化后的 token 明细；两者都不可用时返回 `null`。
 */
function normalizeTokenTotals(
  totalUsage: Record<string, unknown> | null,
  lastUsage: Record<string, unknown> | null,
): TokenTotals | null {
  const totalCandidate = toTokenTotals(totalUsage);
  const lastCandidate = toTokenTotals(lastUsage);

  if (totalCandidate && totalCandidate.totalTokens > 0) {
    return totalCandidate;
  }

  if (lastCandidate && lastCandidate.totalTokens > 0) {
    return lastCandidate;
  }

  return totalCandidate ?? lastCandidate;
}

/**
 * 把未知对象收敛成 token 明细。
 *
 * @param source 原始对象。
 * @returns 标准化后的明细；若没有数字字段则返回 `null`。
 */
function toTokenTotals(source: Record<string, unknown> | null): TokenTotals | null {
  if (!source) {
    return null;
  }

  const totals: TokenTotals = {
    inputTokens: pickNumericField(source, "input_tokens"),
    cachedInputTokens: pickNumericField(source, "cached_input_tokens"),
    outputTokens: pickNumericField(source, "output_tokens"),
    reasoningOutputTokens: pickNumericField(source, "reasoning_output_tokens"),
    totalTokens: pickNumericField(source, "total_tokens"),
  };

  if (Object.values(totals).every((value) => value === 0)) {
    return totals;
  }

  return totals;
}

/**
 * 从 `rate_limits` 推断 rollout 对应的空间类型。
 *
 * @param rateLimits 原始 `rate_limits` 对象。
 * @returns 归一化后的空间类型。
 */
function inferKindFromRateLimits(
  rateLimits: Record<string, unknown> | null,
): SpaceKind {
  if (!rateLimits) {
    return "unknown";
  }

  const planType =
    typeof rateLimits["plan_type"] === "string" ? rateLimits["plan_type"] : "";
  const limitName =
    typeof rateLimits["limit_name"] === "string" ? rateLimits["limit_name"] : "";
  const combined = `${planType} ${limitName}`;

  if (looksLikeTeam(combined)) {
    return "team";
  }

  if (looksLikePlus(combined)) {
    return "plus";
  }

  return "unknown";
}

/**
 * 安全读取一个数字字段。
 *
 * @param source 来源对象。
 * @param key 字段名。
 * @returns 数字值；若字段缺失或不是数字则返回 `0`。
 */
function pickNumericField(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * 创建一份全零 token 明细，方便聚合时复用。
 *
 * @returns 全零 token 明细。
 */
function createEmptyTokenTotals(): TokenTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

/**
 * 把一份 token 明细累加到目标对象。
 *
 * @param target 累加目标。
 * @param source 累加来源。
 * @returns 无返回值。
 */
function addTokenTotals(target: TokenTotals, source: TokenTotals): void {
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
}

/**
 * 把未知值收敛成普通对象。
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
