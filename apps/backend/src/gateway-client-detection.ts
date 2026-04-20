import type { ProxyClientKind } from "../../../packages/shared/src/index.ts";

/**
 * 本文件统一收敛代理层对客户端身份的识别逻辑。
 * HTTP `/responses` 与 WebSocket upgrade 都会复用这套规则，避免监控面板对同一来源出现两套判定口径。
 */

export interface ProxyClientDetectionResult {
  kind: ProxyClientKind;
  label: string;
  isLikelyCodex: boolean;
}

/**
 * 基于请求头推断当前请求更像是 Codex、浏览器、curl 还是其他客户端。
 *
 * @param request Node HTTP 请求对象。
 * @returns 适合写进监控状态的客户端摘要。
 */
export function detectProxyClient(
  request: import("node:http").IncomingMessage,
): ProxyClientDetectionResult {
  const userAgent = readHeaderValue(request, "user-agent");
  const originator = readHeaderValue(request, "originator");
  const stainlessPackage = readHeaderValue(request, "x-stainless-package");
  const joined = [userAgent, originator, stainlessPackage]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/codex|openai\/codex|codex-cli/.test(joined)) {
    return {
      kind: "codex",
      label: "Codex",
      isLikelyCodex: true,
    };
  }

  if (/curl/.test(userAgent?.toLowerCase() ?? "")) {
    return {
      kind: "curl",
      label: "curl",
      isLikelyCodex: false,
    };
  }

  if (/mozilla|chrome|safari|firefox|edge/.test(userAgent?.toLowerCase() ?? "")) {
    return {
      kind: "browser",
      label: "浏览器",
      isLikelyCodex: false,
    };
  }

  if (/openai|stainless/.test(joined)) {
    return {
      kind: "codex",
      label: "OpenAI SDK",
      isLikelyCodex: true,
    };
  }

  return {
    kind: "unknown",
    label: userAgent?.slice(0, 36) ?? "未知客户端",
    isLikelyCodex: false,
  };
}

/**
 * 从请求头中读取单值字符串。
 *
 * @param request Node HTTP 请求对象。
 * @param headerName 头字段名。
 * @returns 归一化后的字符串值；缺失时返回 `null`。
 */
export function readHeaderValue(
  request: import("node:http").IncomingMessage,
  headerName: string,
): string | null {
  const raw = request.headers[headerName];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }

  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0]?.trim();
    return first?.length ? first : null;
  }

  return null;
}
