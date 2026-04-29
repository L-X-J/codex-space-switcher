import type {
  ProxyClientKind,
} from "../../../packages/shared/src/index.ts";
import {
  appendUsageEvent,
} from "./usage-event-store.ts";
import {
  SseUsageCollector,
  extractUsageFromPayload,
  type CapturedUsage,
} from "./response-usage-capture.ts";
import type {
  GatewayRuntimeAccount,
  OfficialGatewayAccount,
  ThirdPartyGatewayAccount,
} from "./gateway-account-store.ts";
import { detectProxyClient } from "./gateway-client-detection.ts";
import { buildUsageEvent } from "./gateway-usage-event.ts";
import {
  buildTokenRateMetrics,
  OutputTimingTracker,
  type OutputTimingSnapshot,
} from "./token-rate.ts";
import { formatError } from "./utils.ts";
import { joinUrl } from "./gateway-url.ts";
import {
  dispatchChatCompletionsResponsesRequest,
} from "./chat-completions-upstream-service.ts";

export { joinUrl } from "./gateway-url.ts";

interface GatewayProxyServiceOptions {
  getActiveAccount: () => Promise<GatewayRuntimeAccount | null>;
  recordGatewayRequest: (result: {
    requestAt: string;
    model: string | null;
    statusText: string;
    clientKind: ProxyClientKind;
    clientLabel: string;
    isLikelyCodex: boolean;
  }) => Promise<void>;
  onUsageRecorded: () => Promise<void>;
}

interface ResponsesRequestMeta {
  model: string | null;
  stream: boolean;
}

interface UpstreamDispatchResult {
  response: Response;
  upstreamStatusCode: number;
  usagePromise?: Promise<CapturedUsage | null>;
  resolvedModel?: string | null;
}

interface ProxiedResponseCapture {
  usage: CapturedUsage | null;
  timing: OutputTimingSnapshot;
}

const OFFICIAL_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
];

/**
 * 本文件负责把本地 `/responses` 请求代理到当前激活账号。
 * 官方账号与 Responses 第三方账号保持透明转发；Chat Completions 第三方账号会交给专门适配器转换协议。
 */
export class GatewayProxyService {
  constructor(private readonly options: GatewayProxyServiceOptions) {}

  /**
   * 代理一次 `/responses` 请求。
   *
   * @param request Node HTTP 请求对象。
   * @param response Node HTTP 响应对象。
   * @returns 无返回值。
   */
  async handleResponses(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    const requestAt = new Date().toISOString();
    const startedAt = Date.now();
    const rawBody = await readRequestBody(request);
    const meta = parseResponsesRequestMeta(rawBody);
    const client = detectProxyClient(request);
    const account = await this.options.getActiveAccount();

    if (!account || !account.isConfigured) {
      await this.options.recordGatewayRequest({
        requestAt,
        model: meta.model,
        statusText: "没有可用的激活账号。",
        clientKind: client.kind,
        clientLabel: client.label,
        isLikelyCodex: client.isLikelyCodex,
      });
      respondJsonError(response, 503, "当前没有可用的激活账号。");
      return;
    }

    try {
      const upstreamResult = await this.dispatchResponsesRequest(
        account,
        rawBody,
        meta.stream,
      );
      const proxiedCapture = await proxyUpstreamResponse(
        response,
        upstreamResult.response,
        meta.stream,
        startedAt,
      );
      const usage = upstreamResult.usagePromise
        ? await upstreamResult.usagePromise
        : proxiedCapture.usage;
      const latencyMs = Date.now() - startedAt;
      const rateMetrics = buildTokenRateMetrics({
        outputTokens: usage?.outputTokens ?? 0,
        latencyMs,
        firstOutputLatencyMs: proxiedCapture.timing.firstOutputLatencyMs,
        outputDurationMs: proxiedCapture.timing.outputDurationMs,
      });
      const statusText =
        upstreamResult.upstreamStatusCode < 400
          ? `${account.name} 返回 ${upstreamResult.upstreamStatusCode}`
          : `${account.name} 失败 ${upstreamResult.upstreamStatusCode}`;
      const usageModel = upstreamResult.resolvedModel ?? meta.model;

      await this.options.recordGatewayRequest({
        requestAt,
        model: usageModel,
        statusText,
        clientKind: client.kind,
        clientLabel: client.label,
        isLikelyCodex: client.isLikelyCodex,
      });

      await appendUsageEvent(
        buildUsageEvent(
          account,
          usageModel,
          usage,
          upstreamResult.upstreamStatusCode,
          latencyMs,
          requestAt,
          undefined,
          rateMetrics,
        ),
      );
      await this.options.onUsageRecorded();
    } catch (error) {
      await this.options.recordGatewayRequest({
        requestAt,
        model: meta.model,
        statusText: `请求失败：${formatError(error)}`,
        clientKind: client.kind,
        clientLabel: client.label,
        isLikelyCodex: client.isLikelyCodex,
      });

      await appendUsageEvent(
        buildUsageEvent(
          account,
          meta.model,
          null,
          502,
          Date.now() - startedAt,
          requestAt,
          `request_failed:${formatError(error)}`,
        ),
      );
      await this.options.onUsageRecorded();
      respondJsonError(response, 502, `本地代理请求失败：${formatError(error)}`);
    }
  }

