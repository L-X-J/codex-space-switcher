import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ActivateAccountRequestBody,
  CreateAccountRequestBody,
  UpdateAccountRequestBody,
  SetCodexProxyEnabledRequestBody,
  ServerEvent,
} from "../../../packages/shared/src/index.ts";
import { FRONTEND_ROOT, HOST, PORT } from "./config.ts";
import { createGatewayAccount } from "./gateway-account-creation-service.ts";
import {
  getEditableAccountDetail,
  updateGatewayAccount,
} from "./gateway-account-update-service.ts";
import {
  buildGatewayMetadataPayload,
  isGatewayMetadataRequest,
  isGatewayModelsRequest,
  isGatewayResponsesPath,
  isGatewayResponsesRequest,
} from "./gateway-metadata.ts";
import { GatewayDashboardService } from "./gateway-dashboard-service.ts";
import { GatewayProxyService } from "./gateway-proxy-service.ts";
import { GatewayWebSocketProxyService } from "./gateway-websocket-proxy-service.ts";
import {
  buildUsageDashboardSummary,
  listRecentUsageEvents,
} from "./usage-dashboard-provider.ts";
import { loadUsageEvents } from "./usage-event-store.ts";
import { HttpError } from "./http-error.ts";

/**
 * 本文件是本地控制台与代理网关的统一入口。
 * 它负责静态页面、账号看板 API、SSE 事件流，以及转发到官方/第三方账号的 `/responses` 薄网关。
 */

const RUNTIME_REFRESH_INTERVAL_MS = 5_000;
const ACCOUNT_REFRESH_INTERVAL_MS = 60_000;

const sseClients = new Set<import("node:http").ServerResponse>();
const dashboardService = new GatewayDashboardService();
const proxyService = new GatewayProxyService({
  getActiveAccount: async () => dashboardService.getActiveRuntimeAccount(),
  recordGatewayRequest: async (result) => {
    await dashboardService.recordGatewayRequest(result);
  },
  onUsageRecorded: async () => {
    await dashboardService.refreshAccounts();
    dashboardService.notifyUsageUpdated();
  },
});

const websocketProxyService = new GatewayWebSocketProxyService({
  getActiveAccount: async () => dashboardService.getActiveRuntimeAccount(),
  recordGatewayRequest: async (result) => {
    await dashboardService.recordGatewayRequest(result);
  },
  onUsageRecorded: async () => {
    await dashboardService.refreshAccounts();
    dashboardService.notifyUsageUpdated();
  },
});

dashboardService.subscribe((event) => {
  broadcast(event);
});

/**
 * 服务启动入口。
 *
 * @returns 无返回值。
 */
async function main(): Promise<void> {
  await dashboardService.initialize();
  setInterval(() => {
    void dashboardService.refreshRuntime();
    void dashboardService.refreshCodexProxyStatus();
  }, RUNTIME_REFRESH_INTERVAL_MS).unref();
  setInterval(() => {
    void dashboardService.refreshAccounts();
  }, ACCOUNT_REFRESH_INTERVAL_MS).unref();

  const server = createServer(async (request, response) => {
    try {
      await routeRequest(request, response);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }

      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      response.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof HttpError ? error.code : null,
        }),
      );
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
    if (isGatewayResponsesPath(url.pathname)) {
      void websocketProxyService.handleResponsesUpgrade(request, socket, head);
      return;
    }

    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  });

  server.listen(PORT, HOST, () => {
    console.log(`本地控制台已启动：http://${HOST}:${PORT}`);
    console.log(
      `本地代理入口：http://${HOST}:${PORT}/ai-router/api/responses`,
    );
  });
}

/**
 * 根据请求路径分发到不同处理器。
 *
 * @param request HTTP 请求对象。
 * @param response HTTP 响应对象。
 * @returns 无返回值。
 */
