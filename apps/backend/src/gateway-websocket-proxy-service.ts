import net from "node:net";
import tls from "node:tls";

import type { ProxyClientKind } from "../../../packages/shared/src/index.ts";
import { appendUsageEvent } from "./usage-event-store.ts";
import type {
  GatewayRuntimeAccount,
  OfficialGatewayAccount,
  ThirdPartyGatewayAccount,
} from "./gateway-account-store.ts";
import { detectProxyClient, readHeaderValue } from "./gateway-client-detection.ts";
import { buildUsageEvent } from "./gateway-usage-event.ts";
import { formatError } from "./utils.ts";
import {
  WebSocketUsageCollector,
  type WebSocketUsageMessage,
} from "./websocket-response-usage-capture.ts";

/**
 * 本文件负责 `/responses` 的 WebSocket upgrade 隧道转发。
 * 某些中转站会要求 Codex 把 responses 会话升级成 `ws://` / `wss://`，这里不解析帧内容，只做握手与双向字节流透传。
 */

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
  "authorization",
  "content-length",
]);

const HANDSHAKE_TIMEOUT_MS = 10_000;

interface GatewayWebSocketProxyServiceOptions {
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

interface UpstreamHandshakeResult {
  upstreamSocket: net.Socket;
  handshakeResponse: Buffer;
  leftover: Buffer;
}

export class GatewayWebSocketProxyService {
  constructor(private readonly options: GatewayWebSocketProxyServiceOptions) {}

  /**
   * 处理 `/responses` 的 WebSocket upgrade。
   *
   * @param request upgrade 对应的 HTTP 请求对象。
   * @param socket 当前客户端 TCP socket。
   * @param head Node 在 upgrade 时额外读到但尚未消费的字节。
   * @returns 在握手转发完成后结束。
   */
  async handleResponsesUpgrade(
    request: import("node:http").IncomingMessage,
    socket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    const requestAt = new Date().toISOString();
    const startedAt = Date.now();
    const model = parseResponsesWebSocketModel(request.url ?? "/");
    const client = detectProxyClient(request);
    const account = await this.options.getActiveAccount();

    if (!account || !account.isConfigured) {
      await this.options.recordGatewayRequest({
        requestAt,
        model,
        statusText: "没有可用的激活账号（WebSocket）。",
        clientKind: client.kind,
        clientLabel: client.label,
        isLikelyCodex: client.isLikelyCodex,
      });
      writeHttpError(socket, 503, "当前没有可用的激活账号。");
      return;
    }

    try {
      const upstreamUrl = buildResponsesWebSocketUrl(account.baseUrl, request.url ?? "/");
      const handshake = await openUpstreamWebSocketHandshake({
        account,
        request,
        upstreamUrl,
      });

      const statusCode = parseHttpStatusCode(handshake.handshakeResponse);
      await this.options.recordGatewayRequest({
        requestAt,
        model,
        statusText:
          statusCode === 101
            ? `${account.name} WebSocket 已连接`
            : `${account.name} WebSocket 握手失败 ${statusCode ?? "unknown"}`,
        clientKind: client.kind,
        clientLabel: client.label,
        isLikelyCodex: client.isLikelyCodex,
      });

      socket.write(handshake.handshakeResponse);

      if (statusCode !== 101) {
        await this.recordUsageEvent(
          account,
          model,
          statusCode ?? 502,
          requestAt,
          Date.now() - startedAt,
        );
        if (handshake.leftover.length > 0) {
          socket.write(handshake.leftover);
        }
        handshake.upstreamSocket.pipe(socket);
        handshake.upstreamSocket.on("end", () => {
          socket.end();
        });
        handshake.upstreamSocket.on("error", () => {
          socket.destroy();
        });
        return;
      }

      if (head.length > 0) {
        handshake.upstreamSocket.write(head);
      }
      if (handshake.leftover.length > 0) {
        socket.write(handshake.leftover);
      }

      this.bridgeSocketsWithUsageCapture({
        account,
        clientSocket: socket,
        upstreamSocket: handshake.upstreamSocket,
        initialUpstreamChunk: handshake.leftover,
        model,
        requestAt,
        startedAt,
      });
    } catch (error) {
      await this.options.recordGatewayRequest({
        requestAt,
        model,
        statusText: `WebSocket 请求失败：${formatError(error)}`,
        clientKind: client.kind,
        clientLabel: client.label,
        isLikelyCodex: client.isLikelyCodex,
      });
      if (account) {
        await this.recordUsageEvent(
          account,
          model,
          502,
          requestAt,
          Date.now() - startedAt,
          `request_failed:${formatError(error)}`,
        );
      }
      writeHttpError(socket, 502, `本地 WebSocket 代理失败：${formatError(error)}`);
    }
  }

