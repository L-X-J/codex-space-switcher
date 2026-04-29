import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, rm, writeFile } from "node:fs/promises";

import { GatewayProxyService } from "./gateway-proxy-service.ts";
import type { ThirdPartyGatewayAccount } from "./gateway-account-store.ts";
import { GATEWAY_USAGE_EVENTS_FILE } from "./config.ts";

/**
 * 本文件用本地 fake Chat Completions 服务验证代理集成路径。
 * 重点不是测试 fetch 本身，而是确认 `/responses` 入口会按 chat_completions 账号走协议适配，并把 usage 记录回调打通。
 */

test("chat_completions 账号应通过 /responses 返回 Codex Responses SSE", async () => {
  const usageEventsSnapshot = await readOptionalTextFile(GATEWAY_USAGE_EVENTS_FILE);
  const fakeChatServer = await startFakeChatServer();
  const upstreamBaseUrl = `http://127.0.0.1:${addressPort(fakeChatServer)}/v1`;
  const account = buildChatAccount(upstreamBaseUrl);
  const requests: Array<{ model: string | null; statusText: string }> = [];
  let usageRefreshCount = 0;
  const proxyService = new GatewayProxyService({
    getActiveAccount: async () => account,
    recordGatewayRequest: async (result) => {
      requests.push({
        model: result.model,
        statusText: result.statusText,
      });
    },
    onUsageRecorded: async () => {
      usageRefreshCount += 1;
    },
  });
  const proxyServer = await startProxyServer(proxyService);

  try {
    const response = await fetch(
      `http://127.0.0.1:${addressPort(proxyServer)}/ai-router/api/responses`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "codex_cli_rs test",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          instructions: "只回答文本",
          input: "hello",
          stream: true,
        }),
      },
    );

    const text = await response.text();
    const events = parseSseEvents(text);

    assert.equal(response.status, 200);
    assert.equal(events.at(-1)?.type, "response.completed");
    assert.equal(
      events.find((event) => event.type === "response.output_item.done")
        ?.item?.content?.[0]?.text,
      "Hi from MiMo",
    );
    assert.equal(events.at(-1)?.response?.usage?.input_tokens, 11);
    assert.equal(requests[0]?.model, "mimo-v2.5-pro");
    assert.match(requests[0]?.statusText ?? "", /返回 200/);
    await waitFor(() => usageRefreshCount === 1);
    assert.equal(usageRefreshCount, 1);
  } finally {
    await closeServer(proxyServer);
    await closeServer(fakeChatServer);
    await restoreTextFile(GATEWAY_USAGE_EVENTS_FILE, usageEventsSnapshot);
  }
});

/**
 * 启动 fake Chat Completions 服务。
 *
 * @returns HTTP server。
 */
function startFakeChatServer(): Promise<Server> {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }

    const body = JSON.parse(await readRequestText(request)) as {
      model: string;
      messages: unknown[];
      stream: boolean;
    };

    assert.equal(body.model, "mimo-v2.5-pro");
    assert.equal(body.stream, true);
    assert.equal(body.messages.length, 2);

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    response.write(chatFrame({
      choices: [{ delta: { content: "Hi " }, finish_reason: null }],
    }));
    response.write(chatFrame({
      choices: [{ delta: { content: "from MiMo" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 3,
        total_tokens: 14,
      },
    }));
    response.end("data: [DONE]\n\n");
  });

  return listen(server);
}

/**
 * 等待异步代理收尾逻辑完成。
 * HTTP 响应会先结束，usage 落盘和看板刷新回调随后才执行，因此测试需要短暂轮询。
 *
 * @param predicate 完成条件。
 * @returns 无返回值。
 */
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 启动只暴露 `/responses` 的本地代理测试服务。
 *
 * @param proxyService 代理服务实例。
 * @returns HTTP server。
 */
function startProxyServer(proxyService: GatewayProxyService): Promise<Server> {
  const server = createServer((request, response) => {
    void proxyService.handleResponses(request, response);
  });
  return listen(server);
}

/**
 * 构造 chat_completions 第三方账号。
 *
 * @param baseUrl fake 上游 base URL。
 * @returns 运行时账号。
 */
function buildChatAccount(baseUrl: string): ThirdPartyGatewayAccount {
  return {
    id: "mimo-token-plan",
    name: "MiMo Token Plan",
    kind: "third_party",
    isConfigured: true,
    isActive: true,
    rawDiagnostics: [],
    apiKey: "tp-test",
    baseUrl,
    apiProtocol: "chat_completions",
    defaultModel: "mimo-v2.5-pro",
    requiresResponsesWebSocket: false,
    billingRule: null,
  };
}

/**
 * 监听随机端口。
 *
 * @param server HTTP server。
 * @returns 已启动 server。
 */
function listen(server: Server): Promise<Server> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/**
 * 关闭 server。
 *
 * @param server HTTP server。
 * @returns 无返回值。
 */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * 获取 server 当前端口。
 *
 * @param server HTTP server。
 * @returns 端口号。
 */
function addressPort(server: Server): number {
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return (address as AddressInfo).port;
}

/**
 * 读取请求体文本。
 *
 * @param request HTTP 请求。
 * @returns 请求体文本。
 */
function readRequestText(
  request: import("node:http").IncomingMessage,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * 构造 Chat SSE 帧。
 *
 * @param payload Chat chunk。
 * @returns SSE 文本。
 */
function chatFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 解析本地 Responses SSE 文本。
 *
 * @param text SSE 文本。
 * @returns JSON 事件数组。
 */
function parseSseEvents(text: string): any[] {
  return text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data:\s*/, "")));
}

/**
 * 读取可选文本文件。
 *
 * @param filePath 文件路径。
 * @returns 文件内容；文件不存在时返回 `null`。
 */
async function readOptionalTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * 将测试前的文件内容恢复回去，避免集成测试污染真实本地 usage 审计。
 *
 * @param filePath 文件路径。
 * @param snapshot 测试前快照。
 * @returns 无返回值。
 */
async function restoreTextFile(
  filePath: string,
  snapshot: string | null,
): Promise<void> {
  if (snapshot === null) {
    await rm(filePath, { force: true });
    return;
  }

  await writeFile(filePath, snapshot, "utf8");
}
