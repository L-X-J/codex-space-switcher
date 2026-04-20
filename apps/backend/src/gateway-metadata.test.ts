import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGatewayMetadataPayload,
  buildGatewayRoutePaths,
  isGatewayMetadataRequest,
  isGatewayModelsRequest,
  isGatewayResponsesPath,
  isGatewayResponsesRequest,
} from "./gateway-metadata.ts";

/**
 * 本文件验证网关根路径说明接口的匹配规则与返回负载。
 * 这些测试保证 `/ai-router/api` 不再误落到静态资源 404，同时不影响已有 `/v1/*` 协议入口。
 */

test("isGatewayMetadataRequest 应匹配 provider 根路径与版本根路径", () => {
  assert.equal(isGatewayMetadataRequest("/ai-router/api", "GET"), true);
  assert.equal(isGatewayMetadataRequest("/ai-router/api/v1", "GET"), true);
});

test("buildGatewayRoutePaths 应同时提供 provider 与版本化路径", () => {
  const routes = buildGatewayRoutePaths();

  assert.equal(routes.providerBasePath, "/ai-router/api");
  assert.equal(routes.gatewayBasePath, "/ai-router/api/v1");
  assert.equal(routes.providerResponsesPath, "/ai-router/api/responses");
  assert.equal(routes.providerModelsPath, "/ai-router/api/models");
  assert.equal(routes.versionedResponsesPath, "/ai-router/api/v1/responses");
  assert.equal(routes.versionedModelsPath, "/ai-router/api/v1/models");
});

test("isGatewayResponsesRequest 应兼容 provider 与版本化 responses 路径", () => {
  assert.equal(isGatewayResponsesRequest("/ai-router/api/responses", "POST"), true);
  assert.equal(isGatewayResponsesRequest("/ai-router/api/v1/responses", "POST"), true);
  assert.equal(isGatewayResponsesRequest("/ai-router/api/responses", "GET"), false);
});

test("isGatewayModelsRequest 应兼容 provider 与版本化 models 路径", () => {
  assert.equal(isGatewayModelsRequest("/ai-router/api/models", "GET"), true);
  assert.equal(isGatewayModelsRequest("/ai-router/api/v1/models", "GET"), true);
  assert.equal(isGatewayModelsRequest("/ai-router/api/models", "POST"), false);
});

test("buildGatewayMetadataPayload 应优先暴露 provider 风格路径", () => {
  const payload = buildGatewayMetadataPayload();

  assert.equal(payload.ok, true);
  assert.equal(payload.providerBasePath, "/ai-router/api");
  assert.equal(payload.gatewayBasePath, "/ai-router/api/v1");
  assert.equal(payload.routes.responses, "/ai-router/api/responses");
  assert.equal(payload.routes.models, "/ai-router/api/models");
  assert.equal(payload.routes.versionedResponses, "/ai-router/api/v1/responses");
  assert.equal(payload.routes.versionedModels, "/ai-router/api/v1/models");
  assert.match(payload.message, /provider 路径/);
});

test("isGatewayResponsesPath 应识别 provider 与版本化 responses 路径", () => {
  assert.equal(isGatewayResponsesPath("/ai-router/api/responses"), true);
  assert.equal(isGatewayResponsesPath("/ai-router/api/v1/responses"), true);
  assert.equal(isGatewayResponsesPath("/ai-router/api/models"), false);
});
