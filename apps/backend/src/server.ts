import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  DashboardStatus,
  ServerEvent,
  SpaceCard,
  SwitchRequestBody,
  TokenUsageSummary,
} from "../../../packages/shared/src/index.ts";
import { FRONTEND_ROOT, HOST, PORT } from "./config.ts";
import { loadCodexSession } from "./codex-session-provider.ts";
import { inspectCodexRuntime } from "./codex-runtime-inspector.ts";
import { log } from "./logger.ts";
import { createIdleSwitchJob, loadPersistedState, savePersistedState } from "./state-store.ts";
import { loadSpaces } from "./space-usage-provider.ts";
import { SpaceSwitchService } from "./space-switch-service.ts";
import { loadTokenUsageSummary } from "./token-usage-provider.ts";
import { formatError } from "./utils.ts";

/**
 * 本文件是本地控制台的服务入口。
 * 它同时承担静态资源服务、REST API 与 SSE 推送，保证首版部署只有一个本地进程。
 */

const RUNTIME_REFRESH_INTERVAL_MS = 5_000;
const TOKEN_USAGE_REFRESH_INTERVAL_MS = 5_000;
const SPACE_REFRESH_INTERVAL_MS = 90_000;

let spacesCache: SpaceCard[] = [];
let dashboardStatus: DashboardStatus = {
  activeSpaceId: null,
  activeSpaceName: null,
  runtime: {
    state: "unknown",
    isBusy: false,
    lastObservedAt: new Date().toISOString(),
    detail: "服务尚未完成首次运行态探测。",
  },
  switchJob: createIdleSwitchJob(),
  lastSwitchResult: null,
};
let tokenUsageCache: TokenUsageSummary = {
  generatedAt: new Date().toISOString(),
  today: {
    label: "今日",
    windowStart: null,
    windowEnd: null,
    totals: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
    sessions: 0,
    byKind: [],
  },
  last7Days: {
    label: "近 7 天",
    windowStart: null,
    windowEnd: null,
    totals: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
    sessions: 0,
    byKind: [],
  },
  latestSession: null,
};

const sseClients = new Set<import("node:http").ServerResponse>();

const switchService = new SpaceSwitchService({
  getSpaces: async () => spacesCache,
  getStatus: async () => dashboardStatus,
  setStatus: async (updater) => {
    dashboardStatus = updater(dashboardStatus);
    await savePersistedState(dashboardStatus);
    broadcast({
      type: "codex.status_changed",
      payload: dashboardStatus,
    });
  },
  reloadSpaces: async () => {
    await refreshSpaces();
    return spacesCache;
  },
});

switchService.subscribe((event) => {
  broadcast(event);
});

/**
 * 服务启动入口。
 *
 * @returns 无返回值。
 */
