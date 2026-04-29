import type {
  AccountBudgetSnapshot,
  AccountBudgetWindowSummary,
  AccountTokenQuotaWindowSummary,
  ThirdPartyBillingRule,
  ThirdPartyBudgetWindowKind,
  ThirdPartyTokenQuotaRule,
  UsageEventRecord,
} from "../../../packages/shared/src/index.ts";
import { estimateUsageEventCostUsd } from "./model-pricing.ts";

/**
 * 本文件负责根据本地 usage 事件，推导第三方账号的预算消耗与剩余额度。
 * 它只面向“账号级预算展示”，不负责账号配置的校验。
 */

interface WindowBounds {
  start: Date;
  end: Date;
}

type MoneyBudgetWindowKind =
  | ThirdPartyBudgetWindowKind
  | "weekly"
  | "cumulative";

/**
 * 根据第三方账号规则，计算当前预算窗口的展示摘要。
 *
 * @param events 当前账号的历史请求事件。
 * @param billingRule 账号级计费规则。
 * @param now 当前时间。
 * @returns 预算摘要；若未配置任何预算则返回 `null`。
 */
export function buildThirdPartyBudgetSnapshot(
  events: UsageEventRecord[],
  billingRule: ThirdPartyBillingRule | null | undefined,
  now: Date = new Date(),
): AccountBudgetSnapshot | null {
  const quotaRule = billingRule?.quota;
  if (!quotaRule) {
    return null;
  }

  const shortWindow =
    quotaRule.shortWindowBudgetUsd !== undefined
      ? buildBudgetWindowSummary(
          events,
          billingRule,
          quotaRule.shortWindowKind ?? "five_hour",
          quotaRule.shortWindowBudgetUsd,
          now,
        )
      : null;
  const weeklyWindow =
    quotaRule.weeklyBudgetUsd !== undefined
      ? buildBudgetWindowSummary(
          events,
          billingRule,
          "weekly",
          quotaRule.weeklyBudgetUsd,
          now,
        )
      : null;
  const totalBudget =
    quotaRule.totalBudgetUsd !== undefined
      ? buildBudgetWindowSummary(
          events,
          billingRule,
          "cumulative",
          quotaRule.totalBudgetUsd,
          now,
        )
      : null;
  const tokenWindow = quotaRule.tokenQuota
    ? buildTokenQuotaWindowSummary(events, quotaRule.tokenQuota, now)
    : null;

  if (!shortWindow && !weeklyWindow && !totalBudget && !tokenWindow) {
    return null;
  }

  return {
    shortWindow,
    weeklyWindow,
    totalBudget,
    tokenWindow,
  };
}

/**
 * 为某个预算窗口生成剩余额度摘要。
 *
 * @param events 目标账号的历史请求事件。
 * @param billingRule 账号级计费规则。
 * @param kind 窗口类型。
 * @param limitUsd 预算上限。
 * @param now 当前时间。
 * @returns 可直接发给前端的窗口摘要。
 */
function buildBudgetWindowSummary(
  events: UsageEventRecord[],
  billingRule: ThirdPartyBillingRule | null | undefined,
  kind: MoneyBudgetWindowKind,
  limitUsd: number,
  now: Date,
): AccountBudgetWindowSummary {
  const bounds = kind === "cumulative" ? null : getWindowBounds(kind, now);
  const spentUsd = sumWindowCost(events, billingRule, bounds);
  const remainingUsd = Math.max(limitUsd - spentUsd, 0);

  return {
    label: formatWindowLabel(kind),
    limitUsd,
    spentUsd,
    remainingUsd,
    resetsAt: bounds?.end.toISOString() ?? null,
  };
}

/**
 * 为 token 总额规则生成剩余额度摘要。
 *
 * @param events 目标账号的历史请求事件。
 * @param tokenQuota token 额度规则。
 * @param now 当前时间。
 * @returns 可直接发给前端的 token 窗口摘要。
 */
function buildTokenQuotaWindowSummary(
  events: UsageEventRecord[],
  tokenQuota: ThirdPartyTokenQuotaRule,
  now: Date,
): AccountTokenQuotaWindowSummary {
  const bounds = getTokenWindowBounds(tokenQuota, now);
  const usedTokens = sumWindowTokens(events, bounds);
  const remainingTokens = Math.max(tokenQuota.limitTokens - usedTokens, 0);

  return {
    label: formatTokenWindowLabel(tokenQuota),
    limitTokens: tokenQuota.limitTokens,
    usedTokens,
    remainingTokens,
    resetsAt: bounds.end.toISOString(),
  };
}

