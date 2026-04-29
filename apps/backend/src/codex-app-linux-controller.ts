import type { CommandRunner } from "./codex-app-controller-types.ts";
import { hasCodexProcessLine } from "./codex-app-process-utils.ts";

/**
 * 本文件实现 Linux 下的轻量 Codex 进程探测。
 * Linux 当前只作为可观测兜底，不承诺自动重启桌面应用能力。
 */

/**
 * 在 Linux 上只做轻量进程探测，不承诺自动重启能力。
 *
 * @param commandRunner 命令执行器。
 * @returns 检测到 Codex 相关进程时返回 `true`。
 */
export async function isLinuxCodexRunning(
  commandRunner: CommandRunner,
): Promise<boolean> {
  try {
    const { stdout } = await commandRunner("pgrep", ["-af", "codex"]);
    return hasCodexProcessLine(stdout);
  } catch {
    return false;
  }
}
