import type {
  ThirdPartyBillingRule,
  ThirdPartyPricingRule,
  ThirdPartyQuotaRule,
  ThirdPartyTokenQuotaRule,
} from "../../../packages/shared/src/index.ts";
import { HttpError } from "./http-error.ts";

/**
 * 本文件负责第三方账号自定义计费规则的校验、归一化与展示辅助。
 * 它只处理“账号级规则本身”，不关心事件聚合与窗口统计。
 */

/**
 * 归一化第三方账号的账号级计费规则。
 *
 * @param rule 前端提交的原始规则。
 * @returns 可安全落盘的规则；若用户完全未配置则返回 `undefined`。
 */
export function normalizeThirdPartyBillingRule(
  rule: ThirdPartyBillingRule | null | undefined,
): ThirdPartyBillingRule | undefined {
  const pricing = normalizeThirdPartyPricingRule(rule?.pricing);
  const quota = normalizeThirdPartyQuotaRule(rule?.quota);

  if (!pricing && !quota) {
    return undefined;
  }

  return {
    ...(pricing ? { pricing } : {}),
    ...(quota ? { quota } : {}),
  };
}

/**
 * 判断当前规则是否启用了自定义单价。
 *
 * @param rule 账号级计费规则。
 * @returns 启用时返回 `true`。
 */
export function hasCustomThirdPartyPricing(
  rule: ThirdPartyBillingRule | null | undefined,
): boolean {
  return Boolean(rule?.pricing);
}

/**
 * 生成适合展示在账号诊断区的一行计费摘要。
 *
 * @param rule 当前账号的计费规则。
 * @returns 简短摘要；若完全未配置则返回 `null`。
 */