  /**
   * 连接客户端与上游 socket，并在透传过程中旁路提取 usage。
   *
   * @param options 会话上下文。
   * @returns 无返回值。
   */
  private bridgeSocketsWithUsageCapture(options: {
    account: GatewayRuntimeAccount;
    clientSocket: net.Socket;
    upstreamSocket: net.Socket;
    initialUpstreamChunk: Buffer;
    model: string | null;
    requestAt: string;
    startedAt: number;
  }): void {
    const {
      account,
      clientSocket,
      upstreamSocket,
      initialUpstreamChunk,
      model,
      requestAt,
      startedAt,
    } = options;
    const collector = new WebSocketUsageCollector();
    let finalized = false;
    let overrideStatus: string | undefined;
    const pendingWrites = new Set<Promise<void>>();

    const finalize = async () => {
      if (finalized) {
        return;
      }
      finalized = true;

      if (pendingWrites.size > 0) {
        await Promise.allSettled([...pendingWrites]);
      }

      const fallbackMessages = collector.finish();
      for (const message of fallbackMessages) {
        await this.recordWebSocketUsageMessage(
          account,
          model,
          requestAt,
          startedAt,
          message,
          overrideStatus,
        );
      }
    };

    const markError = (side: "client" | "upstream", error: Error) => {
      if (!overrideStatus) {
        overrideStatus = `websocket_${side}_error:${formatError(error)}`;
      }
      void finalize();
    };

    const relayToUpstream = (chunk: Buffer) => {
      if (!upstreamSocket.destroyed) {
        upstreamSocket.write(chunk);
      }
    };

    const relayToClient = (chunk: Buffer) => {
      const messages = collector.pushChunk(chunk);
      for (const message of messages) {
        const writeTask = this.recordWebSocketUsageMessage(
          account,
          model,
          requestAt,
          startedAt,
          message,
        ).finally(() => {
          pendingWrites.delete(writeTask);
        });
        pendingWrites.add(writeTask);
      }
      if (!clientSocket.destroyed) {
        clientSocket.write(chunk);
      }
    };

    clientSocket.on("data", relayToUpstream);
    upstreamSocket.on("data", relayToClient);

    clientSocket.on("error", (error) => {
      upstreamSocket.destroy();
      markError("client", error);
    });
    upstreamSocket.on("error", (error) => {
      clientSocket.destroy();
      markError("upstream", error);
    });
    clientSocket.on("close", () => {
      upstreamSocket.destroy();
      void finalize();
    });
    upstreamSocket.on("close", () => {
      clientSocket.destroy();
      void finalize();
    });

    if (initialUpstreamChunk.length > 0) {
      relayToClient(initialUpstreamChunk);
    }
  }

  /**
   * 落盘一条 WebSocket usage 事件，并触发看板刷新。
   *
   * @param account 当前账号。
   * @param model 当前会话模型名。
   * @param statusCode 握手状态码。
   * @param requestAt 事件创建时间。
   * @param latencyMs 会话持续时间。
   * @param overrideStatus 可选覆盖状态。
   * @param usage 会话内捕获到的 usage。
   * @returns 无返回值。
   */
  private async recordUsageEvent(
    account: GatewayRuntimeAccount,
    model: string | null,
    statusCode: number,
    requestAt: string,
    latencyMs: number,
    overrideStatus?: string,
    usage = null,
  ): Promise<void> {
    await appendUsageEvent(
      buildUsageEvent(
        account,
        model,
        usage,
        statusCode,
        latencyMs,
        requestAt,
        overrideStatus,
      ),
    );
    await this.options.onUsageRecorded();
  }

