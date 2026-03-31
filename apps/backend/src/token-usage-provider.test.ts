import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTokenUsageSummary,
  parseTokenUsageLine,
} from "./token-usage-provider.ts";

/**
 * 本文件验证 token 用量统计的解析与聚合逻辑。
 * 这里最关键的风险是把同一 rollout 内的累计值重复相加，所以测试会固定“按 rollout 取单次最大累计值”的规则。
 */

test("应优先使用 total_token_usage 作为 rollout 累计 token", () => {
  const parsed = parseTokenUsageLine(
    JSON.stringify({
      timestamp: "2026-03-31T11:21:52.392Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 500,
            cached_input_tokens: 120,
            output_tokens: 30,
            reasoning_output_tokens: 10,
            total_tokens: 530,
          },
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 0,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 120,
          },
        },
        rate_limits: {
          plan_type: "team",
        },
      },
    }),
    "/tmp/team-rollout.jsonl",
  );

  assert.ok(parsed);
  assert.equal(parsed.kind, "team");
  assert.equal(parsed.totals.totalTokens, 530);
  assert.equal(parsed.totals.cachedInputTokens, 120);
});

test("当 total_token_usage 仍为 0 时应回退到 last_token_usage", () => {
  const parsed = parseTokenUsageLine(
    JSON.stringify({
      timestamp: "2026-03-31T12:03:12.210Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 0,
          },
          last_token_usage: {
            input_tokens: 15208,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 15208,
          },
        },
        rate_limits: {
          plan_type: "plus",
        },
      },
    }),
    "/tmp/plus-rollout.jsonl",
  );

  assert.ok(parsed);
  assert.equal(parsed.kind, "plus");
  assert.equal(parsed.totals.totalTokens, 15208);
});

test("应按今日与近七天窗口聚合 token，并保留空间拆分", () => {
  const summary = buildTokenUsageSummary(
    [
      {
        capturedAt: "2026-03-31T09:00:00.000Z",
        kind: "plus",
        totals: {
          inputTokens: 1000,
          cachedInputTokens: 100,
          outputTokens: 100,
          reasoningOutputTokens: 20,
          totalTokens: 1100,
        },
        sourceFile: "/tmp/plus-1.jsonl",
      },
      {
        capturedAt: "2026-03-31T12:00:00.000Z",
        kind: "team",
        totals: {
          inputTokens: 2000,
          cachedInputTokens: 300,
          outputTokens: 400,
          reasoningOutputTokens: 50,
          totalTokens: 2400,
        },
        sourceFile: "/tmp/team-1.jsonl",
      },
      {
        capturedAt: "2026-03-27T12:00:00.000Z",
        kind: "plus",
        totals: {
          inputTokens: 700,
          cachedInputTokens: 70,
          outputTokens: 80,
          reasoningOutputTokens: 10,
          totalTokens: 780,
        },
        sourceFile: "/tmp/plus-2.jsonl",
      },
    ],
    new Date("2026-03-31T13:00:00.000Z"),
  );

  assert.equal(summary.today.totals.totalTokens, 3500);
  assert.equal(summary.today.sessions, 2);
  assert.equal(summary.last7Days.totals.totalTokens, 4280);
  assert.equal(summary.last7Days.byKind.length, 2);
  assert.equal(summary.last7Days.byKind[0]?.kind, "team");
  assert.equal(summary.latestSession?.sourceFile, "/tmp/team-1.jsonl");
});
