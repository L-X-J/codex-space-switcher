import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  QuotaSnapshot,
  SpaceKind,
  UsageSnapshot,
} from "../../../packages/shared/src/index.ts";
import {
  SESSION_ARCHIVE_ROOT,
  SESSION_HISTORY_ROOT,
} from "./config.ts";
import { formatError, isNodeError, looksLikePlus, looksLikeTeam } from "./utils.ts";

/**
 * 本文件负责从 Codex 本地会话 JSONL 中提取最近的 `rate_limits` 快照。
 * 这是一个本地兜底数据源，用来补齐私有账户接口缺失的“已用 / 剩余”额度字段。
 */

const DEFAULT_SCAN_ROOTS = [SESSION_HISTORY_ROOT, SESSION_ARCHIVE_ROOT];
const DEFAULT_MAX_FILES = 40;

interface RateLimitBucket {
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
}

/**
 * 描述一次从本地会话事件中提取出来的额度快照。
 */
export interface LocalRateLimitSnapshot {
  kind: SpaceKind;
  capturedAt: string;
  primary: RateLimitBucket | null;
  secondary: RateLimitBucket | null;
  sourceFile: string;
}

/**
 * 读取每种空间类型最近一次出现的本地额度快照。
 *
 * @param options 可选读取配置，主要用于测试替身。
 * @param options.roots 需要扫描的目录根路径。
 * @param options.maxFiles 最多读取多少个最近 rollout 文件。
 * @returns 按空间类型索引的最新快照。
 */
export async function loadLatestRateLimitSnapshots(options?: {
  roots?: string[];
  maxFiles?: number;
}): Promise<Map<SpaceKind, LocalRateLimitSnapshot>> {
  const roots = options?.roots ?? DEFAULT_SCAN_ROOTS;
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
  const files = await listRecentRolloutFiles(roots, maxFiles);
  const latestByKind = new Map<SpaceKind, LocalRateLimitSnapshot>();

  for (const filePath of files) {
    const snapshot = await readLatestSnapshotFromFile(filePath);
    if (!snapshot || snapshot.kind === "unknown") {
      continue;
    }

    const current = latestByKind.get(snapshot.kind);
    if (!current || new Date(snapshot.capturedAt).getTime() > new Date(current.capturedAt).getTime()) {
      latestByKind.set(snapshot.kind, snapshot);
    }
  }

  return latestByKind;
}

/**
 * 把本地额度快照转换成前端可直接展示的“已用 / 剩余”摘要。
 *
 * @param snapshot 本地额度快照。
 * @returns 统一格式的用量摘要；若主窗口不存在则返回 `null`。
 */
export function toUsageSnapshot(
  snapshot: LocalRateLimitSnapshot,
): UsageSnapshot | null {
  const usageBucket =
    snapshot.secondary?.usedPercent !== null && snapshot.secondary?.usedPercent !== undefined
      ? snapshot.secondary
      : snapshot.primary;
  if (!usageBucket || usageBucket.usedPercent === null) {
    return null;
  }

  const used = roundPercent(usageBucket.usedPercent);
  const remaining = roundPercent(Math.max(100 - usageBucket.usedPercent, 0));

  return {
    unit: "%",
    used,
    limit: 100,
    remaining,
    percentUsed: used,
    windowLabel: formatWindowLabel(usageBucket.windowMinutes),
  };
}

/**
 * 把本地额度快照转换成账期级摘要。
 *
 * @param snapshot 本地额度快照。
 * @param current 当前已有的额度摘要，用于保留更具体的订阅标签。
 * @returns 合并后的额度摘要。
 */
export function toQuotaSnapshot(
  snapshot: LocalRateLimitSnapshot,
  current: QuotaSnapshot | null,
): QuotaSnapshot {
  return {
    label: current?.label ?? snapshot.kind,
    hardLimit: current?.hardLimit ?? 100,
    softLimit: current?.softLimit ?? null,
    remaining:
      current?.remaining ??
      (snapshot.primary?.usedPercent !== null && snapshot.primary?.usedPercent !== undefined
        ? roundPercent(Math.max(100 - snapshot.primary.usedPercent, 0))
        : null),
    periodEndsAt:
      current?.periodEndsAt ??
      snapshot.primary?.resetsAt ??
      snapshot.secondary?.resetsAt ??
      null,
  };
}

/**
 * 生成适合展示在诊断区域的一行摘要。
 *
 * @param snapshot 本地额度快照。
 * @returns 简短诊断文案。
 */
export function formatSnapshotDiagnostic(snapshot: LocalRateLimitSnapshot): string {
  const primaryText = snapshot.primary
    ? `${roundPercent(snapshot.primary.usedPercent)}% / ${formatWindowLabel(snapshot.primary.windowMinutes) ?? "5 小时窗口"}`
    : "无主窗口";
  const secondaryText = snapshot.secondary
    ? `；周窗口 ${roundPercent(snapshot.secondary.usedPercent)}% / ${formatWindowLabel(snapshot.secondary.windowMinutes) ?? "未知周期"}`
    : "";

  return `本地 rate_limits：5 小时窗口 ${primaryText}${secondaryText}。来源 ${path.basename(snapshot.sourceFile)}`;
}