  /**
   * 把单条 WebSocket usage 消息转换成落盘事件。
   *
   * @param account 当前账号。
   * @param fallbackModel 握手阶段可见的模型名。
   * @param requestAt 会话开始时间。
   * @param startedAt 会话开始时间戳。
   * @param message 已解析出的 usage 消息。
   * @param overrideStatus 可选覆盖状态。
   * @returns 无返回值。
   */
  private async recordWebSocketUsageMessage(
    account: GatewayRuntimeAccount,
    fallbackModel: string | null,
    requestAt: string,
    startedAt: number,
    message: WebSocketUsageMessage,
    overrideStatus?: string,
  ): Promise<void> {
    await this.recordUsageEvent(
      account,
      message.model || fallbackModel,
      101,
      requestAt,
      Date.now() - startedAt,
      overrideStatus,
      message.usage,
    );
  }
}

interface OpenUpstreamHandshakeOptions {
  account: GatewayRuntimeAccount;
  request: import("node:http").IncomingMessage;
  upstreamUrl: URL;
}

/**
 * 与上游完成 WebSocket 握手，并返回原始握手响应与可继续透传的 socket。
 *
 * @param options 握手所需上下文。
 * @returns 握手结果，包含已连接 socket 与首个响应分片。
 */
async function openUpstreamWebSocketHandshake(
  options: OpenUpstreamHandshakeOptions,
): Promise<UpstreamHandshakeResult> {
  const { upstreamUrl } = options;
  const upstreamSocket = await createUpstreamSocket(upstreamUrl);

  return new Promise<UpstreamHandshakeResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const timeout = setTimeout(() => {
      cleanup();
      upstreamSocket.destroy();
      reject(new Error("上游 WebSocket 握手超时。"));
    }, HANDSHAKE_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      upstreamSocket.off("data", handleData);
      upstreamSocket.off("error", handleError);
      upstreamSocket.off("close", handleClose);
    };

    const settle = (value: UpstreamHandshakeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const handleError = (error: Error) => {
      fail(error);
    };

    const handleClose = () => {
      fail(new Error("上游在完成 WebSocket 握手前关闭了连接。"));
    };

    const handleData = (chunk: Buffer) => {
      chunks.push(chunk);
      const combined = Buffer.concat(chunks);
      const headerEnd = combined.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }

      const handshakeResponse = combined.subarray(0, headerEnd + 4);
      const leftover = combined.subarray(headerEnd + 4);
      settle({
        upstreamSocket,
        handshakeResponse,
        leftover,
      });
    };

    upstreamSocket.on("data", handleData);
    upstreamSocket.once("error", handleError);
    upstreamSocket.once("close", handleClose);
    upstreamSocket.write(buildUpstreamHandshakeRequest(options));
  });
}

/**
 * 按上游 URL 建立 TCP 或 TLS 连接。
 *
 * @param upstreamUrl 上游 WebSocket URL。
 * @returns 已连接的 socket。
 */
function createUpstreamSocket(upstreamUrl: URL): Promise<net.Socket> {
  const port = Number.parseInt(
    upstreamUrl.port || (upstreamUrl.protocol === "wss:" ? "443" : "80"),
    10,
  );
  const host = upstreamUrl.hostname;

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    const onError = (error: Error) => {
      settle(() => reject(error));
    };

    const socket =
      upstreamUrl.protocol === "wss:"
        ? tls.connect({
            host,
            port,
            servername: host,
          })
        : net.connect({
            host,
            port,
          });

    socket.once("error", onError);

    const onReady = () => {
      socket.off("error", onError);
      settle(() => resolve(socket));
    };

    if (upstreamUrl.protocol === "wss:") {
      socket.once("secureConnect", onReady);
      return;
    }

    socket.once("connect", onReady);
  });
}

/**
 * 构造发往上游的 WebSocket 握手请求报文。
 *
 * @param options 握手所需上下文。
 * @returns 原始 HTTP/1.1 请求文本。
 */
function buildUpstreamHandshakeRequest(
  options: OpenUpstreamHandshakeOptions,
): string {
  const { account, request, upstreamUrl } = options;
  const forwardedHeaders = collectForwardHeaders(request);
  const authHeaders =
    account.kind === "official"
      ? buildOfficialWebSocketHeaders(account)
      : buildThirdPartyWebSocketHeaders(account);

  const headers = new Map<string, string>();
  headers.set("Host", upstreamUrl.host);
  headers.set("Connection", "Upgrade");
  headers.set("Upgrade", "websocket");

  copyHeaderIfPresent(headers, request, "sec-websocket-key", "Sec-WebSocket-Key");
  copyHeaderIfPresent(
    headers,
    request,
    "sec-websocket-version",
    "Sec-WebSocket-Version",
  );
  copyHeaderIfPresent(
    headers,
    request,
    "sec-websocket-protocol",
    "Sec-WebSocket-Protocol",
  );
  copyHeaderIfPresent(
    headers,
    request,
    "sec-websocket-extensions",
    "Sec-WebSocket-Extensions",
  );

  for (const [key, value] of forwardedHeaders.entries()) {
    headers.set(key, value);
  }
  for (const [key, value] of Object.entries(authHeaders)) {
    headers.set(key, value);
  }

  const headerLines = [...headers.entries()].map(([key, value]) => `${key}: ${value}`);
  return [
    `GET ${upstreamUrl.pathname}${upstreamUrl.search} HTTP/1.1`,
    ...headerLines,
    "",
    "",
  ].join("\r\n");
}

/**
 * 透传客户端原始请求头，但去掉会由代理重新生成的 hop-by-hop 字段。
 *
 * @param request upgrade 请求对象。
 * @returns 可直接发给上游的头集合。
 */
