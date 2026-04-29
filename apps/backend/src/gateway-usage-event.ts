import type {
  UsageEventRecord,
} from "../../../packages/shared/src/index.ts";
import { estimateModelCostUsd } from "./model-pricing.ts";
import type { GatewayRuntimeAccount } from "./gateway-account-store.ts";
import { createId } from "./utils.ts";
import type { CapturedUsage } from "./response-usage-capture.ts";

/**
 * 本文件统一封装代理层 usage 事件的构造逻辑。
 * HTTP `/responses` 与 WebSocket `/responses` 都应复用这里，避免统计字段和费用估算口径漂移。
 */

/**
 * 根据捕获到的 usage 构造落盘事件。
 *
 * @param account 当前命中的运行时账号。
 * @param model 请求声明的模型；缺失时会回退到账号默认模型。
 * @param usage 捕获到的 usage；为 `null` 时按 0 token 处理。
 * @param statusCode 上游状态码。
 * @param latencyMs 请求或会话耗时。
 * @param createdAt 事件时间。
 * @param overrideStatus 可选覆盖状态，用于标记本地错误或特殊关闭原因。
 * @returns 可直接落盘的标准事件对象。
 */
export function buildUsageEvent(
  account: GatewayRuntimeAccount,
  model: string | null,
  usage: CapturedUsage | null,
  statusCode: number,
  latencyMs: number,
  createdAt: string,
  overrideStatus?: string,
): UsageEventRecord {
  const resolvedModel = model || inferDefaultModel(account);
  const inputTokens = usage?.inputTokens ?? 0;
  const cachedInputTokens = usage?.cachedInputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const totalTokens =
    usage?.totalTokens ?? Math.max(inputTokens + outputTokens, 0);
  const tokenRatePerSecond = calculateTokenRatePerSecond(totalTokens, latencyMs);

  return {
    id: createId(),
    accountId: account.id,
    accountName: account.name,
    accountKind: account.kind,
    model: resolvedModel,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUsd: estimateModelCostUsd(
      resolvedModel,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      account.kind === "third_party" ? account.billingRule?.pricing ?? null : null,
    ),
    status:
      overrideStatus ??
      (statusCode >= 400 ? `upstream_${statusCode}` : "completed"),
    latencyMs,
    tokenRatePerSecond,
    createdAt,
  };
}

/**
 * 按请求耗时估算 token 速率。
 *
 * @param totalTokens 本次请求捕获到的总 token；缺失 usage 时通常为 0。
 * @param latencyMs 请求从进入本地代理到响应完成的耗时。
 * @returns token/秒；耗时非法或无 token 时返回 0，避免展示无意义的 Infinity。
 */
export function calculateTokenRatePerSecond(
  totalTokens: number,
  latencyMs: number,
): number {
  if (!Number.isFinite(totalTokens) || !Number.isFinite(latencyMs)) {
    return 0;
  }

  const safeTokens = Math.max(totalTokens, 0);
  const safeLatencyMs = Math.max(latencyMs, 0);
  if (safeTokens === 0 || safeLatencyMs === 0) {
    return 0;
  }

  return safeTokens / (safeLatencyMs / 1000);
}

/**
 * 为某个账号推断缺省模型名。
 *
 * @param account 当前账号。
 * @returns 可用于费用估算的模型名。
 */
export function inferDefaultModel(account: GatewayRuntimeAccount): string {
  if (account.kind === "third_party" && account.defaultModel) {
    return account.defaultModel;
  }

  return "gpt-5.4";
}
