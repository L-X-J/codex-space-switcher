import test from "node:test";
import assert from "node:assert/strict";
import { decodeJwtPayload } from "./utils.ts";

/**
 * 本文件验证 JWT 解码逻辑。
 * 会话读取依赖本地 auth.json 中的 token 负载，因此需要确保最基础的字段提取不会回归。
 */

/**
 * 构造一个最小可解析 JWT。
 *
 * @param payload 负载对象。
 * @returns 仅用于测试的 token 字符串。
 */
function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

test("decodeJwtPayload 应能解析 account 命名空间字段", () => {
  const token = createJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acc_test_123",
    },
  });

  const payload = decodeJwtPayload(token);
  assert.equal(
    (payload?.["https://api.openai.com/auth"] as { chatgpt_account_id: string })
      .chatgpt_account_id,
    "acc_test_123",
  );
});

test("decodeJwtPayload 对非法 token 返回 null", () => {
  assert.equal(decodeJwtPayload("not-a-jwt"), null);
});
