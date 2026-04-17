import test from "node:test";
import assert from "node:assert/strict";

import {
  SseUsageCollector,
  extractUsageFromPayload,
} from "./response-usage-capture.ts";

/**
 * 本文件验证代理对 `/responses` 返回体的 usage 捕获逻辑。
 * 这里最关键的是把 `input_tokens` 与 `cached_tokens` 的关系处理正确，否则费用估算会系统性偏高。
 */

test("应能从 response.completed 中提取 usage 和 cache token", () => {
  const usage = extractUsageFromPayload({
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 1600,
        output_tokens: 240,
        total_tokens: 1840,
        input_tokens_details: {
          cached_tokens: 400,
        },
      },
    },
  });

  assert.deepEqual(usage, {
    inputTokens: 1600,
    cachedInputTokens: 400,
    outputTokens: 240,
    totalTokens: 1840,
  });
});

test("SSE collector 应优先保留 total_tokens 更大的累计值", () => {
  const collector = new SseUsageCollector();
  collector.pushChunk(
    new TextEncoder().encode(
      [
        'data: {"type":"token_count","info":{"total_token_usage":{"input_tokens":200,"cached_input_tokens":20,"output_tokens":40,"total_tokens":240}}}',
        "",
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":320,"output_tokens":80,"total_tokens":400,"input_tokens_details":{"cached_tokens":60}}}}',
        "",
      ].join("\n"),
    ),
  );

  assert.deepEqual(collector.finish(), {
    inputTokens: 320,
    cachedInputTokens: 60,
    outputTokens: 80,
    totalTokens: 400,
  });
});