async function routeRequest(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

  if (url.pathname === "/api/accounts" && request.method === "GET") {
    return respondJson(response, dashboardService.getAccounts());
  }

  if (url.pathname === "/api/accounts" && request.method === "POST") {
    const body = (await readJsonBody(request)) as CreateAccountRequestBody;
    const created = await createGatewayAccount(body);
    await dashboardService.refreshAccounts();
    dashboardService.notifyUsageUpdated();
    return respondJson(response, created, 201);
  }

  const accountEditMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/edit$/);
  if (accountEditMatch && request.method === "GET") {
    const accountId = decodeURIComponent(accountEditMatch[1]!);
    const detail = await getEditableAccountDetail(accountId);
    return respondJson(response, detail);
  }

  const accountMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
  if (accountMatch && request.method === "PUT") {
    const accountId = decodeURIComponent(accountMatch[1]!);
    const body = (await readJsonBody(request)) as UpdateAccountRequestBody;
    const updated = await updateGatewayAccount(accountId, body);
    const codexConfig = await dashboardService.handleAccountDefinitionUpdated(accountId);
    dashboardService.notifyUsageUpdated();
    return respondJson(response, {
      ...updated,
      codexConfig,
    });
  }

  if (url.pathname === "/api/status" && request.method === "GET") {
    return respondJson(response, dashboardService.getStatus());
  }

  if (url.pathname === "/api/codex-proxy" && request.method === "POST") {
    const body = (await readJsonBody(request)) as SetCodexProxyEnabledRequestBody;
    const result = await dashboardService.setCodexProxyEnabled(body.enabled === true);
    return respondJson(response, result);
  }

  if (url.pathname === "/api/codex/restart" && request.method === "POST") {
    const result = await dashboardService.restartCodexApp();
    return respondJson(response, result);
  }

  if (url.pathname === "/api/usage-dashboard" && request.method === "GET") {
    const events = await loadUsageEvents();
    const filterId = url.searchParams.get("filter") ?? "all";
    const summary = buildUsageDashboardSummary(
      events,
      dashboardService.getAccounts(),
      filterId,
    );
    return respondJson(response, summary);
  }

  if (url.pathname === "/api/usage-events" && request.method === "GET") {
    const events = await loadUsageEvents();
    const filterId = url.searchParams.get("filter") ?? "all";
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
    return respondJson(
      response,
      listRecentUsageEvents(
        events,
        dashboardService.getAccounts(),
        filterId,
        Number.isFinite(limit) && limit > 0 ? limit : 20,
      ),
    );
  }

  if (url.pathname === "/api/refresh" && request.method === "POST") {
    await dashboardService.refreshRuntime();
    await dashboardService.refreshAccounts();
    await dashboardService.refreshCodexProxyStatus();
    dashboardService.notifyUsageUpdated();
    return respondJson(response, { ok: true });
  }

  if (url.pathname === "/api/accounts/activate" && request.method === "POST") {
    const body = (await readJsonBody(request)) as ActivateAccountRequestBody;
    const result = await dashboardService.activateAccount(body.targetAccountId);
    if (!result.ok) {
      response.writeHead(404, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ error: "目标账号不存在，或当前不可用。" }));
      return;
    }

    dashboardService.notifyUsageUpdated();
    return respondJson(response, result);
  }

  if (url.pathname === "/api/accounts/activate-preview" && request.method === "POST") {
    const body = (await readJsonBody(request)) as ActivateAccountRequestBody;
    const result = await dashboardService.previewActivateAccount(body.targetAccountId);
    if (!result.ok) {
      response.writeHead(404, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ error: "目标账号不存在，或当前不可用。" }));
      return;
    }

    return respondJson(response, result);
  }

  if (url.pathname === "/api/events" && request.method === "GET") {
    return handleSse(response);
  }

  if (isGatewayMetadataRequest(url.pathname, request.method)) {
    return respondJson(response, buildGatewayMetadataPayload());
  }

  if (isGatewayResponsesRequest(url.pathname, request.method)) {
    return proxyService.handleResponses(request, response);
  }

  if (isGatewayModelsRequest(url.pathname, request.method)) {
    return proxyService.handleModels(request, response);
  }

  return serveFrontend(url.pathname, response);
}

/**
 * 返回一个 JSON 响应。
 *
 * @param response HTTP 响应对象。
 * @param payload 返回体对象。
 * @returns 无返回值。
 */
function respondJson(
  response: import("node:http").ServerResponse,
  payload: unknown,
  statusCode = 200,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

/**
 * 读取 JSON 请求体。
 *
 * @param request HTTP 请求对象。
 * @returns 解析后的 JSON。
 */
async function readJsonBody(
  request: import("node:http").IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => resolve());
    request.on("error", reject);
  });

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? {} : JSON.parse(raw);
}

/**
 * 打开 SSE 长连接。
 *
 * @param response HTTP 响应对象。
 * @returns 无返回值。
 */
function handleSse(
  response: import("node:http").ServerResponse,
): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  response.write(": connected\n\n");
  sseClients.add(response);

  response.on("close", () => {
    sseClients.delete(response);
  });
}

/**
 * 向所有 SSE 客户端广播事件。
 *
 * @param event 待广播事件。
 * @returns 无返回值。
 */
function broadcast(event: ServerEvent<unknown>): void {
  const serialized = [
    `event: ${event.type}`,
    `data: ${JSON.stringify(event.payload)}`,
    "",
    "",
  ].join("\n");

  for (const client of sseClients) {
    client.write(serialized);
  }
}

/**
 * 提供前端静态资源。
 *
 * @param pathname 请求路径。
 * @param response HTTP 响应对象。
 * @returns 无返回值。
 */
async function serveFrontend(
  pathname: string,
  response: import("node:http").ServerResponse,
): Promise<void> {
  const safePath =
    pathname === "/" ? "/index.html" : pathname;
  const resolvedPath = path.resolve(FRONTEND_ROOT, `.${safePath}`);

  if (!resolvedPath.startsWith(FRONTEND_ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  let content: string;
  try {
    content = await readFile(resolvedPath, "utf8");
  } catch {
    response.writeHead(404);
    response.end("Not Found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentTypeFromPath(resolvedPath),
    "Cache-Control": "no-store",
  });
  response.end(content);
}

/**
 * 根据文件扩展名推断响应类型。
 *
 * @param filePath 文件绝对路径。
 * @returns 对应的 MIME 类型。
 */
function contentTypeFromPath(filePath: string): string {
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }

  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }

  if (filePath.endsWith(".svg")) {
    return "image/svg+xml";
  }

  return "text/html; charset=utf-8";
}

void main();
