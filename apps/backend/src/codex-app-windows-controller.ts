import path from "node:path";
import { CODEX_APP_EXECUTABLE_ENV } from "./config.ts";
import type {
  CommandRunner,
  FileExists,
} from "./codex-app-controller-types.ts";

const CODEX_WINDOWS_PROCESS_NAME = "Codex";
const CODEX_WINDOWS_IMAGE_NAME = "Codex.exe";

/**
 * 本文件实现 Windows 下的 Codex.exe 探测、关闭和启动。
 * Windows 用户安装路径差异较大，因此启动优先使用显式环境变量，其次尝试常见安装目录。
 */

/**
 * 使用 Windows 内置命令探测 Codex.exe。
 *
 * @param commandRunner 命令执行器。
 * @returns 检测到 Codex.exe 时返回 `true`。
 */
export async function isWindowsCodexRunning(
  commandRunner: CommandRunner,
): Promise<boolean> {
  try {
    const { stdout } = await commandRunner("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `(Get-Process -Name ${CODEX_WINDOWS_PROCESS_NAME} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty ProcessName)`,
    ]);
    if (stdout.trim().toLowerCase() === CODEX_WINDOWS_PROCESS_NAME.toLowerCase()) {
      return true;
    }
  } catch {
    // PowerShell 受限时继续尝试 tasklist，保证普通 Windows 环境也能探测。
  }

  try {
    const { stdout } = await commandRunner("tasklist.exe", [
      "/FI",
      `IMAGENAME eq ${CODEX_WINDOWS_IMAGE_NAME}`,
    ]);
    return stdout.toLowerCase().includes(CODEX_WINDOWS_IMAGE_NAME.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 关闭 Windows 上的 Codex.exe。
 *
 * @param commandRunner 命令执行器。
 * @returns 无返回值。
 * @throws 当已检测到 Codex 正在运行但 taskkill 失败时抛出异常。
 */
export async function stopWindowsCodexApp(
  commandRunner: CommandRunner,
): Promise<void> {
  if (!(await isWindowsCodexRunning(commandRunner))) {
    return;
  }

  await commandRunner("taskkill.exe", [
    "/IM",
    CODEX_WINDOWS_IMAGE_NAME,
    "/T",
  ]);
}

/**
 * 启动 Windows 上的 Codex.exe。
 *
 * @param options 环境变量、命令执行器和文件存在性探测器。
 * @returns 无返回值。
 */
export async function startWindowsCodexApp(options: {
  env: NodeJS.ProcessEnv;
  commandRunner: CommandRunner;
  fileExists: FileExists;
}): Promise<void> {
  const explicitExecutable = readEnvValue(options.env, CODEX_APP_EXECUTABLE_ENV);
  const executable =
    explicitExecutable ??
    (await findWindowsCodexExecutable(options.env, options.fileExists)) ??
    CODEX_WINDOWS_IMAGE_NAME;

  await options.commandRunner("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Start-Process -FilePath ${quotePowerShellString(executable)}`,
  ]);
}

/**
 * 按常见安装位置查找 Windows Codex.exe。
 *
 * @param env 当前进程环境变量。
 * @param fileExists 文件存在性探测器。
 * @returns 找到时返回绝对路径，否则返回 `null`。
 */
async function findWindowsCodexExecutable(
  env: NodeJS.ProcessEnv,
  fileExists: FileExists,
): Promise<string | null> {
  const localAppData = readEnvValue(env, "LOCALAPPDATA");
  const appData = readEnvValue(env, "APPDATA");
  const programFiles = readEnvValue(env, "ProgramFiles");
  const programFilesX86 = readEnvValue(env, "ProgramFiles(x86)");
  const candidates = [
    localAppData
      ? path.win32.join(localAppData, "Programs", "Codex", CODEX_WINDOWS_IMAGE_NAME)
      : null,
    localAppData
      ? path.win32.join(localAppData, "Codex", CODEX_WINDOWS_IMAGE_NAME)
      : null,
    localAppData
      ? path.win32.join(localAppData, "Microsoft", "WindowsApps", CODEX_WINDOWS_IMAGE_NAME)
      : null,
    appData ? path.win32.join(appData, "Codex", CODEX_WINDOWS_IMAGE_NAME) : null,
    programFiles
      ? path.win32.join(programFiles, "Codex", CODEX_WINDOWS_IMAGE_NAME)
      : null,
    programFilesX86
      ? path.win32.join(programFilesX86, "Codex", CODEX_WINDOWS_IMAGE_NAME)
      : null,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
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
 * 为 PowerShell 单引号字符串做最小转义。
 *
 * @param value 原始字符串。
 * @returns 可拼入 PowerShell 命令的单引号字符串。
 */
function quotePowerShellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
