import assert from "node:assert/strict";
import test from "node:test";

import { buildResponsesWebSocketUrl } from "./gateway-websocket-proxy-service.ts";

/**
 * 本文件覆盖 WebSocket 代理里最容易回退的 URL 变换规则。
 * 如果这里把本地 `/ai-router/api/*` 直接透传给上游，就会让需要 `/responses` 的中转站收到错误路径。
 */

test("buildResponsesWebSocketUrl 应把 http provider base_url 转成 ws responses 地址", () => {
  const url = buildResponsesWebSocketUrl(
    "http://127.0.0.1:6789/ai-router/api",
    "/ai-router/api/responses?model=gpt-5.4&stream=true",
  );

  assert.equal(
    url.toString(),
    "ws://127.0.0.1:6789/ai-router/api/responses?model=gpt-5.4&stream=true",
  );
});

test("buildResponsesWebSocketUrl 应把 https provider base_url 转成 wss responses 地址", () => {
  const url = buildResponsesWebSocketUrl(
    "https://relay.example.com/openai/v1",
    "/ai-router/api/v1/responses",
  );

  assert.equal(url.toString(), "wss://relay.example.com/openai/v1/responses");
});
