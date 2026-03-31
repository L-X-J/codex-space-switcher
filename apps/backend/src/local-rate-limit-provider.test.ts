import test from "node:test";
import assert from "node:assert/strict";

import {
  formatSnapshotDiagnostic,
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
