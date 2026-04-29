import test from "node:test";
import assert from "node:assert/strict";

import {
  convertResponsesRequestToChatCompletions,
} from "./responses-to-chat-completions.ts";

/**
 * 本文件验证 Responses 请求到 Chat Completions 请求的协议映射。
 * MiMo Token Plan 只支持 Chat Completions，因此这些用例覆盖 Codex 常规编码会话最容易出错的消息、工具和模型字段。
 */

test("应把 instructions、普通文本和默认模型改写为 Chat 请求", () => {
  const converted = convertResponsesRequestToChatCompletions(
    {
      model: "gpt-5.4",
      instructions: "你是一个编程助手。",
      input: "写一个 quick sort",
      stream: true,
      max_output_tokens: 512,
    },
    {
      defaultModel: "mimo-v2.5-pro",
    },
  );

  assert.equal(converted.model, "mimo-v2.5-pro");
  assert.equal(converted.stream, true);
  assert.deepEqual(converted.stream_options, { include_usage: true });
  assert.equal(converted.max_completion_tokens, 512);
  assert.deepEqual(converted.messages, [
    { role: "system", content: "你是一个编程助手。" },
    { role: "user", content: "写一个 quick sort" },
  ]);
});

test("应保留多模态图片输入为 Chat content parts", () => {
  const converted = convertResponsesRequestToChatCompletions({
    model: "gpt-5.4",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "描述图片" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,abc",
            detail: "high",
          },
        ],
      },
    ],
  });

  assert.deepEqual(converted.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "描述图片" },
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,abc",
            detail: "high",
          },
        },
      ],
    },
  ]);
});

test("应把工具输出映射为 Chat tool 消息", () => {
  const converted = convertResponsesRequestToChatCompletions({
    model: "gpt-5.4",
    input: [
      {
        type: "function_call_output",
        call_id: "call_123",
        output: "ok",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_patch",
        output: [{ type: "output_text", text: "patched" }],
      },
    ],
  });

  assert.deepEqual(converted.messages, [
    {
      role: "tool",
      tool_call_id: "call_123",
      content: "ok",
    },
    {
      role: "tool",
      tool_call_id: "call_patch",
      content: "patched",
    },
  ]);
});

test("应转换 function、local_shell 与 apply_patch 工具定义", () => {
  const converted = convertResponsesRequestToChatCompletions({
    model: "gpt-5.4",
    input: "run tools",
    tools: [
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object" },
      },
      { type: "local_shell" },
      {
        type: "custom",
        name: "apply_patch",
        description: "Apply a patch",
      },
    ],
  });

  assert.equal(converted.tools?.length, 3);
  assert.equal(converted.tools?.[0]?.function.name, "read_file");
  assert.equal(converted.tools?.[1]?.function.name, "local_shell");
  assert.deepEqual(
    converted.tools?.[2]?.function.parameters,
    {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "Raw tool input.",
        },
      },
      required: ["input"],
      additionalProperties: false,
    },
  );
});
