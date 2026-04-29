import type { CapturedUsage } from "./response-usage-capture.ts";

/**
 * 本文件负责把 OpenAI Chat Completions 响应转换成 Codex 可消费的 Responses 形态。
 * Codex 0.125.0 的 SSE 解析只读取 `data:` 内 JSON 的 `type` 字段，因此这里生成最小但完整的
 * `response.created`、delta、`response.output_item.done` 与 `response.completed` 事件序列。
 */

export interface ChatToResponsesOptions {
  model: string;
}

export interface ResponsesConversionResult {
  body: ReadableStream<Uint8Array>;
  usagePromise: Promise<CapturedUsage | null>;
}

interface CompletionState {
  responseId: string;
  model: string;
  text: string;
  toolCalls: Map<number, ToolCallAccumulator>;
  usage: CapturedUsage | null;
  failed: boolean;
  completionEmitted: boolean;
}

interface ToolCallAccumulator {
  index: number;
  id: string | null;
  name: string | null;
  arguments: string;
}

/**
 * 将 Chat Completions SSE 转换为 Responses SSE。
 * 转换器会保证成功路径最终总是写出 `response.completed`，即便上游遗漏 `[DONE]` 也不会让 Codex
 * 看到“stream closed before response.completed”。
 *
 * @param upstreamBody 上游 Chat SSE 字节流。
 * @param options 转换上下文。
 * @returns 可作为本地响应体的 SSE 字节流与 usage 提取 Promise。
 */
export function convertChatCompletionsStreamToResponses(
  upstreamBody: ReadableStream<Uint8Array>,
  options: ChatToResponsesOptions,
): ResponsesConversionResult {
  let resolveUsage: (usage: CapturedUsage | null) => void = () => {};
  const usagePromise = new Promise<CapturedUsage | null>((resolve) => {
    resolveUsage = resolve;
  });

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void pumpChatStream(upstreamBody, controller, options)
        .then((usage) => {
          resolveUsage(usage);
        })
        .catch((error) => {
          const state = createCompletionState(options.model);
          writeResponseCreated(controller, state);
          writeResponseFailed(controller, state, formatUnknownError(error));
          resolveUsage(null);
        })
        .finally(() => {
          controller.close();
        });
    },
  });

  return {
    body,
    usagePromise,
  };
}

/**
 * 将非流式 Chat Completions JSON 转换为非流式 Responses JSON。
 *
 * @param payload 上游 Chat 响应对象。
 * @param options 转换上下文。
 * @returns Responses 风格 JSON 对象。
 */
export function convertChatCompletionPayloadToResponse(
  payload: unknown,
  options: ChatToResponsesOptions,
): Record<string, unknown> {
  const state = createCompletionState(options.model);
  const firstChoice = readFirstChoice(payload);
  const message = asRecord(firstChoice?.["message"]);

  if (message) {
    const content = readString(message["content"]);
    if (content) {
      state.text = content;
    }

    for (const toolCall of readArray(message["tool_calls"])) {
      accumulateToolCall(state, toolCall);
    }
  }

  state.usage = normalizeChatUsage(asRecord(asRecord(payload)?.["usage"]));
  return buildCompletedResponsePayload(state);
}

/**
 * 从非流式 Chat 响应中提取 usage。
 *
 * @param payload 上游 Chat 响应对象。
 * @returns 标准 usage；没有 usage 时返回 `null`。
 */
export function extractChatUsageFromPayload(payload: unknown): CapturedUsage | null {
  return normalizeChatUsage(asRecord(asRecord(payload)?.["usage"]));
}

/**
 * 构造一个流式 response.failed 响应体，用于上游 HTTP 非 2xx 或连接前错误。
 *
 * @param message 错误消息。
 * @param model 当前请求模型。
 * @returns SSE 字节流。
 */
export function buildResponsesFailedSseStream(
  message: string,
  model: string,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const state = createCompletionState(model);
      writeResponseCreated(controller, state);
      writeResponseFailed(controller, state, message);
      controller.close();
    },
  });
}

