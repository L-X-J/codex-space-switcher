import test from "node:test";
import assert from "node:assert/strict";

import {
  buildResponsesFailedSseStream,
  convertChatCompletionsStreamToResponses,
} from "./chat-completions-to-responses.ts";

/**
 * 本文件验证 Chat Completions SSE 到 Responses SSE 的转换。
 * Codex 在流结束前必须看到 `response.completed`，否则会把正常结束误报为 stream closed before completed。
 */

test("应把普通 Chat 文本流转换为 Responses 文本 delta 与 completed", async () => {
  const converted = convertChatCompletionsStreamToResponses(
    streamFromTextFrames([
      chatFrame({
        choices: [{ delta: { content: "Hel" }, finish_reason: null }],
      }),
      chatFrame({
        choices: [{ delta: { content: "lo" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      }),
      "data: [DONE]\n\n",
    ]),
    { model: "mimo-v2.5-pro" },
  );

  const events = await readResponsesEvents(converted.body);
  const usage = await converted.usagePromise;

  assert.deepEqual(
    events
      .filter((event) => event.type === "response.output_text.delta")
      .map((event) => event.delta),
    ["Hel", "lo"],
  );
  assert.equal(
    events.find((event) => event.type === "response.output_item.done")
      ?.item?.content?.[0]?.text,
    "Hello",
  );
  assert.equal(
    events.at(-1)?.type,
    "response.completed",
  );
  assert.deepEqual(usage, {
    inputTokens: 10,
    cachedInputTokens: 3,
    outputTokens: 2,
    totalTokens: 12,
  });
});

test("应把 Chat tool_calls 流转换为 Responses function_call", async () => {
  const converted = convertChatCompletionsStreamToResponses(
    streamFromTextFrames([
      chatFrame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "apply_patch", arguments: "{\"input\":\"" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      chatFrame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: "patch\"}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      "data: [DONE]\n\n",
    ]),
    { model: "mimo-v2.5-pro" },
  );

  const events = await readResponsesEvents(converted.body);
  const item = events.find((event) => event.type === "response.output_item.done")?.item;

  assert.equal(item?.type, "function_call");
  assert.equal(item?.name, "apply_patch");
  assert.equal(item?.call_id, "call_1");
  assert.equal(item?.arguments, "{\"input\":\"patch\"}");
  assert.equal(events.at(-1)?.response?.end_turn, false);
});

test("上游遗漏 DONE 时仍应补齐 response.completed", async () => {
  const converted = convertChatCompletionsStreamToResponses(
    streamFromTextFrames([
      chatFrame({
        choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
      }),
    ]),
    { model: "mimo-v2.5-pro" },
  );

  const events = await readResponsesEvents(converted.body);

  assert.equal(events.at(-1)?.type, "response.completed");
});

test("上游流式错误应转换为 response.failed", async () => {
  const stream = buildResponsesFailedSseStream(
    "上游 429",
    "mimo-v2.5-pro",
  );
  const events = await readResponsesEvents(stream);

  assert.equal(events.at(-1)?.type, "response.failed");
  assert.equal(events.at(-1)?.response?.error?.message, "上游 429");
});

/**
 * 构造一条 Chat SSE data 帧。
 *
 * @param payload Chat chunk payload。
 * @returns SSE 文本。
 */
function chatFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 从文本帧构造可读字节流。
 *
 * @param frames SSE 文本帧。
 * @returns 字节流。
 */
function streamFromTextFrames(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}

/**
 * 读取 Responses SSE 流中的 JSON 事件。
 *
 * @param stream SSE 字节流。
 * @returns 事件数组。
 */
async function readResponsesEvents(
  stream: ReadableStream<Uint8Array>,
): Promise<any[]> {
  const text = await readStreamText(stream);
  return text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim();
      return JSON.parse(data ?? "{}");
    });
}

/**
 * 读取完整字节流文本。
 *
 * @param stream 字节流。
 * @returns UTF-8 文本。
 */
async function readStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      text += decoder.decode(value, { stream: true });
    }
  }
  return text + decoder.decode();
}
