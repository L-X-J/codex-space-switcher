import {
  GATEWAY_BASE_PATH,
  GATEWAY_PROVIDER_BASE_PATH,
} from "./config.ts";

/**
 * 本文件集中描述本地代理的“根路径元信息”响应。
 * 这样 `server.ts` 只负责路由分发，而路径说明、浏览器提示和后续兼容扩展都收敛在一个地方。
 */

export interface GatewayMetadataPayload {
  ok: true;
  message: string;
  providerBasePath: string;
  gatewayBasePath: string;
  routes: {
    responses: string;
    models: string;
    versionedResponses: string;
    versionedModels: string;
  };
}

export interface GatewayRoutePaths {
  providerBasePath: string;
  gatewayBasePath: string;
  providerResponsesPath: string;
  providerModelsPath: string;
  versionedResponsesPath: string;
  versionedModelsPath: string;
}

/**
 * 返回当前服务支持的 provider 路径与版本化路径。
 *
 * @returns 一组稳定的网关路径定义。
 */
export function buildGatewayRoutePaths(): GatewayRoutePaths {
  return {
    providerBasePath: GATEWAY_PROVIDER_BASE_PATH,
    gatewayBasePath: GATEWAY_BASE_PATH,
    providerResponsesPath: `${GATEWAY_PROVIDER_BASE_PATH}/responses`,
    providerModelsPath: `${GATEWAY_PROVIDER_BASE_PATH}/models`,
    versionedResponsesPath: `${GATEWAY_BASE_PATH}/responses`,
    versionedModelsPath: `${GATEWAY_BASE_PATH}/models`,
  };
}

/**
 * 判断某个请求是否命中了网关根路径说明接口。
 *
 * 这里同时兼容 provider 根路径 `/ai-router/api` 与协议版本根路径 `/ai-router/api/v1`。
 * 前者对应 Codex `base_url` 配置；后者更接近实际暴露的协议层入口。
 *
 * @param pathname 当前请求路径。
 * @param method 当前请求方法。
 * @returns 若应返回网关说明则为 `true`，否则为 `false`。
 */
export function isGatewayMetadataRequest(
  pathname: string,
  method: string | undefined,
): boolean {
  const routes = buildGatewayRoutePaths();
  return (
    method === "GET" &&
    (pathname === routes.providerBasePath || pathname === routes.gatewayBasePath)
  );
}

/**
 * 判断某个路径是否命中 `/responses` 协议入口。
 *
 * WebSocket upgrade 会以 `GET` 进入，但仍然需要落到与 HTTP POST 相同的 responses 网关路径。
 *
 * @param pathname 当前请求路径。
 * @returns 若命中 responses 路径则为 `true`。
 */
export function isGatewayResponsesPath(pathname: string): boolean {
  const routes = buildGatewayRoutePaths();
  return (
    pathname === routes.providerResponsesPath ||
    pathname === routes.versionedResponsesPath
  );
}

/**
 * 判断某个请求是否应交给 `/responses` 代理处理。
 *
 * @param pathname 当前请求路径。
 * @param method 当前请求方法。
 * @returns 若应转给 responses 代理则为 `true`。
 */
export function isGatewayResponsesRequest(
  pathname: string,
  method: string | undefined,
): boolean {
  return method === "POST" && isGatewayResponsesPath(pathname);
}

/**
 * 判断某个请求是否应交给 `/models` 代理处理。
 *
 * @param pathname 当前请求路径。
 * @param method 当前请求方法。
 * @returns 若应转给 models 代理则为 `true`。
 */
export function isGatewayModelsRequest(
  pathname: string,
  method: string | undefined,
): boolean {
  const routes = buildGatewayRoutePaths();
  return (
    method === "GET" &&
    (pathname === routes.providerModelsPath ||
      pathname === routes.versionedModelsPath)
  );
}

/**
 * 构造浏览器直接访问根路径时返回的说明负载。
 *
 * @returns 一份稳定且可读的 JSON 说明，便于手工排查 404、代理配置和协议路径。
 */
export function buildGatewayMetadataPayload(): GatewayMetadataPayload {
  const routes = buildGatewayRoutePaths();
  return {
    ok: true,
    message:
      "这是 Codex Space Switcher 的本地代理根路径。Codex 会使用 provider 路径自动追加 /responses 或 /models；版本化路径仍保留用于调试与兼容。",
    providerBasePath: routes.providerBasePath,
    gatewayBasePath: routes.gatewayBasePath,
    routes: {
      responses: routes.providerResponsesPath,
      models: routes.providerModelsPath,
      versionedResponses: routes.versionedResponsesPath,
      versionedModels: routes.versionedModelsPath,
    },
  };
}