/**
 * 读取并转换 Chat SSE 上游流。
 *
 * @param upstreamBody 上游字节流。
 * @param controller 本地 SSE 响应控制器。
 * @param options 转换上下文。
 * @returns 捕获到的 usage。
 */
async function pumpChatStream(
  upstreamBody: ReadableStream<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  options: ChatToResponsesOptions,
): Promise<CapturedUsage | null> {
  const state = createCompletionState(options.model);
  const reader = upstreamBody.getReader();
  const parser = new SseFrameParser((data) => {
    consumeChatSseData(controller, state, data);
  });

  writeResponseCreated(controller, state);

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (value) {
      parser.push(value);
    }
  }

  parser.finish();

  if (!state.failed) {
    emitCompletion(controller, state);
  }

  return state.usage;
}

/**
 * 消费单条 Chat SSE `data:` 内容。
 *
 * @param controller 本地响应控制器。
 * @param state 当前转换状态。
 * @param data SSE data 文本。
 * @returns 无返回值。
 */
function consumeChatSseData(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: CompletionState,
  data: string,
): void {
  if (data === "[DONE]") {
    emitCompletion(controller, state);
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }

  const record = asRecord(payload);
  if (!record) {
    return;
  }

  const error = asRecord(record["error"]);
  if (error) {
    writeResponseFailed(
      controller,
      state,
      readString(error["message"]) ?? "Chat Completions 上游返回流式错误。",
      readString(error["type"]) ?? undefined,
      readString(error["code"]) ?? undefined,
    );
    return;
  }

  const usage = normalizeChatUsage(asRecord(record["usage"]));
  if (usage) {
    state.usage = usage;
  }

  for (const choice of readArray(record["choices"])) {
    consumeChatChoice(controller, state, choice);
  }
}

/**
 * 消费 Chat chunk 里的单个 choice。
 *
 * @param controller 本地响应控制器。
 * @param state 当前转换状态。
 * @param choice Chat choice。
 * @returns 无返回值。
 */
function consumeChatChoice(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: CompletionState,
  choice: unknown,
): void {
  if (state.failed) {
    return;
  }

  const record = asRecord(choice);
  const delta = asRecord(record?.["delta"]);
  if (!delta) {
    return;
  }

  const content = readString(delta["content"]);
  if (content) {
    state.text += content;
    writeSseEvent(controller, {
      type: "response.output_text.delta",
      delta: content,
    });
  }

  for (const toolCall of readArray(delta["tool_calls"])) {
    accumulateToolCall(state, toolCall);
  }
}

/**
 * 累积 Chat tool_calls 的分片。
 *
 * @param state 当前转换状态。
 * @param rawToolCall 原始 tool call 或 delta。
 * @returns 无返回值。
 */
function accumulateToolCall(
  state: CompletionState,
  rawToolCall: unknown,
): void {
  const toolCall = asRecord(rawToolCall);
  if (!toolCall) {
    return;
  }

  const index = toInteger(toolCall["index"]) ?? state.toolCalls.size;
  const current =
    state.toolCalls.get(index) ??
    {
      index,
      id: null,
      name: null,
      arguments: "",
    };

  current.id = readString(toolCall["id"]) ?? current.id;

  const fn = asRecord(toolCall["function"]);
  if (fn) {
    current.name = readString(fn["name"]) ?? current.name;
    current.arguments += readString(fn["arguments"]) ?? "";
  }

  state.toolCalls.set(index, current);
}

/**
 * 在成功路径写出最终 message/tool call items 与 response.completed。
 *
 * @param controller 本地响应控制器。
 * @param state 当前转换状态。
 * @returns 无返回值。
 */
