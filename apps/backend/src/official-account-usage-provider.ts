import type {
  HealthStatus,
  OfficialUsageSnapshot,
  OfficialUsageWindow,
} from "../../../packages/shared/src/index.ts";
import { callInternalApi } from "./internal-api-client.ts";
import type { OfficialGatewayAccount } from "./gateway-account-store.ts";

/**
 * 本文件负责读取官方账号的实时额度状态。
 * 数据源直接来自 `GET /backend-api/wham/usage`，它比本地 rollout 更适合展示“当前 5 小时 / 一周剩余量”。
 */

/**
 * 拉取单个官方账号的远端额度快照。
 *
 * @param account 已经解析出有效登录态的官方账号。
 * @returns 标准化后的额度快照。
 * @throws 当请求失败或返回体无法识别时抛出异常。
 */
export async function loadOfficialUsageSnapshot(
  account: OfficialGatewayAccount,
): Promise<OfficialUsageSnapshot> {
  if (!account.session) {
    throw new Error("官方账号缺少可用登录态。");
  }

  const response = await callInternalApi<unknown>(account.session, "/backend-api/wham/usage", {
    headers: {
      Accept: "application/json",
      Referer: "https://chatgpt.com/codex/settings/usage",
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `官方额度接口返回 ${response.status}：${response.rawText.slice(0, 200)}`,
    );
  }

  const snapshot = parseOfficialUsagePayload(response.body);
  if (!snapshot) {
    throw new Error("官方额度接口返回体格式无法识别。");
  }

  return snapshot;
}

/**
 * 解析官方额度接口的返回体。
 *
 * @param payload 原始 JSON。
 * @returns 标准化后的额度快照；若关键字段缺失则返回 `null`。
 */
export function parseOfficialUsagePayload(
  payload: unknown,
): OfficialUsageSnapshot | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const rateLimit =
    typeof record["rate_limit"] === "object" &&
    record["rate_limit"] !== null &&
    !Array.isArray(record["rate_limit"])
      ? (record["rate_limit"] as Record<string, unknown>)
      : null;
  const credits =
    typeof record["credits"] === "object" &&
    record["credits"] !== null &&
    !Array.isArray(record["credits"])
      ? (record["credits"] as Record<string, unknown>)
      : null;

  const primary = toOfficialUsageWindow(rateLimit?.["primary_window"]);
  const secondary = toOfficialUsageWindow(rateLimit?.["secondary_window"]);
  const balance = toNumber(credits?.["balance"]);
  const planType =
    typeof record["plan_type"] === "string" ? record["plan_type"] : null;
  const allowed =
    typeof rateLimit?.["allowed"] === "boolean" ? rateLimit["allowed"] : null;
  const limitReached =
    typeof rateLimit?.["limit_reached"] === "boolean"
      ? rateLimit["limit_reached"]
      : null;

  if (!primary && !secondary && balance === null && planType === null) {
    return null;
  }

  return {
    planType,
    allowed,
    limitReached,
    balance,
    primary,
    secondary,
  };
}

/**
 * 根据官方额度快照推断用于 UI 的健康状态。
 *
 * @param snapshot 已解析的官方快照。
 * @returns 统一健康状态枚举。
 */
export function deriveOfficialHealth(
  snapshot: OfficialUsageSnapshot | null,
): HealthStatus {
  if (!snapshot) {
    return "error";
  }

  if (snapshot.limitReached || snapshot.allowed === false) {
    return "exhausted";
  }

  if ((snapshot.primary?.remainingPercent ?? 100) <= 0) {
    return "exhausted";
  }

  if ((snapshot.secondary?.remainingPercent ?? 100) <= 0) {
    return "exhausted";
  }

  if ((snapshot.primary?.remainingPercent ?? 100) <= 10) {
    return "warning";
  }

  if ((snapshot.secondary?.remainingPercent ?? 100) <= 10) {
    return "warning";
  }

  return "healthy";
}

/**
 * 将原始窗口结构转换成统一展示格式。
 *
 * @param value 原始窗口对象。
 * @returns 标准化后的窗口；缺失时返回 `null`。
 */
function toOfficialUsageWindow(value: unknown): OfficialUsageWindow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const usedPercent = toNumber(record["used_percent"]);
  const resetAtSeconds = toNumber(record["reset_at"]);

  if (usedPercent === null && resetAtSeconds === null) {
    return null;
  }

  return {
    usedPercent,
    remainingPercent:
      usedPercent === null ? null : Math.max(100 - usedPercent, 0),
    resetsAt:
      resetAtSeconds === null
        ? null
        : new Date(resetAtSeconds * 1000).toISOString(),
  };
}

/**
 * 把未知值转换成普通数字。
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
