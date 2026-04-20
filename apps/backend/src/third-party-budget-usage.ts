import type {
  AccountBudgetSnapshot,
  AccountBudgetWindowSummary,
  ThirdPartyBillingRule,
  ThirdPartyBudgetWindowKind,
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

  if (!shortWindow && !weeklyWindow) {
    return null;
  }

  return {
    shortWindow,
    weeklyWindow,
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
  kind: ThirdPartyBudgetWindowKind | "weekly",
  limitUsd: number,
  now: Date,
): AccountBudgetWindowSummary {
  const bounds = getWindowBounds(kind, now);
  const spentUsd = sumWindowCost(events, billingRule, bounds);
  const remainingUsd = Math.max(limitUsd - spentUsd, 0);

  return {
    label: formatWindowLabel(kind),
    limitUsd,
    spentUsd,
    remainingUsd,
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
  bounds: WindowBounds,
): number {
  return events.reduce((total, event) => {
    const createdAt = new Date(event.createdAt);
    const timestamp = createdAt.getTime();
    if (
      Number.isNaN(timestamp) ||
      timestamp < bounds.start.getTime() ||
      timestamp >= bounds.end.getTime()
    ) {
      return total;
    }

    return total + estimateUsageEventCostUsd(event, billingRule);
  }, 0);
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
 * 把窗口类型翻译成展示标签。
 *
 * @param kind 窗口类型。
 * @returns 中文标签。
 */
function formatWindowLabel(kind: ThirdPartyBudgetWindowKind | "weekly"): string {
  if (kind === "daily") {
    return "今日剩余额度";
  }

  if (kind === "five_hour") {
    return "5 小时剩余额度";
  }

  return "本周剩余额度";
}
