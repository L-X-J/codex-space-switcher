import type {
  AccountCard,
  AccountUsageTotals,
  UsageEventRecord,
  UsageDashboardSummary,
  UsageDashboardWindow,
  UsageFilterOption,
} from "../../../packages/shared/src/index.ts";
import { estimateUsageEventCostUsd } from "./model-pricing.ts";

/**
 * 本文件负责把代理事件聚合成前端看板所需的筛选结果。
 * 这里不依赖任何私有接口，完全由本地审计事件构建。
 */

/**
 * 根据当前账号列表构建前端可选的筛选项。
 *
 * @param accounts 当前账号卡片。
 * @returns 已排序的筛选项数组。
 */
export function buildUsageFilters(accounts: AccountCard[]): UsageFilterOption[] {
  const filters: UsageFilterOption[] = [
    {
      id: "all",
      label: "全部账号",
      kind: "all",
      accountId: null,
      accountKind: null,
    },
  ];

  if (accounts.some((account) => account.kind === "official")) {
    filters.push({
      id: "kind:official",
      label: "全部官方账号",
      kind: "account_kind",
      accountId: null,
      accountKind: "official",
    });
  }

  if (accounts.some((account) => account.kind === "third_party")) {
    filters.push({
      id: "kind:third_party",
      label: "全部第三方账号",
      kind: "account_kind",
      accountId: null,
      accountKind: "third_party",
    });
  }

  for (const account of accounts) {
    filters.push({
      id: `account:${account.id}`,
      label: account.name,
      kind: "account",
      accountId: account.id,
      accountKind: account.kind,
    });
  }

  return filters;
}

/**
 * 聚合某个筛选结果下的完整统计面板数据。
 *
 * @param events 本地代理事件。
 * @param accounts 当前账号卡片。
 * @param selectedFilterId 当前选中的筛选项。
 * @param now 用于窗口计算的当前时间。
 * @returns 适合直接返回给前端的统计摘要。
 */
export function buildUsageDashboardSummary(
  events: UsageEventRecord[],
  accounts: AccountCard[],
  selectedFilterId: string,
  now: Date = new Date(),
): UsageDashboardSummary {
  const filters = buildUsageFilters(accounts);
  const selectedFilter =
    filters.find((filter) => filter.id === selectedFilterId) ?? filters[0]!;
  const filteredEvents = events.filter((event) => matchesFilter(event, selectedFilter));
  const last5HoursStart = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  const last7DaysStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  return {
    generatedAt: now.toISOString(),
    selectedFilterId: selectedFilter.id,
    filters,
    cumulative: buildWindow("累计用量", filteredEvents, accounts, now),
    last5Hours: buildWindow(
      "最近 5 小时",
      filteredEvents.filter(
        (event) => new Date(event.createdAt).getTime() >= last5HoursStart.getTime(),
      ),
      accounts,
      now,
      last5HoursStart,
    ),
    last7Days: buildWindow(
      "最近 7 天",
      filteredEvents.filter(
        (event) => new Date(event.createdAt).getTime() >= last7DaysStart.getTime(),
      ),
      accounts,
      now,
      last7DaysStart,
    ),
  };
}

/**
 * 列出当前筛选结果下最近的代理事件。
 *
 * @param events 本地代理事件。
 * @param accounts 当前账号卡片。
 * @param selectedFilterId 当前选中的筛选项。
 * @param limit 最多返回多少条。
 * @returns 按时间倒序排列的事件数组。
 */
export function listRecentUsageEvents(
  events: UsageEventRecord[],
  accounts: AccountCard[],
  selectedFilterId: string,
  limit: number,
): UsageEventRecord[] {
  const filters = buildUsageFilters(accounts);
  const selectedFilter =
    filters.find((filter) => filter.id === selectedFilterId) ?? filters[0]!;
  const accountsById = buildAccountMap(accounts);

  return [...events]
    .filter((event) => matchesFilter(event, selectedFilter))
    .map((event) => ({
      ...event,
      estimatedCostUsd: resolveEventCostUsd(event, accountsById),
    }))
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    )
    .slice(0, limit);
}

/**
 * 把一组事件求和为统一 totals 结构。
 *
 * @param events 待聚合事件数组。
 * @returns 聚合后的 totals。
 */
export function aggregateUsageTotals(
  events: UsageEventRecord[],
  accounts: AccountCard[] = [],
): AccountUsageTotals {
  const accountsById = buildAccountMap(accounts);
  return events.reduce<AccountUsageTotals>(
    (totals, event) => {
      totals.inputTokens += event.inputTokens;
      totals.cachedInputTokens += event.cachedInputTokens;
      totals.outputTokens += event.outputTokens;
      totals.totalTokens += event.totalTokens;
      totals.estimatedCostUsd += resolveEventCostUsd(event, accountsById);
      totals.requests += 1;
      return totals;
    },
    createEmptyUsageTotals(),
  );
}

/**
 * 创建一个全零 totals 结构。
 *
 * @returns 可用于累加的空统计。
 */
export function createEmptyUsageTotals(): AccountUsageTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    requests: 0,
  };
}

/**
 * 判断事件是否命中当前筛选条件。
 *
 * @param event 单条代理事件。
 * @param filter 当前筛选项。
 * @returns 命中时返回 `true`。
 */
function matchesFilter(
  event: UsageEventRecord,
  filter: UsageFilterOption,
): boolean {
  if (filter.kind === "all") {
    return true;
  }

  if (filter.kind === "account_kind") {
    return event.accountKind === filter.accountKind;
  }

  return event.accountId === filter.accountId;
}

/**
 * 构建某个时间窗口的聚合结果。
 *
 * @param label 窗口标签。
 * @param events 已筛选后的事件数组。
 * @param now 当前时间。
 * @param windowStart 指定窗口起点；累计窗口可不传。
 * @returns 统一窗口结构。
 */
function buildWindow(
  label: string,
  events: UsageEventRecord[],
  accounts: AccountCard[],
  now: Date,
  windowStart?: Date,
): UsageDashboardWindow {
  const sorted = [...events].sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );

  return {
    label,
    windowStart:
      windowStart?.toISOString() ?? sorted[0]?.createdAt ?? null,
    windowEnd: sorted.length > 0 ? now.toISOString() : null,
    totals: aggregateUsageTotals(events, accounts),
  };
}

/**
 * 建立按账号 ID 索引的卡片映射，便于复用账号级计费规则。
 *
 * @param accounts 账号卡片数组。
 * @returns 账号索引表。
 */
function buildAccountMap(accounts: AccountCard[]): Map<string, AccountCard> {
  return new Map(accounts.map((account) => [account.id, account]));
}

/**
 * 用当前账号配置重新推导单条事件的费用。
 *
 * @param event 已落盘的 usage 事件。
 * @param accountsById 当前账号索引。
 * @returns 当前口径下的估算费用。
 */
function resolveEventCostUsd(
  event: UsageEventRecord,
  accountsById: Map<string, AccountCard>,
): number {
  const account = accountsById.get(event.accountId);
  if (account?.kind === "third_party") {
    return estimateUsageEventCostUsd(event, account.thirdPartyBillingRule ?? null);
  }

  return estimateUsageEventCostUsd(event, null);
}