function emitCompletion(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: CompletionState,
): void {
  if (state.completionEmitted) {
    return;
  }
  state.completionEmitted = true;

  if (state.text.length > 0) {
    writeSseEvent(controller, {
      type: "response.output_item.done",
      item: buildMessageItem(state.text),
    });
  }

  for (const toolCall of [...state.toolCalls.values()].sort(
    (left, right) => left.index - right.index,
  )) {
    writeSseEvent(controller, {
      type: "response.output_item.done",
      item: buildFunctionCallItem(state.responseId, toolCall),
    });
  }

  writeSseEvent(controller, {
    type: "response.completed",
    response: {
      id: state.responseId,
      status: "completed",
      model: state.model,
      usage: state.usage ? buildResponsesUsage(state.usage) : undefined,
      end_turn: state.toolCalls.size === 0,
    },
  });
}

/**
 * 写出 response.created 事件。
 *
 * @param controller 本地响应控制器。
 * @param state 当前转换状态。
 * @returns 无返回值。
 */
function writeResponseCreated(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: CompletionState,
): void {
  writeSseEvent(controller, {
    type: "response.created",
    response: {
      id: state.responseId,
      status: "in_progress",
      model: state.model,
      headers: {
        "openai-model": state.model,
      },
    },
  });
}

/**
 * 写出 response.failed 事件，并阻止后续 completed。
 *
 * @param controller 本地响应控制器。
 * @param state 当前转换状态。
 * @param message 错误消息。
 * @param errorType 可选错误类型。
 * @param errorCode 可选错误码。
 * @returns 无返回值。
 */
function writeResponseFailed(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: CompletionState,
  message: string,
  errorType = "upstream_error",
  errorCode = "chat_completions_upstream_error",
): void {
  if (state.failed) {
    return;
  }
  state.failed = true;
  writeSseEvent(controller, {
    type: "response.failed",
    response: {
      id: state.responseId,
      status: "failed",
      model: state.model,
      error: {
        type: errorType,
        code: errorCode,
        message,
      },
    },
  });
}

/**
 * 构造非流式 Responses JSON。
 *
 * @param state 转换状态。
 * @returns Responses 风格响应。
 */
function buildCompletedResponsePayload(state: CompletionState): Record<string, unknown> {
  const output = [];
  if (state.text.length > 0) {
    output.push(buildMessageItem(state.text));
  }
  for (const toolCall of [...state.toolCalls.values()].sort(
    (left, right) => left.index - right.index,
  )) {
    output.push(buildFunctionCallItem(state.responseId, toolCall));
  }

  return {
    id: state.responseId,
    object: "response",
    status: "completed",
    model: state.model,
    output,
    usage: state.usage ? buildResponsesUsage(state.usage) : undefined,
    end_turn: state.toolCalls.size === 0,
  };
}

/**
 * 构造 Responses message output item。
 *
 * @param text 完整文本。
 * @returns Responses message item。
 */
function buildMessageItem(text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text,
      },
    ],
  };
}

/**
 * 构造 Responses function_call output item。
 *
 * @param responseId 响应 ID，用于没有上游 call id 时生成稳定回退。
 * @param toolCall Chat tool call 累积结果。
 * @returns Responses function_call item。
 */
function buildFunctionCallItem(
  responseId: string,
  toolCall: ToolCallAccumulator,
): Record<string, unknown> {
  const callId = toolCall.id ?? `${responseId}_call_${toolCall.index}`;
  return {
    type: "function_call",
    name: toolCall.name ?? "unknown_tool",
    arguments: toolCall.arguments || "{}",
    call_id: callId,
  };
}

/**
 * 将 Chat usage 字段归一为本项目通用 usage。
 *
 * @param usage Chat usage 对象。
 * @returns 标准 usage；无法识别时返回 `null`。
 */
function normalizeChatUsage(
  usage: Record<string, unknown> | null,
): CapturedUsage | null {
  if (!usage) {
    return null;
  }

  const promptTokens = toNumber(usage["prompt_tokens"]);
  const completionTokens = toNumber(usage["completion_tokens"]);
  const totalTokens = toNumber(usage["total_tokens"]);
  const promptDetails = asRecord(usage["prompt_tokens_details"]);
  const cachedInputTokens =
    toNumber(promptDetails?.["cached_tokens"]) ??
    toNumber(usage["cached_input_tokens"]) ??
    0;

  if (
    promptTokens === null &&
    completionTokens === null &&
    totalTokens === null &&
    cachedInputTokens === 0
  ) {
    return null;
  }

  const inputTokens = promptTokens ?? 0;
  const outputTokens = completionTokens ?? 0;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: totalTokens ?? inputTokens + outputTokens,
  };
}

