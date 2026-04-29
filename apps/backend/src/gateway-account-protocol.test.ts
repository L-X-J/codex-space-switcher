import test from "node:test";
import assert from "node:assert/strict";

import {
  accountAllowsResponsesWebSocket,
  resolveThirdPartyApiProtocol,
} from "./gateway-account-store.ts";

/**
 * 本文件验证第三方账号协议字段的兼容默认值。
 * 旧配置升级后不能因为缺少 `apiProtocol` 就改变路由行为；MiMo Chat 适配账号也不能重新打开 WebSocket。
 */

test("旧第三方配置缺省 apiProtocol 时应按 responses 处理", () => {
  assert.equal(resolveThirdPartyApiProtocol(undefined), "responses");
});

test("chat_completions 账号即使勾选 WebSocket 也应强制关闭", () => {
  assert.equal(
    accountAllowsResponsesWebSocket({
      apiProtocol: "chat_completions",
      requiresResponsesWebSocket: true,
    }),
    false,
  );
});

test("responses 账号仍应保留原有 WebSocket 开关行为", () => {
  assert.equal(
    accountAllowsResponsesWebSocket({
      apiProtocol: "responses",
      requiresResponsesWebSocket: true,
    }),
    true,
  );
});