export function describeThirdPartyBillingRule(
  rule: ThirdPartyBillingRule | null | undefined,
): string | null {
  if (!rule) {
    return null;
  }

  const parts: string[] = [];
  if (rule.pricing) {
    parts.push("已启用自定义单价");
  }

  if (rule.quota?.shortWindowBudgetUsd !== undefined) {
    parts.push(
      `${rule.quota.shortWindowKind === "daily" ? "每日" : "5 小时"}额度 ${formatUsd(rule.quota.shortWindowBudgetUsd)}`,
    );
  }

  if (rule.quota?.weeklyBudgetUsd !== undefined) {
    parts.push(`每周额度 ${formatUsd(rule.quota.weeklyBudgetUsd)}`);
  }

  if (rule.quota?.totalBudgetUsd !== undefined) {
    parts.push(`总金额额度 ${formatUsd(rule.quota.totalBudgetUsd)}`);
  }

  if (rule.quota?.tokenQuota) {
    parts.push(
      `每月 Token 额度 ${formatTokenCount(rule.quota.tokenQuota.limitTokens)}`,
    );
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * 取出可用于费用估算的单价覆盖。
 *
 * @param rule 当前账号的计费规则。
 * @returns 自定义单价；若未设置则返回 `null`。
 */
export function getThirdPartyPricingOverride(
  rule: ThirdPartyBillingRule | null | undefined,
): ThirdPartyPricingRule | null {
  return rule?.pricing ?? null;
}

/**
 * 归一化第三方账号的自定义单价。
 *
 * @param pricing 原始单价对象。
 * @returns 标准化结果；若完全未配置则返回 `undefined`。
 */
function normalizeThirdPartyPricingRule(
  pricing: ThirdPartyPricingRule | null | undefined,
): ThirdPartyPricingRule | undefined {
  const input = normalizeOptionalMoney(
    pricing?.inputPerMillionUsd,
    "第三方账号输入计费",
  );
  const output = normalizeOptionalMoney(
    pricing?.outputPerMillionUsd,
    "第三方账号输出计费",
  );
  const cached = normalizeOptionalMoney(
    pricing?.cachedInputPerMillionUsd,
    "第三方账号 cache 计费",
  );

  const configuredValues = [input, output, cached].filter(
    (value) => value !== undefined,
  );
  if (configuredValues.length === 0) {
    return undefined;
  }

  if (configuredValues.length !== 3) {
    throw new HttpError(
      400,
      "第三方账号自定义单价需要同时填写输入计费、输出计费和 cache 计费，或全部留空。",
    );
  }

  return {
    inputPerMillionUsd: input!,
    outputPerMillionUsd: output!,
    cachedInputPerMillionUsd: cached!,
  };
}

/**
 * 归一化第三方账号的额度配置。
 *
 * @param quota 原始额度对象。
 * @returns 标准化结果；若完全未配置则返回 `undefined`。
 */
function normalizeThirdPartyQuotaRule(
  quota: ThirdPartyQuotaRule | null | undefined,
): ThirdPartyQuotaRule | undefined {
  const weeklyBudgetUsd = normalizeOptionalMoney(
    quota?.weeklyBudgetUsd,
    "第三方账号每周额度",
  );
  const shortWindowBudgetUsd = normalizeOptionalMoney(
    quota?.shortWindowBudgetUsd,
    "第三方账号短周期额度",
  );
  const totalBudgetUsd = normalizeOptionalMoney(
    quota?.totalBudgetUsd,
    "第三方账号总金额额度",
  );
  const tokenQuota = normalizeThirdPartyTokenQuotaRule(quota?.tokenQuota);

  if (
    weeklyBudgetUsd === undefined &&
    shortWindowBudgetUsd === undefined &&
    totalBudgetUsd === undefined &&
    tokenQuota === undefined &&
    quota?.shortWindowKind === undefined
  ) {
    return undefined;
  }

  if (
    quota?.shortWindowKind &&
    shortWindowBudgetUsd === undefined &&
    weeklyBudgetUsd === undefined &&
    totalBudgetUsd === undefined &&
    tokenQuota === undefined
  ) {
    throw new HttpError(
      400,
      "第三方账号已选择每天或每 5 小时额度，但没有填写对应额度值。",
    );
  }

  const shortWindowKind =
    shortWindowBudgetUsd !== undefined
      ? normalizeShortWindowKind(quota?.shortWindowKind)
      : undefined;

  return {
    ...(weeklyBudgetUsd !== undefined ? { weeklyBudgetUsd } : {}),
    ...(shortWindowBudgetUsd !== undefined
      ? { shortWindowBudgetUsd, shortWindowKind }
      : {}),
    ...(totalBudgetUsd !== undefined ? { totalBudgetUsd } : {}),
    ...(tokenQuota ? { tokenQuota } : {}),
  };
}

/**
 * 归一化第三方账号的 token 额度配置。
 *
 * @param tokenQuota 原始 token 额度对象。
 * @returns 标准化结果；若完全未配置则返回 `undefined`。
 */
function normalizeThirdPartyTokenQuotaRule(
  tokenQuota: ThirdPartyTokenQuotaRule | null | undefined,
): ThirdPartyTokenQuotaRule | undefined {
  const limitTokens = normalizeOptionalTokenCount(
    tokenQuota?.limitTokens,
    "第三方账号 Token 总额",
  );

  if (limitTokens === undefined && tokenQuota?.windowKind === undefined) {
    return undefined;
  }

  if (limitTokens === undefined) {
    throw new HttpError(
      400,
      "第三方账号已选择 Token 额度周期，但没有填写 Token 总额。",
    );
  }

  return {
    limitTokens,
    windowKind: normalizeTokenQuotaWindowKind(tokenQuota?.windowKind),
  };
}

/**
 * 标准化短周期额度窗口类型。
 *
 * @param kind 原始类型。
 * @returns 合法窗口类型。
 */
function normalizeShortWindowKind(
  kind: string | null | undefined,
): "daily" | "five_hour" {
  if (kind === undefined || kind === null || kind === "") {
    return "five_hour";
  }

  if (kind === "daily" || kind === "five_hour") {
    return kind;
  }

  throw new HttpError(400, "第三方账号短周期额度类型只支持每天或每 5 小时。");
}

/**
 * 标准化 token 额度窗口类型。
 *
 * @param kind 原始类型。
 * @returns 合法窗口类型。
 */
function normalizeTokenQuotaWindowKind(
  kind: string | null | undefined,
): "monthly" {
  if (kind === undefined || kind === null || kind === "") {
    return "monthly";
  }

  if (kind === "monthly") {
    return kind;
  }

  throw new HttpError(400, "第三方账号 Token 额度类型目前只支持每月。");
}

/**
 * 将可选的金额输入归一化为非负数字。
 *
 * @param value 原始值。
 * @param label 字段名。
 * @returns 金额；留空时返回 `undefined`。
 */
function normalizeOptionalMoney(
  value: number | null | undefined,
  label: string,
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (!Number.isFinite(value)) {
    throw new HttpError(400, `${label}必须是有效数字。`);
  }

  if (value < 0) {
    throw new HttpError(400, `${label}不能为负数。`);
  }

  return Number(value);
}

/**
 * 将可选的 token 总数输入归一化为非负整数。
 *
 * @param value 原始值。
 * @param label 字段名。
 * @returns token 数量；留空时返回 `undefined`。
 */
function normalizeOptionalTokenCount(
  value: number | null | undefined,
  label: string,
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (!Number.isFinite(value)) {
    throw new HttpError(400, `${label}必须是有效数字。`);
  }

  if (value < 0) {
    throw new HttpError(400, `${label}不能为负数。`);
  }

  if (!Number.isInteger(value)) {
    throw new HttpError(400, `${label}必须是整数。`);
  }

  return Number(value);
}

/**
 * 把美元金额格式化成简短摘要。
 *
 * @param value 金额。
 * @returns 适合诊断区展示的字符串。
 */
function formatUsd(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 1 ? 2 : 4,
    maximumFractionDigits: value >= 1 ? 2 : 4,
  }).format(value);
}

/**
 * 把 token 数量格式化成简短摘要。
 *
 * @param value token 数量。
 * @returns 适合诊断区展示的字符串。
 */
function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}
