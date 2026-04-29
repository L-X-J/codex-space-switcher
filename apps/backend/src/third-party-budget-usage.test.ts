import test from "node:test";
import assert from "node:assert/strict";

import type {
  ThirdPartyBillingRule,
  UsageEventRecord,
} from "../../../packages/shared/src/index.ts";
import { buildThirdPartyBudgetSnapshot } from "./third-party-budget-usage.ts";

/**
 * 本文件验证第三方账号额度快照的本地扣减逻辑。
 * 新增额度类型不依赖第三方平台余额接口，因此必须通过本地审计事件稳定复现总金额和月度 token 的边界。
 */

/**
 * 构造一条最小可用的 usage 事件。
 *
 * @param overrides 需要覆盖的事件字段。
 * @returns 可参与额度聚合的事件。
 */
function createUsageEvent(
  overrides: Partial<UsageEventRecord>,
): UsageEventRecord {
  return {
    id: "evt-default",
    accountId: "third-party-a",
    accountName: "第三方账号",
    accountKind: "third_party",
    model: "gpt-5.4-mini",
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    status: "completed",
    latencyMs: 0,
    firstOutputLatencyMs: null,
    outputDurationMs: null,
    tokenRatePerSecond: 0,
    createdAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

test("总金额额度应按全部历史事件累计扣减且不设置重置时间", () => {
  const billingRule: ThirdPartyBillingRule = {
    pricing: {
      inputPerMillionUsd: 1,
      cachedInputPerMillionUsd: 0.1,
      outputPerMillionUsd: 2,
    },
    quota: {
      totalBudgetUsd: 2,
    },
  };
  const snapshot = buildThirdPartyBudgetSnapshot(
    [
      createUsageEvent({
        id: "evt-old",
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        totalTokens: 1_100_000,
        createdAt: "2026-03-01T00:00:00.000Z",
      }),
      createUsageEvent({
        id: "evt-current",
        inputTokens: 500_000,
        outputTokens: 100_000,
        totalTokens: 600_000,
        createdAt: "2026-04-15T00:00:00.000Z",
      }),
    ],
    billingRule,
    new Date("2026-04-20T12:00:00.000Z"),
  );

  assert.equal(snapshot?.totalBudget?.label, "总金额剩余额度");
  assert.equal(snapshot?.totalBudget?.resetsAt, null);
  assert.ok(Math.abs((snapshot?.totalBudget?.spentUsd ?? 0) - 1.9) < 1e-12);
  assert.ok(Math.abs((snapshot?.totalBudget?.remainingUsd ?? 0) - 0.1) < 1e-12);
});

test("每月 token 额度只统计当前自然月内的 totalTokens", () => {
  const now = new Date(2026, 3, 20, 12, 0, 0);
  const previousMonthEventAt = new Date(2026, 2, 31, 23, 0, 0).toISOString();
  const currentMonthStartEventAt = new Date(2026, 3, 1, 0, 0, 0).toISOString();
  const currentMonthEventAt = new Date(2026, 3, 15, 10, 0, 0).toISOString();
  const nextMonthStartAt = new Date(2026, 4, 1, 0, 0, 0).toISOString();
  const billingRule: ThirdPartyBillingRule = {
    quota: {
      tokenQuota: {
        limitTokens: 200_000_000,
        windowKind: "monthly",
      },
    },
  };
  const snapshot = buildThirdPartyBudgetSnapshot(
    [
      createUsageEvent({
        id: "evt-march",
        totalTokens: 90_000_000,
        createdAt: previousMonthEventAt,
      }),
      createUsageEvent({
        id: "evt-april-a",
        totalTokens: 120_000_000,
        createdAt: currentMonthStartEventAt,
      }),
      createUsageEvent({
        id: "evt-april-b",
        totalTokens: 50_000_000,
        createdAt: currentMonthEventAt,
      }),
    ],
    billingRule,
    now,
  );

  assert.equal(snapshot?.tokenWindow?.label, "本月 Token 剩余");
  assert.equal(snapshot?.tokenWindow?.usedTokens, 170_000_000);
  assert.equal(snapshot?.tokenWindow?.remainingTokens, 30_000_000);
  assert.equal(snapshot?.tokenWindow?.resetsAt, nextMonthStartAt);
});
