import test from "node:test";
import assert from "node:assert/strict";

import {
  formatSnapshotDiagnostic,
  normalizeSnapshotForDisplay,
  parseRateLimitSnapshotLine,
  toQuotaSnapshot,
  toUsageSnapshot,
} from "./local-rate-limit-provider.ts";

/**
 * 本文件固定本地 `rate_limits` 快照的解析与映射逻辑。
 * 这样一来，即使私有事件结构以后有小幅波动，我们也能第一时间发现额度面板会不会再次退化成空白。
 */

test("应能从 token_count 事件中解析 plus 额度快照", () => {
  const line = JSON.stringify({
    timestamp: "2026-03-31T12:04:36.320Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        plan_type: "plus",
        primary: {
          used_percent: 33,
          window_minutes: 300,
          resets_at: 1774974899,
        },
        secondary: {
          used_percent: 10,
          window_minutes: 10080,
          resets_at: 1775561699,
        },
      },
    },
  });

  const snapshot = parseRateLimitSnapshotLine(line, "/tmp/plus.jsonl");

  assert.ok(snapshot);
  assert.equal(snapshot.kind, "plus");
  assert.equal(snapshot.primary?.usedPercent, 33);
  assert.equal(snapshot.secondary?.windowMinutes, 10080);
});

test("应把本地额度快照映射成可展示的百分比摘要", () => {
  const snapshot = parseRateLimitSnapshotLine(
    JSON.stringify({
      timestamp: "2026-03-31T11:21:52.392Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          plan_type: "team",
          primary: {
            used_percent: 87,
            window_minutes: 300,
            resets_at: 1774966077,
          },
          secondary: {
            used_percent: 26,
            window_minutes: 10080,
            resets_at: 1775552877,
          },
        },
      },
    }),
    "/tmp/team.jsonl",
  );

  assert.ok(snapshot);

  const usage = toUsageSnapshot(snapshot);
  const quota = toQuotaSnapshot(snapshot, null);
  const diagnostic = formatSnapshotDiagnostic(snapshot);

  assert.deepEqual(usage, {
    unit: "%",
    used: 26,
    limit: 100,
    remaining: 74,
    percentUsed: 26,
    windowLabel: "1 周窗口",
  });
  assert.equal(quota.label, "team");
  assert.equal(quota.remaining, 13);
  assert.match(diagnostic, /5 小时窗口 87% \/ 5 小时窗口；周窗口 26% \/ 1 周窗口/);
});

test("本地 5 小时窗口重置后，应覆盖旧的剩余额度字段", () => {
  const snapshot = parseRateLimitSnapshotLine(
    JSON.stringify({
      timestamp: "2026-04-01T01:43:29.373Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          plan_type: "plus",
          primary: {
            used_percent: 0,
            window_minutes: 300,
            resets_at: 1775025762,
          },
          secondary: {
            used_percent: 30,
            window_minutes: 10080,
            resets_at: 1775561699,
          },
        },
      },
    }),
    "/tmp/plus-reset.jsonl",
  );

  assert.ok(snapshot);

  const quota = toQuotaSnapshot(snapshot, {
    label: "plus",
    hardLimit: 100,
    softLimit: null,
    remaining: 5,
    periodEndsAt: "2026-03-31T16:34:59.000Z",
  });

  assert.equal(quota.remaining, 100);
  assert.equal(quota.periodEndsAt, "2026-04-01T06:42:42.000Z");
});

test("过期的 5 小时窗口快照应显示为已重置，并顺延到下一次重置时间", () => {
  const snapshot = parseRateLimitSnapshotLine(
    JSON.stringify({
      timestamp: "2026-03-31T11:21:52.392Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          plan_type: "team",
          primary: {
            used_percent: 87,
            window_minutes: 300,
            resets_at: 1774966077,
          },
          secondary: {
            used_percent: 26,
            window_minutes: 10080,
            resets_at: 1775552877,
          },
        },
      },
    }),
    "/tmp/team-expired.jsonl",
  );

  assert.ok(snapshot);

  const normalized = normalizeSnapshotForDisplay(
    snapshot,
    new Date("2026-04-01T02:13:43.000Z"),
  );

  assert.equal(normalized.primary?.usedPercent, 0);
  assert.equal(normalized.primary?.resetsAt, "2026-04-01T05:07:57.000Z");
  assert.equal(normalized.secondary?.usedPercent, 26);
});
