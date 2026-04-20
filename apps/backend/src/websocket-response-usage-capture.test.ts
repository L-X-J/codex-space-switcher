import assert from "node:assert/strict";
import test from "node:test";

import { WebSocketUsageCollector } from "./websocket-response-usage-capture.ts";

/**
 * 本文件覆盖 WebSocket usage 捕获器最容易出错的帧解析场景。
 * 这里既要保证能处理基础文本帧，也要保证分片消息不会在中途被误判为无效 JSON。
 */

test("WebSocketUsageCollector 应能从单个文本帧中提取 usage", () => {
  const collector = new WebSocketUsageCollector();
  const messages = collector.pushChunk(
    createTextFrame(
      JSON.stringify({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 900,
            output_tokens: 120,
            total_tokens: 1020,
            input_tokens_details: {
              cached_tokens: 300,
            },
          },
        },
      }),
    ),
  );

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.usage, {
    inputTokens: 900,
    cachedInputTokens: 300,
    outputTokens: 120,
    totalTokens: 1020,
  });
  assert.equal(messages[0]?.type, "response.completed");
  assert.deepEqual(collector.finish(), []);
});

test("WebSocketUsageCollector 应能拼接 continuation 分片并保留更大的累计值", () => {
  const collector = new WebSocketUsageCollector();
  const interim = collector.pushChunk(
    createTextFrame(
      JSON.stringify({
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 400,
            cached_input_tokens: 40,
            output_tokens: 80,
            total_tokens: 480,
          },
        },
      }),
    ),
  );
  assert.deepEqual(interim, []);

  const fragmentedPayload = JSON.stringify({
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 640,
        output_tokens: 160,
        total_tokens: 800,
        input_tokens_details: {
          cached_tokens: 64,
        },
      },
    },
  });
  const splitIndex = Math.floor(fragmentedPayload.length / 2);

  collector.pushChunk(createTextFrame(fragmentedPayload.slice(0, splitIndex), false));
  const messages = collector.pushChunk(
    createContinuationFrame(fragmentedPayload.slice(splitIndex), true),
  );

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.usage, {
    inputTokens: 640,
    cachedInputTokens: 64,
    outputTokens: 160,
    totalTokens: 800,
  });
  assert.deepEqual(collector.finish(), []);
});

test("WebSocketUsageCollector 在只有 token_count 时应在 finish 返回兜底 usage", () => {
  const collector = new WebSocketUsageCollector();
  const messages = collector.pushChunk(
    createTextFrame(
      JSON.stringify({
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 123,
            cached_input_tokens: 23,
            output_tokens: 45,
            total_tokens: 168,
          },
        },
      }),
    ),
  );

  assert.deepEqual(messages, []);
  const fallback = collector.finish();
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0]?.type, "usage.fallback");
  assert.deepEqual(fallback[0]?.usage, {
    inputTokens: 123,
    cachedInputTokens: 23,
    outputTokens: 45,
    totalTokens: 168,
  });
});

/**
 * 构造一个服务端发出的文本帧。
 *
 * @param payload 文本消息体。
 * @param fin 当前帧是否结束消息。
 * @returns 对应的帧字节。
 */
function createTextFrame(payload: string, fin = true): Buffer {
  return createFrame(0x1, payload, fin);
}

/**
 * 构造 continuation 帧，用于模拟被拆分的文本消息。
 *
 * @param payload 帧负载。
 * @param fin 当前帧是否结束消息。
 * @returns 对应的帧字节。
 */
function createContinuationFrame(payload: string, fin = true): Buffer {
  return createFrame(0x0, payload, fin);
}

/**
 * 构造一个未掩码的服务端 WebSocket 帧。
 *
 * @param opcode 帧 opcode。
 * @param payload 文本负载。
 * @param fin 是否设置 FIN 位。
 * @returns 对应的帧字节。
 */
function createFrame(opcode: number, payload: string, fin: boolean): Buffer {
  const payloadBuffer = Buffer.from(payload, "utf8");
  const header: number[] = [(fin ? 0x80 : 0x00) | opcode];

  if (payloadBuffer.length < 126) {
    header.push(payloadBuffer.length);
  } else {
    header.push(126, (payloadBuffer.length >> 8) & 0xff, payloadBuffer.length & 0xff);
  }

  return Buffer.concat([Buffer.from(header), payloadBuffer]);
}
