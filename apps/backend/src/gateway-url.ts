/**
 * 本文件收敛网关上游 URL 拼接规则。
 * 官方和第三方 base_url 经常带 `/v1` 或更深路径，必须用相对路径拼接，不能让 `new URL()`
 * 把已有 path 前缀吞掉。
 */

/**
 * 规范化拼接基础 URL 与路径。
 *
 * @param baseUrl 基础 URL。
 * @param pathname 目标路径。
 * @returns 拼接后的完整 URL。
 */
export function joinUrl(baseUrl: string, pathname: string): string {
  const normalizedPath = pathname.replace(/^\/+/, "");
  return new URL(normalizedPath, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}
