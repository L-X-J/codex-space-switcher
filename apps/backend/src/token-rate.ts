/**
 * 本文件集中维护 token 速率的计算口径。
 * 当前看板展示的是“生成速率”的近似值，因此只使用输出 token，而不是包含输入上下文的总 token。
 */

/**
 * 按输出 token 和请求耗时估算生成速率。
 *
 * @param outputTokens 本次请求生成的输出 token 数量。
 * @param latencyMs 请求从进入本地代理到响应完成的耗时。
 * @returns token/秒；耗时非法或无输出 token 时返回 0，避免展示无意义的 Infinity。
 */
export function calculateTokenRatePerSecond(
  outputTokens: number,
  latencyMs: number,
): number {
  if (!Number.isFinite(outputTokens) || !Number.isFinite(latencyMs)) {
    return 0;
  }

  const safeOutputTokens = Math.max(outputTokens, 0);
  const safeLatencyMs = Math.max(latencyMs, 0);
  if (safeOutputTokens === 0 || safeLatencyMs === 0) {
    return 0;
  }

  return safeOutputTokens / (safeLatencyMs / 1000);
}