/**
 * 从单行 JSONL 中提取 `rate_limits` 快照。
 *
 * @param line 一行原始 JSONL 文本。
 * @param sourceFile 来源文件路径，仅用于诊断。
 * @returns 解析出的快照；若该行不包含可用额度信息则返回 `null`。
 */
export function parseRateLimitSnapshotLine(
  line: string,
  sourceFile: string,
): LocalRateLimitSnapshot | null {
  if (!line.includes("\"rate_limits\"")) {
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

  const rateLimits = asRecord(payload["rate_limits"]);
  if (!rateLimits) {
    return null;
  }

  const primary = parseBucket(asRecord(rateLimits["primary"]));
  const secondary = parseBucket(asRecord(rateLimits["secondary"]));
  if (!primary && !secondary) {
    return null;
  }

  const capturedAt =
    typeof record["timestamp"] === "string" ? record["timestamp"] : new Date().toISOString();

  return {
    kind: inferRateLimitKind(rateLimits),
    capturedAt,
    primary,
    secondary,
    sourceFile,
  };
}

/**
 * 扫描多个目录下最近的 rollout 文件。
 *
 * @param roots 需要扫描的目录根。
 * @param maxFiles 最多返回的文件数量。
 * @returns 按文件名时间倒序排列的绝对路径列表。
 */
async function listRecentRolloutFiles(
  roots: string[],
  maxFiles: number,
): Promise<string[]> {
  const allFiles = new Set<string>();

  for (const root of roots) {
    const files = await collectRolloutFiles(root);
    for (const filePath of files) {
      allFiles.add(filePath);
    }
  }

  return [...allFiles]
    .sort((left, right) => path.basename(right).localeCompare(path.basename(left)))
    .slice(0, maxFiles);
}

/**
 * 递归收集某个目录下的 rollout JSONL 文件。
 *
 * @param root 扫描根目录。
 * @returns 命中的文件列表；目录不存在时返回空数组。
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
 * 从单个 rollout 文件中读取最近一条可用的额度快照。
 *
 * @param filePath rollout JSONL 文件路径。
 * @returns 最近一条快照；若文件不可读或没有相关事件则返回 `null`。
 */
async function readLatestSnapshotFromFile(
  filePath: string,
): Promise<LocalRateLimitSnapshot | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const snapshot = parseRateLimitSnapshotLine(lines[index] ?? "", filePath);
      if (snapshot) {
        return snapshot;
      }
    }

    return null;
  } catch (error) {
    console.warn(`读取本地额度快照失败：${filePath}，${formatError(error)}`);
    return null;
  }
}

/**
 * 把未知值收敛为普通对象，避免后续字段访问污染主流程。
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
 * 解析单个额度窗口。
 *
 * @param bucket 原始窗口对象。
 * @returns 归一化后的窗口；若没有任何有效字段则返回 `null`。
 */
function parseBucket(bucket: Record<string, unknown> | null): RateLimitBucket | null {
  if (!bucket) {
    return null;
  }

  const usedPercent =
    typeof bucket["used_percent"] === "number" ? bucket["used_percent"] : null;
  const windowMinutes =
    typeof bucket["window_minutes"] === "number" ? bucket["window_minutes"] : null;
  const resetsAt =
    typeof bucket["resets_at"] === "number"
      ? new Date(bucket["resets_at"] * 1000).toISOString()
      : null;

  if (usedPercent === null && windowMinutes === null && resetsAt === null) {
    return null;
  }

  return {
    usedPercent,
    windowMinutes,
    resetsAt,
  };
}

/**
 * 从 `rate_limits` 字段推断快照所属空间类型。
 *
 * @param rateLimits 原始 `rate_limits` 对象。
 * @returns 归一化后的空间类型。
 */
function inferRateLimitKind(rateLimits: Record<string, unknown>): SpaceKind {
  const rawPlanType =
    typeof rateLimits["plan_type"] === "string" ? rateLimits["plan_type"] : "";

  if (looksLikeTeam(rawPlanType)) {
    return "team";
  }

  if (looksLikePlus(rawPlanType)) {
    return "plus";
  }

  return "unknown";
}

/**
 * 把分钟窗口转换成更适合展示的中文文案。
 *
 * @param windowMinutes 窗口分钟数。
 * @returns 中文窗口标签；若没有窗口信息则返回 `null`。
 */
function formatWindowLabel(windowMinutes: number | null): string | null {
  if (windowMinutes === null) {
    return null;
  }

  if (windowMinutes % (60 * 24 * 7) === 0) {
    return `${windowMinutes / (60 * 24 * 7)} 周窗口`;
  }

  if (windowMinutes % (60 * 24) === 0) {
    return `${windowMinutes / (60 * 24)} 天窗口`;
  }

  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60} 小时窗口`;
  }

  return `${windowMinutes} 分钟窗口`;
}

/**
 * 把私有接口中的小数百分比规整成整数，保证 UI 文案稳定。
 *
 * @param value 原始百分比。
 * @returns 四舍五入后的整数；若输入为空则返回 `0`。
 */
function roundPercent(value: number | null): number {
  return Math.round(value ?? 0);
}