/**
 * 汇总某个预算窗口内的当前花费。
 *
 * @param events 账号事件。
 * @param billingRule 账号级计费规则。
 * @param bounds 窗口边界。
 * @returns 当前窗口累计消耗。
 */
function sumWindowCost(
  events: UsageEventRecord[],
  billingRule: ThirdPartyBillingRule | null | undefined,
  bounds: WindowBounds | null,
): number {
  return events.reduce((total, event) => {
    if (bounds && !isEventInsideBounds(event, bounds)) {
      return total;
    }

    return total + estimateUsageEventCostUsd(event, billingRule);
  }, 0);
}

/**
 * 汇总某个 token 额度窗口内的当前消耗。
 *
 * @param events 账号事件。
 * @param bounds 窗口边界。
 * @returns 当前窗口累计 token 数。
 */
function sumWindowTokens(
  events: UsageEventRecord[],
  bounds: WindowBounds,
): number {
  return events.reduce((total, event) => {
    if (!isEventInsideBounds(event, bounds)) {
      return total;
    }

    return total + Math.max(event.totalTokens, 0);
  }, 0);
}

/**
 * 判断事件时间是否落在目标窗口内。
 *
 * @param event 账号事件。
 * @param bounds 窗口边界。
 * @returns 命中窗口时返回 `true`。
 */
function isEventInsideBounds(
  event: UsageEventRecord,
  bounds: WindowBounds,
): boolean {
  const createdAt = new Date(event.createdAt);
  const timestamp = createdAt.getTime();
  return (
    !Number.isNaN(timestamp) &&
    timestamp >= bounds.start.getTime() &&
    timestamp < bounds.end.getTime()
  );
}

/**
 * 计算某个预算窗口在当前时刻的起止边界。
 *
 * @param kind 窗口类型。
 * @param now 当前时间。
 * @returns 起止时间。
 */
function getWindowBounds(
  kind: ThirdPartyBudgetWindowKind | "weekly",
  now: Date,
): WindowBounds {
  const current = new Date(now);

  if (kind === "daily") {
    const start = new Date(current);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
  }

  if (kind === "five_hour") {
    const start = new Date(current);
    const bucketHour = Math.floor(start.getHours() / 5) * 5;
    start.setHours(bucketHour, 0, 0, 0);
    const end = new Date(start);
    end.setHours(end.getHours() + 5);
    return { start, end };
  }

  const start = new Date(current);
  start.setHours(0, 0, 0, 0);
  const dayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - dayOffset);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

/**
 * 计算 token 额度窗口在当前时刻的起止边界。
 *
 * @param tokenQuota token 额度规则。
 * @param now 当前时间。
 * @returns 起止时间。
 */
function getTokenWindowBounds(
  tokenQuota: ThirdPartyTokenQuotaRule,
  now: Date,
): WindowBounds {
  if (tokenQuota.windowKind === "monthly") {
    return getMonthlyWindowBounds(now);
  }

  // 归一化层会拦截未知类型；这里保留兜底，避免未来扩展时出现无声错算。
  return getMonthlyWindowBounds(now);
}

/**
 * 计算自然月窗口边界。
 *
 * @param now 当前时间。
 * @returns 当地时区自然月的起止时间。
 */
function getMonthlyWindowBounds(now: Date): WindowBounds {
  const current = new Date(now);
  const start = new Date(current.getFullYear(), current.getMonth(), 1);
  const end = new Date(current.getFullYear(), current.getMonth() + 1, 1);
  return { start, end };
}

/**
 * 把窗口类型翻译成展示标签。
 *
 * @param kind 窗口类型。
 * @returns 中文标签。
 */
function formatWindowLabel(kind: MoneyBudgetWindowKind): string {
  if (kind === "daily") {
    return "今日剩余额度";
  }

  if (kind === "five_hour") {
    return "5 小时剩余额度";
  }

  if (kind === "cumulative") {
    return "总金额剩余额度";
  }

  return "本周剩余额度";
}

/**
 * 把 token 窗口类型翻译成展示标签。
 *
 * @param tokenQuota token 额度规则。
 * @returns 中文标签。
 */
function formatTokenWindowLabel(
  tokenQuota: ThirdPartyTokenQuotaRule,
): string {
  if (tokenQuota.windowKind === "monthly") {
    return "本月 Token 剩余";
  }

  return "Token 剩余额度";
}
