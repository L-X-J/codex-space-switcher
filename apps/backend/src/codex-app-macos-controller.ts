import type { CommandRunner } from "./codex-app-controller-types.ts";
import { hasCodexProcessLine } from "./codex-app-process-utils.ts";

const CODEX_MACOS_APP_PATH = "/Applications/Codex.app";

/**
 * 本文件实现 macOS 下的 Codex App 控制。
 * macOS 有 AppleScript 能力，因此运行态探测先走应用级判断，再用 pgrep 做兜底。
 */

/**
 * 使用 AppleScript 与 pgrep 组合探测 macOS Codex 运行态。
 *
 * @param commandRunner 命令执行器。
 * @returns 检测到 Codex 时返回 `true`。
 */
export async function isDarwinCodexRunning(
  commandRunner: CommandRunner,
): Promise<boolean> {
  try {
    const { stdout } = await commandRunner("osascript", [
      "-e",
      'application "Codex" is running',
    ]);
    if (stdout.trim() === "true") {
      return true;
    }
  } catch {
    // AppleScript 不可用时继续走 pgrep，避免运行态面板直接退化成 unknown。
  }

  for (const pattern of [
    "/Applications/Codex.app/Contents/MacOS/Codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "Codex.app",
  ]) {
    try {
      const { stdout } = await commandRunner("pgrep", ["-af", pattern]);
      if (hasCodexProcessLine(stdout)) {
        return true;
      }
    } catch {
      // pgrep 无命中时通常以非 0 退出；这里继续尝试下一个模式即可。
    }
  }

  return false;
}

/**
 * 请求 macOS 上正在运行的 Codex 正常退出。
 *
 * @param commandRunner 命令执行器。
 * @returns 无返回值。
 */
export async function stopDarwinCodexApp(
  commandRunner: CommandRunner,
): Promise<void> {
  await commandRunner("osascript", [
    "-e",
    'tell application "Codex" to quit',
  ]);
}

/**
 * 使用 macOS open 命令拉起 Codex.app。
 *
 * @param commandRunner 命令执行器。
 * @returns 无返回值。
 */
export async function startDarwinCodexApp(
  commandRunner: CommandRunner,
): Promise<void> {
  await commandRunner("open", ["-a", CODEX_MACOS_APP_PATH]);
}
