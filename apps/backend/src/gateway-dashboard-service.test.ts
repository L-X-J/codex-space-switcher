import test from "node:test";
import assert from "node:assert/strict";

import { pickHealthyActiveAccountId } from "./gateway-dashboard-service.ts";

/**
 * 本文件验证网关默认激活账号的兜底挑选逻辑。
 * 真实环境里最容易翻车的是“第一个账号虽然有配置，但远端已经 401/失效”，因此这里把自动回避 error 账号的行为锁住。
 */

function createAccount(
  id: string,
  health: "healthy" | "warning" | "exhausted" | "error",
) {
  return {
    id,
    name: id,
    kind: id.includes("third") ? "third_party" : "official",
    isActive: false,
    health,
    statusLabel: health,
    lastCheckedAt: null,
    officialUsage: null,
    cumulativeUsage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      requests: 0,
    },
    rawDiagnostics: [],
  } as const;
}

test("当首选账号处于 error 时，应自动回退到第一个非 error 账号", () => {
  const accounts = [
    createAccount("official-a", "error"),
    createAccount("official-b", "healthy"),
    createAccount("third-party-c", "healthy"),
  ];

  const picked = pickHealthyActiveAccountId(accounts, "official-a");
  assert.equal(picked, "official-b");
});

test("当首选账号仍然健康时，应继续保留当前激活账号", () => {
  const accounts = [
    createAccount("official-a", "healthy"),
    createAccount("official-b", "healthy"),
  ];

  const picked = pickHealthyActiveAccountId(accounts, "official-b");
  assert.equal(picked, "official-b");
});
