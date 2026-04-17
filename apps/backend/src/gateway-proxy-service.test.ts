import test from "node:test";
import assert from "node:assert/strict";

import { joinUrl } from "./gateway-proxy-service.ts";

/**
 * 本文件验证网关上游 URL 的拼接规则。
 * 真实联调里如果把 `/responses` 直接喂给 `new URL()`，会把 base path 整段吞掉，最后请求落到错误地址。
 */

test("joinUrl 应保留官方 baseUrl 的路径前缀", () => {
  const url = joinUrl(
    "https://chatgpt.com/backend-api/codex",
    "/responses",
  );

  assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
});

test("joinUrl 应保留第三方 baseUrl 的路径前缀", () => {
  const url = joinUrl(
    "https://api.routin.ai/plan/v1",
    "/models",
  );

  assert.equal(url, "https://api.routin.ai/plan/v1/models");
});
