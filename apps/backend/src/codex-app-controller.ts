import { access } from "node:fs/promises";
import type { CodexRuntimePlatform } from "../../../packages/shared/src/index.ts";
import {
  CODEX_APP_EXECUTABLE_ENV,
  CODEX_APP_RESTART_COMMAND_ENV,
} from "./config.ts";
import type {
  CodexAppCapabilities,
  CodexAppControllerOptions,
  CommandRunner,
} from "./codex-app-controller-types.ts";
import {
  isDarwinCodexRunning,
  startDarwinCodexApp,
  stopDarwinCodexApp,
} from "./codex-app-macos-controller.ts";
import { isLinuxCodexRunning } from "./codex-app-linux-controller.ts";
import {
  isWindowsCodexRunning,
  startWindowsCodexApp,
  stopWindowsCodexApp,
} from "./codex-app-windows-controller.ts";
import { runCommand } from "./utils.ts";

/**
 * 本文件是 Codex App 平台控制层的公共入口。
 * 它只负责平台分发、能力描述和用户自定义重启命令；具体系统命令分别放在
 * macOS/Windows/Linux 子模块中，便于后续替换某个平台实现而不影响业务服务。
 */

/**
 * 归一化 Node.js 平台标识。
 *
 * @param rawPlatform Node.js `process.platform` 原始值。
 * @returns 前后端共享契约中允许展示的平台值。
 */
export function normalizeRuntimePlatform(
  rawPlatform = process.platform,
): CodexRuntimePlatform {
  if (
    rawPlatform === "darwin" ||
    rawPlatform === "win32" ||
    rawPlatform === "linux"
  ) {
    return rawPlatform;
  }

  return "unknown";
}

/**
 * 返回当前平台对自动重启 Codex 的支持能力。
 *
 * @param options 可选覆盖项，主要用于单元测试模拟不同平台。
 * @returns 平台名、是否支持自动重启，以及需要展示给用户的补充提示。
 */
export function getCodexAppCapabilities(
  options: CodexAppControllerOptions = {},
): CodexAppCapabilities {
  const platform = normalizeRuntimePlatform(options.platform);

  if (platform === "darwin") {
    return {
      platform,
      canRestart: true,
      restartHint: null,
    };
  }

  if (platform === "win32") {
    return {
      platform,
      canRestart: true,
      restartHint:
        `Windows 下如果无法自动拉起 Codex，请设置 ${CODEX_APP_EXECUTABLE_ENV} 指向 Codex.exe。`,
    };
  }

  return {
    platform,
    canRestart: false,
    restartHint: "当前平台暂不支持自动重启 Codex，请在配置写入后手动重启。",
  };
}

/**
 * 判断 Codex App / CLI 进程是否存在。
 *
 * @param options 可选覆盖项，主要用于测试注入命令执行器。
 * @returns 检测到 Codex 进程时返回 `true`。
 */
export async function isCodexAppRunning(
  options: CodexAppControllerOptions = {},
): Promise<boolean> {
  const platform = normalizeRuntimePlatform(options.platform);
  const commandRunner = options.commandRunner ?? runCommand;

  if (platform === "darwin") {
    return isDarwinCodexRunning(commandRunner);
  }

  if (platform === "win32") {
    return isWindowsCodexRunning(commandRunner);
  }

  if (platform === "linux") {
    return isLinuxCodexRunning(commandRunner);
  }

  return false;
}

/**
 * 请求关闭当前正在运行的 Codex。
 *
 * @param options 可选覆盖项，主要用于测试注入命令执行器。
 * @returns 无返回值。
 * @throws 当当前平台不支持自动关闭，或系统命令执行失败时抛出异常。
 */
export async function stopCodexApp(
  options: CodexAppControllerOptions = {},
): Promise<void> {
  const platform = normalizeRuntimePlatform(options.platform);
  const commandRunner = options.commandRunner ?? runCommand;

  if (platform === "darwin") {
    await stopDarwinCodexApp(commandRunner);
    return;
  }

  if (platform === "win32") {
    await stopWindowsCodexApp(commandRunner);
    return;
  }

  throw new Error(getUnsupportedRestartMessage(platform));
}

/**
 * 拉起 Codex App。
 *
 * @param options 可选覆盖项，主要用于测试注入命令执行器、环境变量和文件探测器。
 * @returns 无返回值。
 * @throws 当当前平台不支持自动启动，或系统命令执行失败时抛出异常。
 */
export async function startCodexApp(
  options: CodexAppControllerOptions = {},
): Promise<void> {
  const platform = normalizeRuntimePlatform(options.platform);
  const env = options.env ?? process.env;
  const commandRunner = options.commandRunner ?? runCommand;
  const restartCommand = readEnvValue(env, CODEX_APP_RESTART_COMMAND_ENV);

  if (restartCommand) {
    await runRestartCommandOverride(platform, restartCommand, commandRunner);
    return;
  }

  if (platform === "darwin") {
    await startDarwinCodexApp(commandRunner);
    return;
  }

  if (platform === "win32") {
    await startWindowsCodexApp({
      env,
      commandRunner,
      fileExists: options.fileExists ?? defaultFileExists,
    });
    return;
  }

  throw new Error(getUnsupportedRestartMessage(platform));
}

/**
 * 执行用户显式提供的重启命令。
 *
 * @param platform 当前平台。
 * @param restartCommand 环境变量中的完整命令文本。
 * @param commandRunner 命令执行器。
 * @returns 无返回值。
 */
async function runRestartCommandOverride(
  platform: CodexRuntimePlatform,
  restartCommand: string,
  commandRunner: CommandRunner,
): Promise<void> {
  if (platform === "win32") {
    await commandRunner("cmd.exe", ["/d", "/s", "/c", restartCommand]);
    return;
  }

  if (platform === "darwin" || platform === "linux") {
    await commandRunner("sh", ["-lc", restartCommand]);
    return;
  }

  throw new Error(getUnsupportedRestartMessage(platform));
}

/**
 * 读取非空环境变量。
 *
 * @param env 环境变量集合。
 * @param key 环境变量名。
 * @returns 去除首尾空白后的值；不存在时返回 `null`。
 */
function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * 默认文件存在性探测实现。
 *
 * @param filePath 需要检查的文件路径。
 * @returns 文件可访问时返回 `true`。
 */
async function defaultFileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 构造不支持自动重启时的稳定错误文案。
 *
 * @param platform 当前平台。
 * @returns 可直接展示给用户的错误信息。
 */
function getUnsupportedRestartMessage(platform: CodexRuntimePlatform): string {
  return `当前平台 ${platform} 暂不支持自动重启 Codex，请手动重启后再刷新控制台。`;
}
