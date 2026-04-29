import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTokenRateMetrics,
  OutputTimingTracker,
} from "./token-rate.ts";

/**
 * 本文件验证 token 生成速率的核心口径。
 * 速率应优先使用首个输出到结束的生成周期，避免把首字等待和网络耗时计入模型生成速度。
 */

test("buildTokenRateMetrics 优先使用首字到结束的生成周期", () => {
  const metrics = buildTokenRateMetrics({
    outputTokens: 120,
    latencyMs: 3000,
    firstOutputLatencyMs: 800,
    outputDurationMs: 1200,
  });

  assert.equal(metrics.firstOutputLatencyMs, 800);
  assert.equal(metrics.outputDurationMs, 1200);
  assert.equal(metrics.tokenRatePerSecond, 100);
});

test("buildTokenRateMetrics 在没有流式时间点时回退到整次请求耗时", () => {
  const metrics = buildTokenRateMetrics({
    outputTokens: 120,
    latencyMs: 3000,
  });

  assert.equal(metrics.firstOutputLatencyMs, null);
  assert.equal(metrics.outputDurationMs, null);
  assert.equal(metrics.tokenRatePerSecond, 40);
});

test("buildTokenRateMetrics 在生成周期被毫秒精度压成 0 时回退到整次耗时", () => {
  const metrics = buildTokenRateMetrics({
    outputTokens: 120,
    latencyMs: 3000,
    firstOutputLatencyMs: 3000,
    outputDurationMs: 0,
  });

  assert.equal(metrics.outputDurationMs, 0);
  assert.equal(metrics.tokenRatePerSecond, 40);
});

test("OutputTimingTracker 只记录第一次输出，并在结束时给出生成周期", () => {
  const timestamps = [1450, 1800, 2600];
  const tracker = new OutputTimingTracker(1000, () => timestamps.shift() ?? 2600);

  tracker.markOutputStarted();
  tracker.markOutputStarted();
  const snapshot = tracker.finish();

  assert.equal(snapshot.firstOutputLatencyMs, 450);
  assert.equal(snapshot.outputDurationMs, 350);
});
