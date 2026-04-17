import test from "node:test";
import assert from "node:assert/strict";

import { estimateModelCostUsd } from "./model-pricing.ts";

/**
 * 本文件固定费用估算的基本公式。
 * 重点是保证 cache token 使用折扣费率，而不是和普通输入重复按原价计费。
 */

test("费用估算应对 cached input 使用单独费率", () => {
  const cost = estimateModelCostUsd(
    "gpt-5.4",
    1_000_000,
    200_000,
    100_000,
  );

  assert.equal(cost, 3.55);
});
