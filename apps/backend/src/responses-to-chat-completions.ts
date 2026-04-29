/**
 * 本文件负责把 Codex 当前发送的 Responses 请求体转换为 Chat Completions 请求体。
 * 这里只处理协议层字段映射，不触碰账号鉴权和 HTTP 调度，避免把上游细节混入转换逻辑。
 */

export interface ResponsesToChatOptions {
  defaultModel?: string | null;
}

export interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: {
    include_usage: boolean;
  };
  tools?: ChatTool[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  temperature?: unknown;
  top_p?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
}

export interface ChatMessage {
  role: string;
  content?: string | ChatContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: string;
  };
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
    strict?: boolean;
  };
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * 将 Responses 请求体转换为 MiMo Token Plan 可识别的 Chat Completions 请求体。
 * Chat 协议不理解 Responses 的 `instructions`、结构化 `input` 和自定义工具，所以这些字段会被归一成
 * `messages` 与 function tools；调用方负责把结果发送到 `/chat/completions`。
 *
 * @param payload 已解析的 Responses 请求体。
 * @param options 转换选项，例如第三方账号的强制默认模型。
 * @returns 可直接 JSON 序列化的 Chat Completions 请求体。
 */
export function convertResponsesRequestToChatCompletions(
  payload: Record<string, unknown>,
  options: ResponsesToChatOptions = {},
): ChatCompletionsRequest {
  const messages = buildChatMessages(payload);
  const tools = buildChatTools(payload["tools"]);
  const model = resolveChatModel(payload["model"], options.defaultModel);
  const request: ChatCompletionsRequest = {
    model,
    messages: messages.length > 0 ? messages : [{ role: "user", content: "" }],
  };

  if (payload["stream"] === true) {
    request.stream = true;
    request.stream_options = { include_usage: true };
  }

  copyIfPresent(request, payload, "temperature");
  copyIfPresent(request, payload, "top_p");
  copyIfPresent(request, payload, "tool_choice");
  copyIfPresent(request, payload, "parallel_tool_calls");
  copyTokenLimit(request, payload);

  if (tools.length > 0) {
    request.tools = tools;
  }

  return request;
}

/**
 * 解析原始 JSON 字节，并在格式不正确时抛出带上下文的错误。
 *
 * @param rawBody 原始 HTTP 请求体。
 * @returns 普通对象形式的 Responses 请求体。
 * @throws 当请求体不是 JSON 对象时抛出异常。
 */
export function parseResponsesRequestBody(rawBody: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("Responses 请求体不是有效 JSON，无法转换为 Chat Completions。");
  }

  if (!isRecord(parsed)) {
    throw new Error("Responses 请求体必须是 JSON 对象。");
  }

  return parsed;
}

/**
 * 组合 Chat 消息列表。
 *
 * @param payload Responses 请求对象。
 * @returns Chat Completions `messages` 数组。
 */
function buildChatMessages(payload: Record<string, unknown>): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const instructionMessage = buildInstructionMessage(payload["instructions"]);
  if (instructionMessage) {
    messages.push(instructionMessage);
  }

  messages.push(...convertInputToMessages(payload["input"]));
  return messages;
}

/**
 * 把 Responses 顶层 instructions 映射成首条 system 消息。
 *
 * @param instructions 原始 instructions 字段。
 * @returns Chat system 消息；字段缺失时返回 `null`。
 */
function buildInstructionMessage(instructions: unknown): ChatMessage | null {
  if (instructions === undefined || instructions === null) {
    return null;
  }

  return {
    role: "system",
    content: valueToText(instructions),
  };
}

/**
 * 将 Responses `input` 字段展开成 Chat 消息。
 *
 * @param input Responses `input`，可能是字符串或结构化数组。
 * @returns Chat 消息数组。
 */
function convertInputToMessages(input: unknown): ChatMessage[] {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((item) => convertInputItemToMessages(item));
}

/**
 * 转换单个 Responses input item。
 *
 * @param item Responses input item。
 * @returns 一个或多个 Chat 消息。
 */
function convertInputItemToMessages(item: unknown): ChatMessage[] {
  if (!isRecord(item)) {
    return [];
  }

  const type = readString(item["type"]);
  if (type === "message") {
    return [convertMessageItem(item)];
  }

  if (
    type === "function_call_output" ||
    type === "custom_tool_call_output" ||
    type === "mcp_tool_call_output" ||
    type === "tool_search_output"
  ) {
    return [convertToolOutputItem(item)];
  }

  if (type === "function_call" || type === "custom_tool_call") {
    return [convertAssistantToolCallItem(item)];
  }

  return [];
}