  /**
   * 返回当前激活账号的模型列表。
   *
   * @param _request Node HTTP 请求对象。
   * @param response Node HTTP 响应对象。
   * @returns 无返回值。
   */
  async handleModels(
    _request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    const account = await this.options.getActiveAccount();
    if (!account || !account.isConfigured) {
      respondJsonError(response, 503, "当前没有可用的激活账号。");
      return;
    }

    if (account.kind === "official") {
      respondJson(response, buildModelListPayload(OFFICIAL_MODELS));
      return;
    }

    try {
      const upstream = await fetch(joinUrl(account.baseUrl, "/models"), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${account.apiKey}`,
          Accept: "application/json",
        },
      });

      const payload = await upstream.text();
      if (upstream.status === 404 && account.defaultModel) {
        respondJson(response, buildModelListPayload([account.defaultModel]));
        return;
      }

      copyUpstreamHeaders(response, upstream.headers);
      response.writeHead(upstream.status);
      response.end(payload);
    } catch (error) {
      respondJsonError(response, 502, `获取模型列表失败：${formatError(error)}`);
    }
  }

  /**
   * 按账号类型构造并发送上游 `/responses` 请求。
   *
   * @param account 当前激活账号。
   * @param rawBody 原始请求体。
   * @param stream 是否为流式响应。
   * @returns 上游 `fetch` 响应对象。
   */
  private async dispatchResponsesRequest(
    account: GatewayRuntimeAccount,
    rawBody: Buffer,
    stream: boolean,
  ): Promise<UpstreamDispatchResult> {
    if (account.kind === "official") {
      const response = await dispatchOfficialResponsesRequest(
        account,
        rawBody,
        stream,
      );
      return {
        response,
        upstreamStatusCode: response.status,
      };
    }

    return dispatchThirdPartyResponsesRequest(account, rawBody, stream);
  }
}

/**
 * 发送官方账号请求。
 *
 * @param account 官方账号定义。
 * @param rawBody 原始请求体。
 * @param stream 是否为流式响应。
 * @returns 上游响应对象。
 */
async function dispatchOfficialResponsesRequest(
  account: OfficialGatewayAccount,
  rawBody: Buffer,
  stream: boolean,
): Promise<Response> {
  if (!account.session?.accountId) {
    throw new Error("官方账号缺少 account_id，无法发起 /responses 请求。");
  }

  return fetch(joinUrl(account.baseUrl, "/responses"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.session.accessToken}`,
      "ChatGPT-Account-Id": account.session.accountId,
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      Origin: "https://chatgpt.com",
      Referer: "https://chatgpt.com/",
      "OpenAI-Beta": "responses=experimental",
      Originator: "codex_cli_rs",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Codex Space Switcher/0.2",
      Version: "0.21.0",
      Session_id: `codex-space-switcher-${Date.now()}`,
      Connection: "keep-alive",
      "Accept-Language": "en-US,en;q=0.9",
    },
    body: rawBody,
  });
}

/**
 * 发送第三方账号请求。
 *
 * @param account 第三方账号定义。
 * @param rawBody 原始请求体。
 * @param stream 是否为流式响应。
 * @returns 上游响应对象。
 */
