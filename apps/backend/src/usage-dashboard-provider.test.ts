import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateUsageTotals,
  buildUsageDashboardSummary,
  listRecentUsageEvents,
} from "./usage-dashboard-provider.ts";

/**
 * 本文件验证本地代理事件在筛选和时间窗口上的聚合逻辑。
 * 这里最容易出错的是“账号筛选”和“最近 5 小时/7 天”的窗口边界，因此测试会把这两类行为一起锁住。
 */

const accounts = [
  {
    id: "official-a",
    name: "官方账号 A",
    kind: "official",
    isActive: true,
    health: "healthy",
    statusLabel: "Official Plus",
    lastCheckedAt: null,
    officialUsage: null,
    thirdPartyBillingRule: null,
    thirdPartyBudgetSnapshot: null,
    cumulativeUsage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      requests: 0,
      totalLatencyMs: 0,
      tokenRatePerSecond: 0,
    },
    rawDiagnostics: [],
  },
  {
    id: "official-b",
    name: "官方账号 B",
    kind: "official",
    isActive: false,
    health: "healthy",
    statusLabel: "Official Team",
    lastCheckedAt: null,
    officialUsage: null,
    thirdPartyBillingRule: null,
    thirdPartyBudgetSnapshot: null,
    cumulativeUsage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      requests: 0,
      totalLatencyMs: 0,
      tokenRatePerSecond: 0,
    },
    rawDiagnostics: [],
  },
  {
    id: "third-party-x",
    name: "第三方账号",
    kind: "third_party",
    isActive: false,
    health: "healthy",
    statusLabel: "第三方路由可用",
    lastCheckedAt: null,
    officialUsage: null,
    thirdPartyBillingRule: {
      pricing: {
        inputPerMillionUsd: 1,
        cachedInputPerMillionUsd: 0.1,
        outputPerMillionUsd: 2,
      },
      quota: {
        shortWindowBudgetUsd: 3,
        shortWindowKind: "five_hour",
        weeklyBudgetUsd: 20,
      },
    },
    thirdPartyBudgetSnapshot: null,
    cumulativeUsage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      requests: 0,
      totalLatencyMs: 0,
      tokenRatePerSecond: 0,
    },
    rawDiagnostics: [],
  },
];

const events = [
  {
    id: "evt-1",
    accountId: "official-a",
    accountName: "官方账号 A",
    accountKind: "official",
    model: "gpt-5.4",
    inputTokens: 1000,
    cachedInputTokens: 200,
    outputTokens: 300,
    totalTokens: 1300,
    estimatedCostUsd: 0.01,
    status: "completed",
    latencyMs: 600,
    tokenRatePerSecond: 500,
    createdAt: "2026-04-17T04:30:00.000Z",
  },
  {
    id: "evt-2",
    accountId: "official-b",
    accountName: "官方账号 B",
    accountKind: "official",
    model: "gpt-5.3-codex",
    inputTokens: 2000,
    cachedInputTokens: 0,
    outputTokens: 500,
    totalTokens: 2500,
    estimatedCostUsd: 0.02,
    status: "completed",
    latencyMs: 700,
    tokenRatePerSecond: 714.2857142857143,
    createdAt: "2026-04-12T05:30:00.000Z",
  },
  {
    id: "evt-3",
    accountId: "third-party-x",
    accountName: "第三方账号",
    accountKind: "third_party",
    model: "gpt-5.4-mini",
    inputTokens: 500,
    cachedInputTokens: 100,
    outputTokens: 100,
    totalTokens: 600,
    estimatedCostUsd: 0.005,
    status: "completed",
    latencyMs: 320,
    tokenRatePerSecond: 312.5,
    createdAt: "2026-04-17T06:40:00.000Z",
  },
];

test("应能按账号类型筛选并聚合累计 totals", () => {
  const summary = buildUsageDashboardSummary(
    events,
    accounts,
    "kind:official",
    new Date("2026-04-17T07:00:00.000Z"),
  );

  assert.equal(summary.cumulative.totals.requests, 2);
  assert.equal(summary.cumulative.totals.inputTokens, 3000);
  assert.equal(summary.cumulative.totals.outputTokens, 800);
  // token 速率表达模型生成速度，不能把输入上下文 token 计入分子，否则长上下文请求会被严重高估。
  assert.equal(summary.cumulative.totals.totalLatencyMs, 1300);
  assert.ok(Math.abs(summary.cumulative.totals.tokenRatePerSecond - 615.3846) < 1e-4);
  // today 窗口：now=2026-04-17T07:00:00Z（北京时间 15:00），当天零点之后的官方事件只有 evt-1
  assert.equal(summary.today.totals.requests, 1);
  assert.equal(summary.today.totals.inputTokens, 1000);
  assert.equal(summary.last5Hours.totals.requests, 1);
  assert.equal(summary.last7Days.totals.requests, 2);
});

test("应能按单个账号筛选最近事件", () => {
  const totals = aggregateUsageTotals(
    events.filter((event) => event.accountId === "third-party-x"),
    accounts,
  );

  assert.equal(totals.requests, 1);
  assert.equal(totals.cachedInputTokens, 100);
  assert.equal(totals.totalTokens, 600);
  assert.equal(totals.totalLatencyMs, 320);
  assert.equal(totals.tokenRatePerSecond, 312.5);
  assert.ok(Math.abs(totals.estimatedCostUsd - 0.00061) < 1e-12);
});

test("第三方账号最近事件应按当前账号计费规则重新计算费用", () => {
  const summary = buildUsageDashboardSummary(
    events,
    accounts,
    "account:third-party-x",
    new Date("2026-04-17T07:00:00.000Z"),
  );

  assert.equal(summary.cumulative.totals.requests, 1);
  assert.ok(Math.abs(summary.cumulative.totals.estimatedCostUsd - 0.00061) < 1e-12);
});

test("最近请求会按输出 token 重新计算速率，兼容旧版落盘字段", () => {
  const recentEvents = listRecentUsageEvents(
    [
      {
        ...events[2]!,
        // 旧版本曾按 totalTokens / latencyMs 落盘，API 返回前需要修正为输出速率。
        tokenRatePerSecond: 1875,
      },
    ],
    accounts,
    "all",
    1,
  );

  assert.equal(recentEvents[0]?.tokenRatePerSecond, 312.5);
});
