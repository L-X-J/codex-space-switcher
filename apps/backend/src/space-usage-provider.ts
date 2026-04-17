import type {
  ManualSpaceDefinition,
  QuotaSnapshot,
  SpaceCard,
  SpaceKind,
  SwitchHint,
  UsageSnapshot,
} from "../../../packages/shared/src/index.ts";
import { MANUAL_SPACES_FILE, SPACE_PROBE_CANDIDATES } from "./config.ts";
import type { CodexSession } from "./codex-session-provider.ts";
import { callInternalApi } from "./internal-api-client.ts";
import {
  formatSnapshotDiagnostic,
  type LocalRateLimitSnapshot,
  loadLatestRateLimitSnapshots,
  toQuotaSnapshot,
  toUsageSnapshot,
} from "./local-rate-limit-provider.ts";
import { formatError, looksLikePlus, looksLikeTeam, pickNumber, pickString, readJsonFile } from "./utils.ts";

export interface SpaceRecord extends SpaceCard {
  switchHints: SwitchHint[];
}

interface ProbeDiagnostic {
  path: string;
  ok: boolean;
  status: number;
  note: string;
}

interface ManualSpaceFile {
  spaces?: ManualSpaceDefinition[];
}

/**
 * 本文件负责把私有接口返回归一化为 UI 可用的空间卡片。
 * 私有接口字段并不稳定，因此实现采用“多探针 + 宽松解析 + 明确诊断”的策略。
 */

/**
 * 刷新当前所有可见空间的状态。
 *
 * @param session 当前 Codex 会话。
 * @returns 归一化后的空间列表。
 */
export async function loadSpaces(session: CodexSession): Promise<SpaceRecord[]> {
  const diagnostics: ProbeDiagnostic[] = [];
  const discoveredSpaces: SpaceRecord[] = [];

  for (const path of SPACE_PROBE_CANDIDATES) {
    try {
      const response = await callInternalApi<unknown>(session, path);
      diagnostics.push({
        path,
        ok: response.ok,
        status: response.status,
        note: response.ok
          ? "请求成功"
          : `请求失败，响应体前 120 字符：${response.rawText.slice(0, 120)}`,
      });

      if (response.ok && response.body) {
        mergeSpaces(
          discoveredSpaces,
          extractSpacesFromPayload(response.body, path, response.rawText),
        );
      }
    } catch (error) {
      diagnostics.push({
        path,
        ok: false,
        status: 0,
        note: `探针异常：${formatError(error)}`,
      });
    }
  }

  const manualSpaces = await loadManualSpaces();
  mergeSpaces(discoveredSpaces, applyManualHints(manualSpaces));
  const localRateLimitSnapshots = await loadLatestRateLimitSnapshots().catch((error) => {
    diagnostics.push({
      path: "local://rate_limits",
      ok: false,
      status: 0,
      note: `本地额度快照读取失败：${formatError(error)}`,
    });
    return new Map<SpaceKind, LocalRateLimitSnapshot>();
  });

  if (discoveredSpaces.length === 0) {
    const fallbackSpaces = synthesizeFallbackSpaces(session, diagnostics);
    applyLocalRateLimitSnapshots(fallbackSpaces, localRateLimitSnapshots);
    return fallbackSpaces;
  }

  for (const space of discoveredSpaces) {
    space.rawDiagnostics.push(
      ...diagnostics.map(
        (item) => `[${item.ok ? "OK" : "ERR"}] ${item.path} -> ${item.note}`,
      ),
    );
  }

  normalizeActiveSpace(discoveredSpaces, session);
  applyLocalRateLimitSnapshots(discoveredSpaces, localRateLimitSnapshots);
  return discoveredSpaces.sort((left, right) => {
    if (left.isActive === right.isActive) {
      return left.name.localeCompare(right.name);
    }

    return left.isActive ? -1 : 1;
  });
}

