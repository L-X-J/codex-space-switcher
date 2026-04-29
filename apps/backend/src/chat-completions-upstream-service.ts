import type { CapturedUsage } from "./response-usage-capture.ts";
import type { ThirdPartyGatewayAccount } from "./gateway-account-store.ts";
import { joinUrl } from "./gateway-url.ts";
import {
  buildResponsesFailedSseStream,
  convertChatCompletionPayloadToResponse,
  convertChatCompletionsStreamToResponses,
  extractChatUsageFromPayload,
} from "./chat-completions-to-responses.ts";
import {
  convertResponsesRequestToChatCompletions,
  parseResponsesRequestBody,
} from "./responses-to-chat-completions.ts";

/**
 * 本文件负责 Chat Completions 上游的 HTTP 调度。
 * Responses 与 Chat 的协议转换放在独立模块中，这里只编排请求、错误包装和 usage 回传。
 */

export interface ChatCompletionsDispatchResult {
  response: Response;
  upstreamStatusCode: number;
  usagePromise: Promise<CapturedUsage | null>;
  resolvedModel: string;
}

/**
 * 把一次 Codex Responses 请求发往第三方 Chat Completions 上游，并转换回 Responses 形态。
 *
 * @param account 当前第三方账号。
 * @param rawBody 原始 Responses 请求体。
 * @returns 可由代理层继续写给 Codex 的响应对象。
 */
export async function dispatchChatCompletionsResponsesRequest(
  account: ThirdPartyGatewayAccount,
  rawBody: Buffer,
): Promise<ChatCompletionsDispatchResult> {
  const responsesPayload = parseResponsesRequestBody(rawBody);
  const chatRequest = convertResponsesRequestToChatCompletions(responsesPayload, {
    defaultModel: account.defaultModel,
  });
  const resolvedModel = chatRequest.model;
  const wantsStream = chatRequest.stream === true;
  const upstream = await fetch(joinUrl(account.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.apiKey}`,
      "Content-Type": "application/json",
      Accept: wantsStream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(chatRequest),
  });

  if (!upstream.ok) {
    return buildUpstreamErrorResult(upstream, wantsStream, resolvedModel);
  }

  if (!wantsStream) {
    const payload = await upstream.json();
    const responsesPayloadResult = convertChatCompletionPayloadToResponse(payload, {
      model: resolvedModel,
    });
    return {
      response: jsonResponse(upstream.status, responsesPayloadResult),
      upstreamStatusCode: upstream.status,
      usagePromise: Promise.resolve(extractChatUsageFromPayload(payload)),
      resolvedModel,
    };
  }

  if (!upstream.body) {
    const message = "Chat Completions 上游没有返回可读取的 SSE 响应体。";
    return {
      response: sseResponse(200, buildResponsesFailedSseStream(message, resolvedModel)),
      upstreamStatusCode: 502,
      usagePromise: Promise.resolve(null),
      resolvedModel,
    };
  }

  const converted = convertChatCompletionsStreamToResponses(upstream.body, {
    model: resolvedModel,
  });
  return {
    response: sseResponse(200, converted.body),
    upstreamStatusCode: upstream.status,
    usagePromise: converted.usagePromise,
    resolvedModel,
  };
}

/**
 * 把上游非 2xx 响应转换为 Codex 可识别的错误响应。
 *
 * @param upstream 上游错误响应。
 * @param wantsStream 当前 Codex 请求是否要求 SSE。
 * @param model 实际上游模型。
 * @returns 调度结果。
 */
async function buildUpstreamErrorResult(
  upstream: Response,
  wantsStream: boolean,
  model: string,
): Promise<ChatCompletionsDispatchResult> {
  const message = await readUpstreamErrorMessage(upstream);

  if (wantsStream) {
    return {
      response: sseResponse(200, buildResponsesFailedSseStream(message, model)),
      upstreamStatusCode: upstream.status,
      usagePromise: Promise.resolve(null),
      resolvedModel: model,
    };
  }

  return {
    response: jsonResponse(upstream.status, {
      error: message,
    }),
    upstreamStatusCode: upstream.status,
    usagePromise: Promise.resolve(null),
    resolvedModel: model,
  };
}

/**
 * 尝试读取上游错误体，并压缩成适合返回给 Codex 的短文本。
 *
 * @param upstream 上游错误响应。
 * @returns 错误说明。
 */
async function readUpstreamErrorMessage(upstream: Response): Promise<string> {
  const statusPrefix = `Chat Completions 上游返回 ${upstream.status}`;
  try {
    const text = (await upstream.text()).trim();
    if (!text) {
      return statusPrefix;
    }

    try {
      const payload = JSON.parse(text) as unknown;
      const error = asRecord(asRecord(payload)?.["error"]);
      const message = typeof error?.["message"] === "string"
        ? error["message"]
        : text;
      return `${statusPrefix}：${String(message).slice(0, 500)}`;
    } catch {
      return `${statusPrefix}：${text.slice(0, 500)}`;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `${statusPrefix}，且错误体读取失败：${detail}`;
  }
}

/**
 * 构造 JSON Response。
 *
 * @param status HTTP 状态码。
 * @param payload 响应体。
 * @returns Fetch Response 对象。
 */
function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

/**
 * 构造 SSE Response。
 *
 * @param status HTTP 状态码。
 * @param body SSE 字节流。
 * @returns Fetch Response 对象。
 */
function sseResponse(status: number, body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
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
