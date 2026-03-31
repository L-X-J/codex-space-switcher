/**
 * 本文件提供极简日志封装。
 * 首版只依赖标准输出，避免引入额外日志库，便于本机脚本直接查看问题。
 */

/**
 * 打印带时间戳的日志。
 *
 * @param level 日志级别。
 * @param message 日志正文。
 * @param detail 可选附加信息，会被序列化到同一行输出。
 * @returns 无返回值。
 */
export function log(
  level: "info" | "warn" | "error",
  message: string,
  detail?: unknown,
): void {
  const stamp = new Date().toISOString();
  const suffix =
    detail === undefined
      ? ""
      : ` ${safeSerialize(detail)}`;

  console[level](`[${stamp}] [${level}] ${message}${suffix}`);
}

/**
 * 安全序列化日志附加信息。
 *
 * @param detail 任意对象。
 * @returns 尽量不抛错的文本表示。
 */
function safeSerialize(detail: unknown): string {
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}