async function main(): Promise<void> {
  const persisted = await loadPersistedState();
  dashboardStatus = {
    ...dashboardStatus,
    switchJob: persisted.switchJob,
    lastSwitchResult: persisted.lastSwitchResult,
  };

  await refreshSpaces();
  await refreshRuntime();
  await refreshTokenUsage();
  setInterval(() => {
    void refreshRuntime();
  }, RUNTIME_REFRESH_INTERVAL_MS).unref();
  setInterval(() => {
    void refreshSpaces();
  }, SPACE_REFRESH_INTERVAL_MS).unref();
  setInterval(() => {
    void refreshTokenUsage();
  }, TOKEN_USAGE_REFRESH_INTERVAL_MS).unref();

  const server = createServer(async (request, response) => {
    try {
      await routeRequest(request, response);
    } catch (error) {
      response.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });

  server.listen(PORT, HOST, () => {
    log("info", `本地控制台已启动：http://${HOST}:${PORT}`);
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

  if (url.pathname === "/api/spaces" && request.method === "GET") {
    return respondJson(response, spacesCache);
  }

  if (url.pathname === "/api/status" && request.method === "GET") {
    return respondJson(response, dashboardStatus);
  }

  if (url.pathname === "/api/token-usage" && request.method === "GET") {
    return respondJson(response, tokenUsageCache);
  }

  if (url.pathname === "/api/refresh" && request.method === "POST") {
    await refreshSpaces();
    await refreshRuntime();
    await refreshTokenUsage();
    return respondJson(response, {
      ok: true,
    });
  }

  if (url.pathname === "/api/switch" && request.method === "POST") {
    const body = (await readJsonBody(request)) as SwitchRequestBody;
    const result = await switchService.enqueue(body.targetSpaceId);
    return respondJson(response, {
      result,
    });
  }

  if (url.pathname === "/api/events" && request.method === "GET") {
    return handleSse(response);
  }

  return serveFrontend(url.pathname, response);
}

/**
 * 刷新空间列表并更新顶部摘要。
 *
 * @returns 无返回值。
 */
async function refreshSpaces(): Promise<void> {
  try {
    const session = await loadCodexSession();
    spacesCache = await loadSpaces(session);
    const active = spacesCache.find((space) => space.isActive) ?? null;
    dashboardStatus = {
      ...dashboardStatus,
      activeSpaceId: active?.id ?? null,
      activeSpaceName: active?.name ?? null,
    };
    await savePersistedState(dashboardStatus);
    broadcast({
      type: "spaces.updated",
      payload: spacesCache,
    });
  } catch (error) {
    spacesCache = [
      {
        id: "session-error",
        name: "登录态不可用",
        kind: "unknown",
        isActive: true,
        usageSummary: null,
        quotaSummary: null,
        health: "error",
        lastCheckedAt: new Date().toISOString(),
        rawDiagnostics: [
          `空间刷新失败：${formatError(error)}`,
        ],
      },
    ];
    dashboardStatus = {
      ...dashboardStatus,
      activeSpaceId: "session-error",
      activeSpaceName: "登录态不可用",
      lastSwitchResult:
        dashboardStatus.lastSwitchResult ??
        "尚未成功拉取空间列表，请检查 Codex Desktop 登录态。",
    };
    await savePersistedState(dashboardStatus);
    broadcast({
      type: "spaces.updated",
      payload: spacesCache,
    });
  }
}

/**
 * 刷新 Codex Desktop 运行态。
 *
 * @returns 无返回值。
 */
async function refreshRuntime(): Promise<void> {
  dashboardStatus = {
    ...dashboardStatus,
    runtime: await inspectCodexRuntime(),
  };
  await savePersistedState(dashboardStatus);
  broadcast({
    type: "codex.status_changed",
    payload: dashboardStatus,
  });
}

/**
 * 刷新 token 用量总览。
 *
 * @returns 无返回值。
 */
async function refreshTokenUsage(): Promise<void> {
  try {
    tokenUsageCache = await loadTokenUsageSummary();
  } catch (error) {
    tokenUsageCache = {
      ...tokenUsageCache,
      generatedAt: new Date().toISOString(),
      latestSession: {
        capturedAt: new Date().toISOString(),
        kind: "unknown",
        totals: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
        },
        sourceFile: `token usage refresh failed: ${formatError(error)}`,
      },
    };
  }

  broadcast({
    type: "token_usage.updated",
    payload: tokenUsageCache,
  });
}

/**
 * 读取 JSON 请求体。
 *
 * @param request HTTP 请求对象。
 * @returns 解析后的 JSON。
 * @throws 当请求体为空或 JSON 非法时抛出异常。
 */
async function readJsonBody(
  request: import("node:http").IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 0 ? JSON.parse(text) : {};
}

/**
 * 发送 JSON 响应。
 *
 * @param response HTTP 响应对象。
 * @param body 响应体对象。
 * @returns 无返回值。
 */
function respondJson(
  response: import("node:http").ServerResponse,
  body: unknown,
): void {
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

/**
 * 建立 SSE 连接并注册客户端。
 *
 * @param response HTTP 响应对象。
 * @returns 无返回值。
 */
function handleSse(response: import("node:http").ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  response.write(`event: ready\ndata: {"ok":true}\n\n`);
  sseClients.add(response);
  response.on("close", () => {
    sseClients.delete(response);
  });
}

/**
 * 广播一个 SSE 事件到所有已连接客户端。
 *
 * @param event 事件对象。
 * @returns 无返回值。
 */
function broadcast(event: ServerEvent<unknown>): void {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
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
  const normalizedPath =
    pathname === "/"
      ? path.join(FRONTEND_ROOT, "index.html")
      : path.join(FRONTEND_ROOT, pathname.replace(/^\/+/, ""));

  try {
    const content = await readFile(normalizedPath);
    response.writeHead(200, {
      "Content-Type": detectContentType(normalizedPath),
    });
    response.end(content);
  } catch {
    response.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Not Found");
  }
}

/**
 * 根据文件后缀推断静态资源类型。
 *
 * @param filePath 文件路径。
 * @returns MIME 类型字符串。
 */
function detectContentType(filePath: string): string {
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }

  return "text/html; charset=utf-8";
}

void main();