/**
 * 加载用户手工补充的空间信息。
 *
 * @returns 手工空间定义数组，文件不存在时返回空数组。
 */
async function loadManualSpaces(): Promise<ManualSpaceDefinition[]> {
  const file = await readJsonFile<ManualSpaceFile>(MANUAL_SPACES_FILE);
  return file?.spaces ?? [];
}

/**
 * 将手工定义的空间补充为完整的空间记录。
 *
 * @param manualSpaces 手工定义列表。
 * @returns 带默认状态的空间记录。
 */
function applyManualHints(manualSpaces: ManualSpaceDefinition[]): SpaceRecord[] {
  return manualSpaces.map((space) => ({
    id: space.id,
    name: space.name,
    kind: space.kind,
    isActive: false,
    usageSummary: null,
    quotaSummary: null,
    health: "warning",
    lastCheckedAt: new Date().toISOString(),
    rawDiagnostics: ["来自 manual-spaces.json 的手工补充。"],
    switchHints: space.switchHints ?? [],
  }));
}

/**
 * 尝试从一个未知结构的私有接口返回中提取空间信息。
 *
 * @param payload 原始 JSON。
 * @param sourcePath 响应来源路径。
 * @param rawText 原始响应文本，用于兜底诊断。
 * @returns 归一化后的空间记录数组。
 */
function extractSpacesFromPayload(
  payload: unknown,
  sourcePath: string,
  rawText: string,
): SpaceRecord[] {
  if (sourcePath === "/backend-api/me") {
    return [];
  }

  const candidates = collectObjects(payload);
  const spaces: SpaceRecord[] = [];

  for (const candidate of candidates) {
    if (!isLikelySwitchableSpace(candidate, sourcePath)) {
      continue;
    }

    const id = pickString(candidate, [
      "account_id",
      "workspace_id",
      "id",
      "team_id",
      "organization_id",
    ]);
    const name =
      pickString(candidate, [
        "name",
        "display_name",
        "workspace_name",
        "organization_name",
        "label",
        "title",
      ]) ??
      inferFallbackSpaceName(candidate) ??
      id;

    if (!id || !name) {
      continue;
    }

    const rawType = pickString(candidate, [
      "plan_type",
      "workspace_type",
      "subscription_plan",
      "kind",
      "type",
    ]);
    const kind = inferSpaceKind(name, rawType);
    const usageSummary = buildUsageSummary(candidate);
    const quotaSummary = buildQuotaSummary(candidate);
    const diagnostics = [`来源探针：${sourcePath}`];

    if (!usageSummary && !quotaSummary) {
      diagnostics.push(
        `未识别到明确用量字段，原始片段：${JSON.stringify(candidate).slice(0, 220)}`,
      );
    }

    spaces.push({
      id,
      name,
      kind,
      isActive: false,
      usageSummary,
      quotaSummary,
      health: deriveHealth(candidate, usageSummary, quotaSummary),
      lastCheckedAt: new Date().toISOString(),
      rawDiagnostics: diagnostics,
      switchHints: inferSwitchHints(candidate, id),
    });
  }

  if (spaces.length === 0) {
    return [
      {
        id: `probe:${sourcePath}`,
        name: `未识别空间（${sourcePath}）`,
        kind: "unknown",
        isActive: false,
        usageSummary: null,
        quotaSummary: null,
        health: "error",
        lastCheckedAt: new Date().toISOString(),
        rawDiagnostics: [
          `该探针返回成功，但未识别出空间对象。响应片段：${rawText.slice(0, 220)}`,
        ],
        switchHints: [],
      },
    ];
  }

  return spaces;
}

/**
 * 判断一个候选对象是否像真实可切换空间，而不是订阅目录项或用户资料。
 *
 * @param candidate 候选对象。
 * @param sourcePath 探针来源路径。
 * @returns 当对象满足空间语义时返回 `true`。
 */
