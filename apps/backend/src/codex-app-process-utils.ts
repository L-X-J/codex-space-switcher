const SERVER_PROCESS_MARKERS = [
  "codex-space-switcher/apps/backend/src/server.ts",
  "codex-space-switcher\\apps\\backend\\src\\server.ts",
];

/**
 * 本文件收纳平台进程探测时共享的文本过滤逻辑。
 * macOS/Linux 的 pgrep 输出都需要排除当前控制台服务自身，避免把本项目进程误判成 Codex。
 */

/**
 * 判断命令输出里是否存在真正的 Codex 进程行。
 *
 * @param stdout 命令标准输出。
 * @returns 存在非本服务进程时返回 `true`。
 */
export function hasCodexProcessLine(stdout: string): boolean {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some(
      (line) =>
        !SERVER_PROCESS_MARKERS.some((marker) =>
          line.toLowerCase().includes(marker.toLowerCase()),
        ),
    );
}