/**
 * 转换普通 message item。
 *
 * @param item Responses message item。
 * @returns Chat message。
 */
function convertMessageItem(item: Record<string, unknown>): ChatMessage {
  const role = normalizeMessageRole(readString(item["role"]) ?? "user");
  const content = convertMessageContent(role, item["content"]);
  return {
    role,
    content,
  };
}

/**
 * 转换工具结果为 Chat `tool` 消息。
 *
 * @param item Responses 工具输出 item。
 * @returns Chat tool message。
 */
function convertToolOutputItem(item: Record<string, unknown>): ChatMessage {
  return {
    role: "tool",
    tool_call_id: readString(item["call_id"]) ?? "unknown_call",
    content: valueToText(item["output"] ?? item["tools"] ?? ""),
  };
}

/**
 * 转换历史 assistant 工具调用，供多轮上下文回放使用。
 *
 * @param item Responses 工具调用 item。
 * @returns 带 `tool_calls` 的 Chat assistant message。
 */
function convertAssistantToolCallItem(item: Record<string, unknown>): ChatMessage {
  const name = readString(item["name"]) ?? "unknown_tool";
  const callId = readString(item["call_id"]) ?? `call_${name}`;
  const argumentsValue =
    readString(item["arguments"]) ?? readString(item["input"]) ?? "{}";

  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: callId,
        type: "function",
        function: {
          name,
          arguments: argumentsValue,
        },
      },
    ],
  };
}

/**
 * 把 Responses message content 转为 Chat content。
 *
 * @param role 消息角色。
 * @param content 原始 content 字段。
 * @returns Chat 可接受的文本或多模态内容数组。
 */
