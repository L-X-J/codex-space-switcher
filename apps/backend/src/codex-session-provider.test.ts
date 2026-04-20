import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPersistedOfficialSessionSnapshot,
  parseCodexSessionPayload,
} from "./codex-session-provider.ts";
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

test("parseCodexSessionPayload 应能直接读取 /api/auth/session 返回体", () => {
  const token = createJwt({
    exp: 1_776_940_047,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acc_from_jwt",
    },
  });

  const session = parseCodexSessionPayload({
    user: {
      email: "demo@example.com",
      name: "演示账号",
    },
    account: {
      id: "acc_from_payload",
    },
    expires: "2026-07-12T10:31:10.006Z",
    accessToken: token,
  });

  assert.equal(session.authMode, "chatgpt_api_auth_session");
  assert.equal(session.accountId, "acc_from_jwt");
  assert.equal(session.email, "demo@example.com");
  assert.equal(session.userName, "演示账号");
  assert.equal(session.expiresAt, "2026-07-12T10:31:10.006Z");
});

test("buildPersistedOfficialSessionSnapshot 会丢弃 sessionToken 等无关敏感字段", () => {
  const token = createJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acc_snapshot",
    },
  });

  const snapshot = buildPersistedOfficialSessionSnapshot({
    accessToken: token,
    sessionToken: "should-not-be-persisted",
    user: {
      email: "snapshot@example.com",
      name: "快照账号",
    },
    account: {
      id: "acc_snapshot",
    },
    expires: "2026-07-12T10:31:10.006Z",
  });

  assert.equal(snapshot.source, "chatgpt_api_auth_session");
  assert.equal(snapshot.accountId, "acc_snapshot");
  assert.equal(snapshot.email, "snapshot@example.com");
  assert.equal("sessionToken" in snapshot, false);
});