/**
 * 构造 Responses usage 对象。
 *
 * @param usage 标准 usage。
 * @returns Responses `usage` 字段。
 */
function buildResponsesUsage(usage: CapturedUsage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    input_tokens_details: {
      cached_tokens: usage.cachedInputTokens,
    },
    output_tokens: usage.outputTokens,
    output_tokens_details: {
      reasoning_tokens: 0,
    },
    total_tokens: usage.totalTokens,
  };
}

/**
 * 创建一次转换状态。
 *
 * @param model 实际模型名。
 * @returns 初始状态。
 */
function createCompletionState(model: string): CompletionState {
  return {
    responseId: `resp_${crypto.randomUUID().replaceAll("-", "")}`,
    model,
    text: "",
    toolCalls: new Map(),
    usage: null,
    failed: false,
    completionEmitted: false,
  };
}

const encoder = new TextEncoder();

/**
 * 写出单条 SSE JSON 帧。
 *
 * @param controller 本地响应控制器。
 * @param payload Responses 事件对象。
 * @returns 无返回值。
 */
function writeSseEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  payload: Record<string, unknown>,
): void {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

/**
 * 解析 SSE 文本帧，兼容 CRLF、多行 data 与注释行。
 */
class SseFrameParser {
  private readonly decoder = new TextDecoder();

  private buffer = "";

  constructor(private readonly onData: (data: string) => void) {}

  /**
   * 喂入一段原始字节。
   *
   * @param chunk 原始 SSE 字节。
   * @returns 无返回值。
   */
  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    this.consumeFrames();
  }

  /**
   * 结束解析，并把残留文本按完整帧处理。
   *
   * @returns 无返回值。
   */
  finish(): void {
    this.buffer += this.decoder.decode().replace(/\r\n/g, "\n");
    this.consumeFrames(true);
  }

  /**
   * 消费已经完整到达的 SSE 帧。
   *
   * @param flush 是否把尾部残留视作完整帧。
   * @returns 无返回值。
   */
  private consumeFrames(flush = false): void {
    while (true) {
      const separatorIndex = this.buffer.indexOf("\n\n");
      if (separatorIndex < 0) {
        break;
      }

      const frame = this.buffer.slice(0, separatorIndex);
      this.buffer = this.buffer.slice(separatorIndex + 2);
      this.consumeFrame(frame);
    }

    if (flush && this.buffer.trim().length > 0) {
      this.consumeFrame(this.buffer);
      this.buffer = "";
    }
  }

  /**
   * 从单帧中提取 data 行。
   *
   * @param frame 原始帧文本。
   * @returns 无返回值。
   */
  private consumeFrame(frame: string): void {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trimEnd();

    if (data.length > 0) {
      this.onData(data);
    }
  }
}

/**
 * 读取 Chat 响应第一个 choice。
 *
 * @param payload Chat 响应。
 * @returns choice 对象或 `null`。
 */
function readFirstChoice(payload: unknown): Record<string, unknown> | null {
  return asRecord(readArray(asRecord(payload)?.["choices"])[0]);
}

/**
 * 安全读取数组。
 *
 * @param value 任意值。
 * @returns 数组或空数组。
 */
function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 安全读取字符串。
 *
 * @param value 任意值。
 * @returns 字符串或 `null`。
 */
function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * 安全读取整数。
 *
 * @param value 任意值。
 * @returns 整数或 `null`。
 */
function toInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  return null;
}

/**
 * 安全读取数字。
 *
 * @param value 任意值。
 * @returns 数字或 `null`。
 */
function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return null;
}

/**
 * 判断未知值是否为普通对象。
 *
 * @param value 任意值。
 * @returns 普通对象或 `null`。
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * 格式化未知异常。
 *
 * @param error 原始异常。
 * @returns 可展示文本。
 */
function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