function isLikelySwitchableSpace(
  candidate: Record<string, unknown>,
  sourcePath: string,
): boolean {
  const hasSpaceSignals =
    "structure" in candidate ||
    "current_user_role" in candidate ||
    "processor" in candidate ||
    "workspace_id" in candidate ||
    "account_id" in candidate;

  if (sourcePath === "/backend-api/accounts") {
    return hasSpaceSignals;
  }

  if (sourcePath.startsWith("/backend-api/accounts/check")) {
    return hasSpaceSignals;
  }

  return false;
}

/**
 * 从对象中推断空间类型。
 *
 * @param name 空间名称。
 * @param rawType 私有接口中的类型字段。
 * @returns 归一化后的空间类型。
 */
function inferSpaceKind(name: string, rawType: string | null): SpaceKind {
  const text = `${name} ${rawType ?? ""}`;

  if (looksLikeTeam(text)) {
    return "team";
  }

  if (looksLikePlus(text)) {
    return "plus";
  }

  return "unknown";
}

/**
 * 当接口没有返回显式名称时，根据结构字段推导一个更友好的空间名。
 *
 * @param candidate 原始对象。
 * @returns 推导出的名称；若无法推导则返回 `null`。
 */
function inferFallbackSpaceName(
  candidate: Record<string, unknown>,
): string | null {
  if (candidate["structure"] === "personal") {
    return "Personal";
  }

  if (candidate["structure"] === "workspace") {
    return "Workspace";
  }

  return null;
}

/**
 * 从未知结构中提取用量摘要。
 *
 * @param candidate 原始对象。
 * @returns 用量摘要；若无法识别则返回 `null`。
 */
function buildUsageSummary(
  candidate: Record<string, unknown>,
): UsageSnapshot | null {
  const used = pickNumber(candidate, [
    "used",
    "usage",
    "used_amount",
    "messages_used",
    "consumed",
  ]);
  const limit = pickNumber(candidate, [
    "limit",
    "quota",
    "message_limit",
    "hard_limit",
    "max_messages",
  ]);
  const remaining =
    pickNumber(candidate, ["remaining", "remaining_quota", "remaining_messages"]) ??
    (used !== null && limit !== null ? Math.max(limit - used, 0) : null);

  if (used === null && limit === null && remaining === null) {
    return null;
  }

  const percentUsed =
    used !== null && limit !== null && limit > 0 ? (used / limit) * 100 : null;

  return {
    unit:
      pickString(candidate, ["unit", "usage_unit", "billing_unit"]) ?? "requests",
    used,
    limit,
    remaining,
    percentUsed,
    windowLabel:
      pickString(candidate, ["window", "period", "reset_window", "billing_period"]) ??
      null,
  };
}

/**
 * 从未知结构中提取额度摘要。
 *
 * @param candidate 原始对象。
 * @returns 额度摘要；若无法识别则返回 `null`。
 */
function buildQuotaSummary(
  candidate: Record<string, unknown>,
): QuotaSnapshot | null {
  const hardLimit = pickNumber(candidate, ["hard_limit", "hardLimit", "quota"]);
  const softLimit = pickNumber(candidate, ["soft_limit", "softLimit"]);
  const remaining = pickNumber(candidate, ["remaining", "remaining_quota"]);
  const label = pickString(candidate, [
    "subscription_plan",
    "plan_type",
    "plan_name",
    "tier_name",
    "billing_period",
  ]);
  const periodEndsAt = pickString(candidate, [
    "period_end",
    "expires_at",
    "renews_at",
    "renew_at",
    "reset_at",
  ]);

  if (
    hardLimit === null &&
    softLimit === null &&
    remaining === null &&
    label === null &&
    periodEndsAt === null
  ) {
    return null;
  }

  return {
    label,
    hardLimit,
    softLimit,
    remaining,
    periodEndsAt,
  };
}

