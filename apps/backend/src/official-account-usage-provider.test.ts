import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveOfficialHealth,
  parseOfficialUsagePayload,
} from "./official-account-usage-provider.ts";

/**
 * 本文件固定官方账号额度接口的解析行为。
 * 只要 `/backend-api/wham/usage` 的结构还能维持现有语义，这些测试就能保证看板里的 5 小时和周剩余不会再次漂移。
 */

test("应能解析官方额度接口中的 5 小时与一周窗口", () => {
  const snapshot = parseOfficialUsagePayload({
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 18,
        reset_at: 1776429107,
      },
      secondary_window: {
        used_percent: 31,
        reset_at: 1776681520,
      },
    },
    credits: {
      balance: "0",
    },
  });

  assert.ok(snapshot);
  assert.equal(snapshot.planType, "plus");
  assert.equal(snapshot.primary?.remainingPercent, 82);
  assert.equal(snapshot.secondary?.remainingPercent, 69);
  assert.equal(snapshot.balance, 0);
});

test("当官方账号周窗口耗尽时应判定为 exhausted", () => {
  const health = deriveOfficialHealth({
    planType: "team",
    allowed: true,
    limitReached: true,
    balance: 0,
    primary: {
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: null,
    },
    secondary: {
      usedPercent: 100,
      remainingPercent: 0,
      resetsAt: null,
    },
  });

  assert.equal(health, "exhausted");
});
