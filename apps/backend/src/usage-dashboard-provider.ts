import type {
  AccountCard,
  AccountUsageTotals,
  UsageEventRecord,
  UsageDashboardSummary,
  UsageDashboardWindow,
  UsageFilterOption,
} from "../../../packages/shared/src/index.ts";
import { estimateUsageEventCostUsd } from "./model-pricing.ts";
import { buildTokenRateMetrics, calculateTokenRatePerSecond } from "./token-rate.ts";

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
  // 当天零点，按本地时区计算
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const last5HoursStart = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  const last7DaysStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  return {
    generatedAt: now.toISOString(),
    selectedFilterId: selectedFilter.id,
    filters,
    cumulative: buildWindow("累计用量", filteredEvents, accounts, now),
    today: buildWindow(
      "今天",
      filteredEvents.filter(
        (event) => new Date(event.createdAt).getTime() >= todayStart.getTime(),
      ),
      accounts,
      now,
      todayStart,
    ),
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
    .map((event) => normalizeUsageEventForDashboard(event, accountsById))
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
  const accumulator = events.reduce<UsageTotalsAccumulator>(
    (accumulator, event) => {
      const normalizedEvent = normalizeUsageEventForDashboard(event, accountsById);
      const rateDurationMs = resolveRateDurationMs(normalizedEvent);

      accumulator.inputTokens += normalizedEvent.inputTokens;
      accumulator.cachedInputTokens += normalizedEvent.cachedInputTokens;
      accumulator.outputTokens += normalizedEvent.outputTokens;
      accumulator.totalTokens += normalizedEvent.totalTokens;
      accumulator.estimatedCostUsd += normalizedEvent.estimatedCostUsd;
      accumulator.requests += 1;
      accumulator.totalLatencyMs += normalizeLatencyMs(normalizedEvent.latencyMs);
      accumulator.totalOutputDurationMs += normalizeLatencyMs(
        normalizedEvent.outputDurationMs,
      );
      accumulator.rateDurationMs += rateDurationMs;

      if (normalizedEvent.firstOutputLatencyMs !== null) {
        accumulator.firstOutputLatencySumMs += normalizedEvent.firstOutputLatencyMs;
        accumulator.firstOutputLatencySamples += 1;
      }

      return accumulator;
    },
    createEmptyUsageTotalsAccumulator(),
  );

  return finalizeUsageTotals(accumulator);
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
    totalLatencyMs: 0,
    totalOutputDurationMs: 0,
    averageFirstOutputLatencyMs: null,
    tokenRatePerSecond: 0,
  };
}

interface UsageTotalsAccumulator extends AccountUsageTotals {
  firstOutputLatencySumMs: number;
  firstOutputLatencySamples: number;
  rateDurationMs: number;
}

/**
 * 创建聚合过程使用的内部累加器。
 *
 * @returns 带内部计数字段的空统计。
 */
function createEmptyUsageTotalsAccumulator(): UsageTotalsAccumulator {
  return {
    ...createEmptyUsageTotals(),
    firstOutputLatencySumMs: 0,
    firstOutputLatencySamples: 0,
    rateDurationMs: 0,
  };
}

/**
 * 把内部累加器收敛成前端契约需要的 totals。
 *
 * @param accumulator 已累加的 token、耗时和首字样本。
 * @returns 对外返回的统计结构。
 */
function finalizeUsageTotals(
  accumulator: UsageTotalsAccumulator,
): AccountUsageTotals {
  const {
    firstOutputLatencySumMs,
    firstOutputLatencySamples,
    rateDurationMs,
    ...totals
  } = accumulator;

  totals.averageFirstOutputLatencyMs =
    firstOutputLatencySamples > 0
      ? firstOutputLatencySumMs / firstOutputLatencySamples
      : null;
  totals.tokenRatePerSecond = calculateWindowTokenRatePerSecond(
    totals.outputTokens,
    rateDurationMs,
  );
  return totals;
}

/**
 * 计算一个统计窗口的加权输出 token 速率。
 *
 * @param outputTokens 已聚合的输出 token。
 * @param rateDurationMs 已聚合的有效生成周期。
 * @returns token/秒；没有有效耗时时返回 0。
 */
function calculateWindowTokenRatePerSecond(
  outputTokens: number,
  rateDurationMs: number,
): number {
  return calculateTokenRatePerSecond(outputTokens, rateDurationMs);
}

/**
 * 为看板规整单条事件，兼容旧版缺少首字耗时或错误速率的落盘记录。
 *
 * @param event 单条代理事件。
 * @param accountsById 当前账号索引。
 * @returns 按当前口径修正费用和速率后的事件。
 */
function normalizeUsageEventForDashboard(
  event: UsageEventRecord,
  accountsById: Map<string, AccountCard>,
): UsageEventRecord {
  const rateMetrics = buildTokenRateMetrics({
    outputTokens: event.outputTokens,
    latencyMs: event.latencyMs,
    firstOutputLatencyMs: event.firstOutputLatencyMs ?? null,
    outputDurationMs: event.outputDurationMs ?? null,
  });

  return {
    ...event,
    estimatedCostUsd: resolveEventCostUsd(event, accountsById),
    firstOutputLatencyMs: rateMetrics.firstOutputLatencyMs,
    outputDurationMs: rateMetrics.outputDurationMs,
    tokenRatePerSecond: rateMetrics.tokenRatePerSecond,
  };
}

/**
 * 选择单条事件参与速率聚合的时间周期。
 *
 * @param event 已按当前口径规整的事件。
 * @returns 优先返回首字到结束的生成周期，缺失时回退到整次请求耗时。
 */
function resolveRateDurationMs(event: UsageEventRecord): number {
  return normalizeLatencyMs(event.outputDurationMs) || normalizeLatencyMs(event.latencyMs);
}

/**
 * 规整历史事件中的耗时字段。
 *
 * @param latencyMs 事件落盘时记录的请求耗时。
 * @returns 可用于聚合的非负毫秒数。
 */
function normalizeLatencyMs(latencyMs: number | null | undefined): number {
  if (
    typeof latencyMs !== "number" ||
    !Number.isFinite(latencyMs) ||
    latencyMs <= 0
  ) {
    return 0;
  }

  return latencyMs;
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