/**
 * 根据私有对象和归一化后的摘要推断健康状态。
 *
 * @param candidate 原始对象。
 * @param usageSummary 用量摘要。
 * @param quotaSummary 额度摘要。
 * @returns 统一的健康状态枚举。
 */
export function deriveHealth(
  candidate: Record<string, unknown>,
  usageSummary: UsageSnapshot | null,
  quotaSummary: QuotaSnapshot | null,
): SpaceCard["health"] {
  const disabledFlag =
    candidate["disabled"] === true ||
    candidate["unavailable"] === true ||
    candidate["exhausted"] === true;

  if (disabledFlag) {
    return "exhausted";
  }

  if (usageSummary?.remaining !== null && usageSummary?.remaining !== undefined) {
    if (usageSummary.remaining <= 0) {
      return "exhausted";
    }
  }

  const percentUsed = usageSummary?.percentUsed ?? null;
  if (percentUsed !== null && percentUsed >= 85) {
    return "warning";
  }

  if (
    quotaSummary?.remaining !== null &&
    quotaSummary?.remaining !== undefined &&
    quotaSummary.remaining <= 0
  ) {
    return "exhausted";
  }

  if (
    quotaSummary?.remaining !== null &&
    quotaSummary?.remaining !== undefined &&
    quotaSummary.remaining <= 15
  ) {
    return "warning";
  }

  if (usageSummary || quotaSummary) {
    return "healthy";
  }

  return "warning";
}

/**
 * 从候选对象中推断切换时可用的请求提示。
 *
 * @param candidate 原始对象。
 * @param id 目标空间 ID。
 * @returns 推断出的切换提示数组。
 */
function inferSwitchHints(
  candidate: Record<string, unknown>,
  id: string,
): SwitchHint[] {
  const hints: SwitchHint[] = [];
  const explicitPath = pickString(candidate, [
    "switch_path",
    "switch_endpoint",
  ]);

  if (explicitPath) {
    hints.push({
      method: "POST",
      path: explicitPath,
      body: {
        account_id: id,
      },
    });
  }

  return hints;
}

/**
 * 合并空间列表，保证同一空间 ID 只保留一份记录。
 *
 * @param target 目标数组。
 * @param incoming 新发现的空间。
 * @returns 无返回值。
 */
function mergeSpaces(target: SpaceRecord[], incoming: SpaceRecord[]): void {
  for (const record of incoming) {
    const existing = target.find((item) => item.id === record.id);
    if (!existing) {
      target.push(record);
      continue;
    }

    existing.name = existing.name.startsWith("未识别空间")
      ? record.name
      : existing.name;
    existing.kind = existing.kind === "unknown" ? record.kind : existing.kind;
    existing.usageSummary = existing.usageSummary ?? record.usageSummary;
    existing.quotaSummary = existing.quotaSummary ?? record.quotaSummary;
    if (existing.health === "warning" || existing.health === "error") {
      existing.health = record.health;
    }
    existing.rawDiagnostics.push(...record.rawDiagnostics);
    existing.switchHints.push(...record.switchHints);
  }
}

/**
 * 根据当前会话修正“当前激活空间”标记。
 *
 * @param spaces 目标空间列表。
 * @param session 当前会话。
 * @returns 无返回值。
 */
function normalizeActiveSpace(
  spaces: SpaceRecord[],
  session: CodexSession,
): void {
  if (!session.accountId) {
    if (spaces.length > 0) {
      spaces[0]!.isActive = true;
    }
    return;
  }

  const matched = spaces.find((space) => space.id === session.accountId);
  if (matched) {
    matched.isActive = true;
    return;
  }

  if (spaces.length > 0) {
    spaces[0]!.isActive = true;
    spaces[0]!.rawDiagnostics.push(
      "未能在探针结果中直接匹配 ChatGPT-Account-Id，已将首个空间视为当前激活空间。",
    );
  }
}