function convertMessageContent(
  role: string,
  content: unknown,
): string | ChatContentPart[] {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return valueToText(content ?? "");
  }

  const parts = content
    .map(convertContentPart)
    .filter((part): part is ChatContentPart => part !== null);

  if (role === "user" && parts.some((part) => part.type === "image_url")) {
    return parts;
  }

  return parts
    .map((part) => part.text ?? part.image_url?.url ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * 转换一个 Responses 内容片段。
 *
 * @param part 原始内容片段。
 * @returns Chat content part；无法识别时返回 `null`。
 */
function convertContentPart(part: unknown): ChatContentPart | null {
  if (!isRecord(part)) {
    return null;
  }

  const type = readString(part["type"]);
  if (type === "input_text" || type === "output_text" || type === "text") {
    return {
      type: "text",
      text: readString(part["text"]) ?? "",
    };
  }

  if (type === "input_image" || type === "image_url") {
    const directUrl = readString(part["image_url"]);
    const nestedUrl = isRecord(part["image_url"])
      ? readString(part["image_url"]["url"])
      : null;
    const url = directUrl ?? nestedUrl;
    if (!url) {
      return null;
    }

    const detail = readString(part["detail"]);
    return {
      type: "image_url",
      image_url: detail ? { url, detail } : { url },
    };
  }

  return null;
}

/**
 * 转换 Responses tools 为 Chat function tools。
 *
 * @param tools 原始 tools 字段。
 * @returns Chat function tool 数组。
 */
function buildChatTools(tools: unknown): ChatTool[] {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map(convertToolDefinition)
    .filter((tool): tool is ChatTool => tool !== null);
}

/**
 * 转换单个工具定义。
 *
 * @param tool 原始 Responses tool。
 * @returns Chat function tool；不支持时返回 `null`。
 */
function convertToolDefinition(tool: unknown): ChatTool | null {
  if (!isRecord(tool)) {
    return null;
  }

  const type = readString(tool["type"]);
  if (type === "function") {
    return convertFunctionTool(tool);
  }

  if (type === "local_shell") {
    return buildLocalShellTool(tool);
  }

  const name = readString(tool["name"]);
  if (name === "apply_patch" || type === "custom") {
    return buildFreeformTool(tool, name ?? "custom_tool");
  }

  return null;
}

/**
 * 透传 Responses function tool，同时兼容已经是 Chat 格式的工具定义。
 *
 * @param tool 原始 function tool。
 * @returns Chat function tool。
 */
function convertFunctionTool(tool: Record<string, unknown>): ChatTool | null {
  const nested = isRecord(tool["function"]) ? tool["function"] : null;
  const source = nested ?? tool;
  const name = readString(source["name"]);
  if (!name) {
    return null;
  }

  const converted: ChatTool = {
    type: "function",
    function: {
      name,
    },
  };
  const description = readString(source["description"]);
  if (description) {
    converted.function.description = description;
  }
  if (source["parameters"] !== undefined) {
    converted.function.parameters = source["parameters"];
  }
  if (typeof source["strict"] === "boolean") {
    converted.function.strict = source["strict"];
  }

  return converted;
}

/**
 * 构造 local_shell 的 Chat function tool。
 *
 * @param tool 原始 local_shell tool。
 * @returns Chat function tool。
 */
function buildLocalShellTool(tool: Record<string, unknown>): ChatTool {
  return {
    type: "function",
    function: {
      name: readString(tool["name"]) ?? "local_shell",
      description:
        readString(tool["description"]) ??
        "Run a local shell command and return its output.",
      parameters: {
        type: "object",
        properties: {
          cmd: {
            type: "string",
            description: "Shell command to execute.",
          },
          yield_time_ms: {
            type: "number",
            description: "Milliseconds to wait before yielding partial output.",
          },
          max_output_tokens: {
            type: "number",
            description: "Maximum output tokens to return.",
          },
        },
        required: ["cmd"],
        additionalProperties: true,
      },
    },
  };
}

/**
 * 把 Responses freeform/custom tool 包装成只接收 `{ input: string }` 的 Chat function。
 *
 * @param tool 原始 custom tool。
 * @param name 工具名。
 * @returns Chat function tool。
 */
function buildFreeformTool(
  tool: Record<string, unknown>,
  name: string,
): ChatTool {
  return {
    type: "function",
    function: {
      name,
      description:
        readString(tool["description"]) ??
        "Pass raw freeform input to the local tool.",
      parameters: {
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
    },
  };
}

/**
 * 决定 Chat 上游实际使用的模型名。
 *
 * @param requestModel Codex 请求中的模型名。
 * @param defaultModel 第三方账号默认模型。
 * @returns 最终模型名。
 */
function resolveChatModel(
  requestModel: unknown,
  defaultModel: string | null | undefined,
): string {
  const configured = defaultModel?.trim();
  if (configured) {
    return configured;
  }

  return readString(requestModel) ?? "gpt-5.4";
}

/**
 * 复制 Chat 与 Responses 语义兼容的简单字段。
 *
 * @param target 目标 Chat 请求对象。
 * @param source 原始 Responses 请求对象。
 * @param key 字段名。
 * @returns 无返回值。
 */
function copyIfPresent(
  target: ChatCompletionsRequest,
  source: Record<string, unknown>,
  key: string,
): void {
  if (source[key] !== undefined) {
    (target as Record<string, unknown>)[key] = source[key];
  }
}

/**
 * 将 Responses 的输出上限映射为 MiMo 文档使用的 `max_completion_tokens`。
 *
 * @param target 目标 Chat 请求对象。
 * @param source 原始 Responses 请求对象。
 * @returns 无返回值。
 */
function copyTokenLimit(
  target: ChatCompletionsRequest,
  source: Record<string, unknown>,
): void {
  if (source["max_output_tokens"] !== undefined) {
    target.max_completion_tokens = source["max_output_tokens"];
    return;
  }

  if (source["max_completion_tokens"] !== undefined) {
    target.max_completion_tokens = source["max_completion_tokens"];
    return;
  }

  if (source["max_tokens"] !== undefined) {
    target.max_tokens = source["max_tokens"];
  }
}

/**
 * 归一化 Chat message role，避免把 Responses 私有角色传给上游。
 *
 * @param role 原始角色。
 * @returns Chat 可识别的角色。
 */
function normalizeMessageRole(role: string): string {
  if (
    role === "system" ||
    role === "developer" ||
    role === "user" ||
    role === "assistant" ||
    role === "tool"
  ) {
    return role;
  }

  return "user";
}

/**
 * 将未知值转换为稳定文本，供 Chat 的纯文本字段使用。
 *
 * @param value 任意值。
 * @returns 文本表示。
 */
function valueToText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (isRecord(item) && typeof item["text"] === "string") {
          return item["text"];
        }

        return valueToText(item);
      })
      .filter((text) => text.length > 0)
      .join("\n");
  }

  return JSON.stringify(value);
}

/**
 * 读取字符串字段。
 *
 * @param value 任意值。
 * @returns 字符串或 `null`。
 */
function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * 判断未知值是否为普通对象。
 *
 * @param value 任意值。
 * @returns 是普通对象时返回 `true`。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