async function dispatchThirdPartyResponsesRequest(
  account: ThirdPartyGatewayAccount,
  rawBody: Buffer,
  stream: boolean,
): Promise<UpstreamDispatchResult> {
  if (account.apiProtocol === "chat_completions") {
    return dispatchChatCompletionsResponsesRequest(account, rawBody);
  }

  const response = await fetch(joinUrl(account.baseUrl, "/responses"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.apiKey}`,
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
    },
    body: rawBody,
  });

  return {
    response,
    upstreamStatusCode: response.status,
  };
}

/**
 * 透明转发上游响应，并在过程中捕获 usage。
 *
 * @param response Node HTTP 响应对象。
 * @param upstream 上游响应对象。
 * @param requestStream 当前请求是否声明了流式返回。
 * @returns 捕获到的 usage；若没有识别到则返回 `null`。
 */
async function proxyUpstreamResponse(
  response: import("node:http").ServerResponse,
  upstream: Response,
  requestStream: boolean,
  startedAt: number,
): Promise<ProxiedResponseCapture> {
  copyUpstreamHeaders(response, upstream.headers);
  const emptyTiming: OutputTimingSnapshot = {
    firstOutputLatencyMs: null,
    outputDurationMs: null,
  };

  const contentType = upstream.headers.get("content-type") ?? "";
  const isEventStream =
    requestStream || contentType.includes("text/event-stream");

  if (!isEventStream) {
    const payload = await upstream.text();
    response.writeHead(upstream.status);
    response.end(payload);

    try {
      return {
        usage: extractUsageFromPayload(JSON.parse(payload)),
        timing: emptyTiming,
      };
    } catch {
      return {
        usage: null,
        timing: emptyTiming,
      };
    }
  }

  response.writeHead(upstream.status);
  if (!upstream.body) {
    response.end();
    return {
      usage: null,
      timing: emptyTiming,
    };
  }

  const timingTracker = new OutputTimingTracker(startedAt);
  const collector = new SseUsageCollector({
    onOutputStarted: () => timingTracker.markOutputStarted(),
  });
  const reader = upstream.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    collector.pushChunk(value);
    response.write(Buffer.from(value));
  }

  response.end();
  return {
    usage: collector.finish(),
    timing: timingTracker.finish(),
  };
}

/**
 * 尝试从请求体中读取模型名和 stream 标记。
 *
 * @param rawBody 原始请求体。
 * @returns 解析出的最小请求元数据。
 */
function parseResponsesRequestMeta(rawBody: Buffer): ResponsesRequestMeta {
  try {
    const payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    return {
      model:
        typeof payload["model"] === "string" ? payload["model"] : null,
      stream: payload["stream"] === true,
    };
  } catch {
    return {
      model: null,
      stream: false,
    };
  }
}

/**
 * 读取整个 HTTP 请求体。
 *
 * @param request Node HTTP 请求对象。
 * @returns 完整请求体字节。
 */
function readRequestBody(
  request: import("node:http").IncomingMessage,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

/**
 * 把上游头信息拷贝到 Node 响应对象中，并过滤掉不适合透传的 hop-by-hop 头。
 *
 * @param response Node HTTP 响应对象。
 * @param headers 上游头集合。
 * @returns 无返回值。
 */
function copyUpstreamHeaders(
  response: import("node:http").ServerResponse,
  headers: Headers,
): void {
  for (const [key, value] of headers.entries()) {
    if (
      key === "content-length" ||
      key === "transfer-encoding" ||
      key === "connection" ||
      key === "content-encoding"
    ) {
      continue;
    }

    response.setHeader(key, value);
  }
}

/**
 * 返回一个 JSON 错误对象。
 *
 * @param response Node HTTP 响应对象。
 * @param statusCode HTTP 状态码。
 * @param message 错误信息。
 * @returns 无返回值。
 */
function respondJsonError(
  response: import("node:http").ServerResponse,
  statusCode: number,
  message: string,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(
    JSON.stringify({
      error: message,
    }),
  );
}

/**
 * 返回一个普通 JSON 成功响应。
 *
 * @param response Node HTTP 响应对象。
 * @param payload 返回体对象。
 * @returns 无返回值。
 */
function respondJson(
  response: import("node:http").ServerResponse,
  payload: unknown,
): void {
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

/**
 * 构造兼容 OpenAI 风格的模型列表响应。
 *
 * @param modelIds 需要暴露的模型 ID 列表。
 * @returns 标准模型列表对象。
 */
function buildModelListPayload(modelIds: string[]) {
  return {
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      owned_by: "openai",
    })),
  };
}
