import test from "node:test";
import assert from "node:assert/strict";
import { deriveHealth } from "./space-usage-provider.ts";

/**
 * 本文件验证健康状态归一化。
 * 首版最容易漂移的部分就是把不同私有字段映射成统一健康状态，因此要把阈值和耗尽语义固定下来。
 */

test("额度剩余为 0 时应判定为 exhausted", () => {
  const result = deriveHealth(
    {},
    {
      unit: "requests",
      used: 100,
      limit: 100,
      remaining: 0,
      percentUsed: 100,
      windowLabel: "today",
    },
    null,
  );

  assert.equal(result, "exhausted");
});

test("接近配额上限时应判定为 warning", () => {
  const result = deriveHealth(
    {},
    {
      unit: "requests",
      used: 85,
      limit: 100,
      remaining: 15,
      percentUsed: 85,
      windowLabel: "today",
    },
    null,
  );

  assert.equal(result, "warning");
});

test("存在用量信息且未接近上限时应判定为 healthy", () => {
  const result = deriveHealth(
    {},
    {
      unit: "requests",
      used: 40,
      limit: 100,
      remaining: 60,
      percentUsed: 40,
      windowLabel: "today",
    },
    null,
  );

  assert.equal(result, "healthy");
});
