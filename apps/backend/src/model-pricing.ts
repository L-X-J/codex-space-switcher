import type {
  ThirdPartyBillingRule,
  ThirdPartyPricingRule,
  UsageEventRecord,
} from "../../../packages/shared/src/index.ts";

/**
 * 本文件维护“按官方公开定价估算费用”的规则。
 * 这些费率用于本地仪表盘估算，不用于账单对账。
 *
 * 当前价格基线按 2026-04-17 的 OpenAI 官方价格页整理：
 * - GPT-5.4：输入 2.50 / 缓存输入 0.25 / 输出 15.00（USD / 1M tokens）
 * - GPT-5.4 mini：输入 0.75 / 缓存输入 0.075 / 输出 4.50
 * - GPT-5.4 nano：输入 0.20 / 缓存输入 0.02 / 输出 1.25
 * - GPT-5.3 codex：输入 1.75 / 缓存输入 0.175 / 输出 14.00
 */

export interface ModelPricingRule {
  prefix: string;
  inputPerMillionUsd: number;
  cachedInputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

const MODEL_PRICING_RULES: ModelPricingRule[] = [
  {
    prefix: "gpt-5.4-mini",
    inputPerMillionUsd: 0.75,
    cachedInputPerMillionUsd: 0.075,
    outputPerMillionUsd: 4.5,
  },
  {
    prefix: "gpt-5.4-nano",
    inputPerMillionUsd: 0.2,
    cachedInputPerMillionUsd: 0.02,
    outputPerMillionUsd: 1.25,
  },
  {
    prefix: "gpt-5.3-codex",
    inputPerMillionUsd: 1.75,
    cachedInputPerMillionUsd: 0.175,
    outputPerMillionUsd: 14,
  },
  {
    prefix: "gpt-5.3-chat-latest",
    inputPerMillionUsd: 1.75,
    cachedInputPerMillionUsd: 0.175,
    outputPerMillionUsd: 14,
  },
  {
    prefix: "gpt-5.4",
    inputPerMillionUsd: 2.5,
    cachedInputPerMillionUsd: 0.25,
    outputPerMillionUsd: 15,
  },
  {
    prefix: "gpt-5",
    inputPerMillionUsd: 2.5,
    cachedInputPerMillionUsd: 0.25,
    outputPerMillionUsd: 15,
  },
];

const DEFAULT_MODEL_PRICING = MODEL_PRICING_RULES.find(
  (rule) => rule.prefix === "gpt-5.4",
)!;

/**
 * 根据模型名挑选最接近的官方费率规则。
 *
 * @param model 模型名。
 * @returns 命中的费率规则；未知模型时回退到默认规则。
 */
export function resolveModelPricingRule(model: string): ModelPricingRule {
  const normalizedModel = model.trim().toLowerCase();

  for (const rule of MODEL_PRICING_RULES) {
    if (normalizedModel.startsWith(rule.prefix)) {
      return rule;
    }
  }

  return DEFAULT_MODEL_PRICING;
}

/**
 * 按官方费率估算一次请求的美元成本。
 *
 * @param model 模型名。
 * @param inputTokens 输入 token，总量包含命中 cache 的部分。
 * @param cachedInputTokens 输入 token 中命中缓存的子集。
 * @param outputTokens 输出 token。
 * @returns 估算成本，单位 USD。
 */
export function estimateModelCostUsd(
  model: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  pricingOverride?: ThirdPartyPricingRule | null,
): number {
  const pricing = pricingOverride ?? resolveModelPricingRule(model);
  const safeInputTokens = Math.max(inputTokens, 0);
  const safeCachedTokens = Math.max(
    Math.min(cachedInputTokens, safeInputTokens),
    0,
  );
  const uncachedInputTokens = Math.max(safeInputTokens - safeCachedTokens, 0);

  return (
    (uncachedInputTokens / 1_000_000) * pricing.inputPerMillionUsd +
    (safeCachedTokens / 1_000_000) * pricing.cachedInputPerMillionUsd +
    (Math.max(outputTokens, 0) / 1_000_000) * pricing.outputPerMillionUsd
  );
}

/**
 * 按事件本身携带的 token 统计重新估算费用。
 *
 * @param event 已落盘的 usage 事件。
 * @param billingRule 账号级计费规则。
 * @returns 当前规则下的费用。
 */
export function estimateUsageEventCostUsd(
  event: Pick<
    UsageEventRecord,
    "model" | "inputTokens" | "cachedInputTokens" | "outputTokens"
  >,
  billingRule?: ThirdPartyBillingRule | null,
): number {
  return estimateModelCostUsd(
    event.model,
    event.inputTokens,
    event.cachedInputTokens,
    event.outputTokens,
    billingRule?.pricing ?? null,
  );
}