function collectForwardHeaders(
  request: import("node:http").IncomingMessage,
): Map<string, string> {
  const headers = new Map<string, string>();

  for (const [key, rawValue] of Object.entries(request.headers)) {
    if (!rawValue || HOP_BY_HOP_REQUEST_HEADERS.has(key)) {
      continue;
    }

    const normalizedName = key
      .split("-")
      .map((segment) => segment.slice(0, 1).toUpperCase() + segment.slice(1))
      .join("-");
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    headers.set(normalizedName, value);
  }

  return headers;
}

/**
 * 为官方账号构造握手时必须补充的鉴权和客户端头。
 *
 * @param account 官方账号定义。
 * @returns 头字段字典。
 */
function buildOfficialWebSocketHeaders(
  account: OfficialGatewayAccount,
): Record<string, string> {
  if (!account.session?.accountId) {
    throw new Error("官方账号缺少 account_id，无法发起 WebSocket /responses 请求。");
  }

  return {
    Authorization: `Bearer ${account.session.accessToken}`,
    "ChatGPT-Account-Id": account.session.accountId,
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    "OpenAI-Beta": "responses=experimental",
    Originator: "codex_cli_rs",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Codex Space Switcher/0.2",
    Version: "0.21.0",
    Session_id: `codex-space-switcher-${Date.now()}`,
    "Accept-Language": "en-US,en;q=0.9",
  };
}

/**
 * 为第三方账号构造握手所需的头。
 *
 * @param account 第三方账号定义。
 * @returns 头字段字典。
 */
function buildThirdPartyWebSocketHeaders(
  account: ThirdPartyGatewayAccount,
): Record<string, string> {
  return {
    Authorization: `Bearer ${account.apiKey}`,
  };
}

/**
 * 把本地 provider `base_url` 转成上游 WebSocket URL，并保留原始查询参数。
 *
 * @param baseUrl 当前激活账号的 HTTP base_url。
 * @param requestUrl 本地 upgrade 请求 URL。
 * @returns 指向上游 `/responses` 的 `ws:` 或 `wss:` URL。
 */
export function buildResponsesWebSocketUrl(
  baseUrl: string,
  requestUrl: string,
): URL {
  const upstream = new URL("responses", `${baseUrl.replace(/\/+$/, "")}/`);
  upstream.protocol = upstream.protocol === "https:" ? "wss:" : "ws:";

  const localUrl = new URL(requestUrl, "http://127.0.0.1");
  upstream.search = localUrl.search;
  return upstream;
}

/**
 * 从原始握手响应首行里读取 HTTP 状态码。
 *
 * @param handshakeResponse 上游返回的握手响应头。
 * @returns 可识别时返回状态码，否则返回 `null`。
 */
function parseHttpStatusCode(handshakeResponse: Buffer): number | null {
  const firstLine = handshakeResponse.toString("utf8").split("\r\n", 1)[0] ?? "";
  const match = firstLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

/**
 * 从 WebSocket upgrade URL 查询参数里读取模型名。
 *
 * @param requestUrl 本地 upgrade 请求 URL。
 * @returns 可识别的模型名；缺失时返回 `null`。
 */
function parseResponsesWebSocketModel(requestUrl: string): string | null {
  const url = new URL(requestUrl, "http://127.0.0.1");
  const model = url.searchParams.get("model");
  return model && model.trim().length > 0 ? model.trim() : null;
}

/**
 * 仅当指定请求头存在时才复制到目标头集合。
 *
 * @param headers 目标头集合。
 * @param request 源请求对象。
 * @param sourceName 源头名。
 * @param targetName 目标头名。
 * @returns 无返回值。
 */
function copyHeaderIfPresent(
  headers: Map<string, string>,
  request: import("node:http").IncomingMessage,
  sourceName: string,
  targetName: string,
): void {
  const value = readHeaderValue(request, sourceName);
  if (value) {
    headers.set(targetName, value);
  }
}

/**
 * 在本地握手阶段直接返回一个 HTTP 错误响应。
 *
 * @param socket 客户端 socket。
 * @param statusCode HTTP 状态码。
 * @param message 错误消息。
 * @returns 无返回值。
 */
function writeHttpError(
  socket: net.Socket,
  statusCode: number,
  message: string,
): void {
  const body = JSON.stringify({ error: message });
  socket.end(
    [
      `HTTP/1.1 ${statusCode} ${httpStatusText(statusCode)}`,
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n"),
  );
}

/**
 * 为常见错误码返回可读的状态文本。
 *
 * @param statusCode HTTP 状态码。
 * @returns 对应状态文本。
 */
function httpStatusText(statusCode: number): string {
  if (statusCode === 503) {
    return "Service Unavailable";
  }

  if (statusCode === 502) {
    return "Bad Gateway";
  }

  return "Error";
}