/**
 * 当所有探针都失败时，合成一个最低可用的空间列表。
 *
 * @param session 当前会话。
 * @param diagnostics 失败诊断。
 * @returns 至少包含一个当前会话空间的列表。
 */
function synthesizeFallbackSpaces(
  session: CodexSession,
  diagnostics: ProbeDiagnostic[],
): SpaceRecord[] {
  const inferredName = session.accountId
    ? `Current Account (${session.accountId.slice(0, 8)})`
    : "Current Account";

  return [
    {
      id: session.accountId ?? "current-account",
      name: inferredName,
      kind: "unknown",
      isActive: true,
      usageSummary: null,
      quotaSummary: null,
      health: "error",
      lastCheckedAt: new Date().toISOString(),
      rawDiagnostics: diagnostics.map(
        (item) => `[${item.ok ? "OK" : "ERR"}] ${item.path} -> ${item.note}`,
      ),
      switchHints: [],
    },
  ];
}

/**
 * 递归收集任意 JSON 结构中的对象节点。
 *
 * @param value 原始 JSON。
 * @returns 所有对象节点数组。
 */
function collectObjects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectObjects(item));
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  const current = value as Record<string, unknown>;
  return [
    current,
    ...Object.values(current).flatMap((item) => collectObjects(item)),
  ];
}

/**
 * 把本地会话里的额度快照补充到空间卡片。
 *
 * @param spaces 已发现的空间列表。
 * @param snapshots 按空间类型索引的本地额度快照。
 * @returns 无返回值。
 */
function applyLocalRateLimitSnapshots(
  spaces: SpaceRecord[],
  snapshots: Map<SpaceKind, LocalRateLimitSnapshot>,
): void {
  const singleSnapshot =
    snapshots.size === 1 ? [...snapshots.values()][0] ?? null : null;

  for (const space of spaces) {
    const snapshot =
      (space.kind !== "unknown" ? snapshots.get(space.kind) : null) ??
      (space.isActive ? singleSnapshot : null);
    if (!snapshot) {
      continue;
    }

    const localUsageSummary = toUsageSnapshot(snapshot);
    if (shouldApplyLocalUsage(space.usageSummary, localUsageSummary)) {
      space.usageSummary = localUsageSummary;
    }

    space.quotaSummary = mergeQuotaSummaries(
      space.quotaSummary,
      toQuotaSnapshot(snapshot, space.quotaSummary),
    );
    space.health = deriveHealth({}, space.usageSummary, space.quotaSummary);
    space.lastCheckedAt = new Date().toISOString();
    space.rawDiagnostics.unshift(formatSnapshotDiagnostic(snapshot));
  }
}

/**
 * 判断本地额度快照是否值得覆盖当前用量摘要。
 *
 * @param current 当前用量摘要。
 * @param incoming 本地额度快照生成的用量摘要。
 * @returns 当本地快照更完整时返回 `true`。
 */
function shouldApplyLocalUsage(
  current: UsageSnapshot | null,
  incoming: UsageSnapshot | null,
): boolean {
  return incoming !== null;
}

/**
 * 合并两份额度摘要，优先保留已有的订阅标签，同时补齐数字字段和重置时间。
 *
 * @param current 当前额度摘要。
 * @param incoming 新的本地额度摘要。
 * @returns 合并后的额度摘要。
 */
function mergeQuotaSummaries(
  current: QuotaSnapshot | null,
  incoming: QuotaSnapshot | null,
): QuotaSnapshot | null {
  if (!current) {
    return incoming;
  }

  if (!incoming) {
    return current;
  }

  return {
    label: current.label ?? incoming.label,
    hardLimit: current.hardLimit ?? incoming.hardLimit,
    softLimit: current.softLimit ?? incoming.softLimit,
    remaining: incoming.remaining ?? current.remaining,
    periodEndsAt: incoming.periodEndsAt ?? current.periodEndsAt,
  };
}
