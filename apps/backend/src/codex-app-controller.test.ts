import test from "node:test";
import assert from "node:assert/strict";
import { CODEX_APP_EXECUTABLE_ENV } from "./config.ts";
import {
  getCodexAppCapabilities,
  isCodexAppRunning,
  startCodexApp,
  stopCodexApp,
} from "./codex-app-controller.ts";

interface CommandCall {
  command: string;
  args: string[];
}

type CommandHandler = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

/**
 * 本文件验证平台适配层的命令选择。
 * 这里不执行真实系统命令，而是用 mock runner 锁住 macOS/Windows 分支，避免测试环境平台影响结果。
 */

/**
 * 创建一个会记录调用参数的命令执行器。
 *
 * @param handler 每次命令调用的模拟响应。
 * @returns mock runner 以及调用记录。
 */
function createRecordingRunner(handler: CommandHandler) {
  const calls: CommandCall[] = [];
  const runner = async (command: string, args: string[]) => {
    calls.push({ command, args });
    return handler(command, args);
  };

  return {
    calls,
    runner,
  };
}

test("macOS 启动仍使用 open 拉起 Codex.app", async () => {
  const { calls, runner } = createRecordingRunner(async () => ({
    stdout: "",
    stderr: "",
  }));

  await startCodexApp({
    platform: "darwin",
    commandRunner: runner,
  });

  assert.deepEqual(calls, [
    {
      command: "open",
      args: ["-a", "/Applications/Codex.app"],
    },
  ]);
});

test("macOS 运行态优先使用 AppleScript 探测", async () => {
  const { calls, runner } = createRecordingRunner(async (command) => {
    assert.equal(command, "osascript");
    return {
      stdout: "true\n",
      stderr: "",
    };
  });

  const running = await isCodexAppRunning({
    platform: "darwin",
    commandRunner: runner,
  });

  assert.equal(running, true);
  assert.equal(calls[0]?.command, "osascript");
});

test("Windows 运行态能识别 Codex.exe 进程", async () => {
  const { runner } = createRecordingRunner(async (command) => {
    assert.equal(command, "powershell.exe");
    return {
      stdout: "Codex\n",
      stderr: "",
    };
  });

  const running = await isCodexAppRunning({
    platform: "win32",
    commandRunner: runner,
  });

  assert.equal(running, true);
});

test("Windows 关闭时进程不存在不会调用 taskkill", async () => {
  const { calls, runner } = createRecordingRunner(async (command) => {
    if (command === "powershell.exe") {
      return {
        stdout: "",
        stderr: "",
      };
    }

    if (command === "tasklist.exe") {
      return {
        stdout: "INFO: No tasks are running which match the specified criteria.",
        stderr: "",
      };
    }

    throw new Error(`不应调用 ${command}`);
  });

  await stopCodexApp({
    platform: "win32",
    commandRunner: runner,
  });

  assert.equal(calls.some((call) => call.command === "taskkill.exe"), false);
});

test("Windows 关闭时会对运行中的 Codex.exe 调用 taskkill", async () => {
  const { calls, runner } = createRecordingRunner(async (command) => {
    if (command === "powershell.exe") {
      return {
        stdout: "Codex\n",
        stderr: "",
      };
    }

    if (command === "taskkill.exe") {
      return {
        stdout: "SUCCESS",
        stderr: "",
      };
    }

    throw new Error(`不应调用 ${command}`);
  });

  await stopCodexApp({
    platform: "win32",
    commandRunner: runner,
  });

  assert.deepEqual(calls.at(-1), {
    command: "taskkill.exe",
    args: ["/IM", "Codex.exe", "/T"],
  });
});

test("Windows 启动优先使用显式 Codex.exe 路径", async () => {
  const explicitPath = "C:\\Tools\\Codex\\Codex.exe";
  const { calls, runner } = createRecordingRunner(async () => ({
    stdout: "",
    stderr: "",
  }));

  await startCodexApp({
    platform: "win32",
    env: {
      [CODEX_APP_EXECUTABLE_ENV]: explicitPath,
    },
    commandRunner: runner,
  });

  assert.equal(calls[0]?.command, "powershell.exe");
  assert.match(calls[0]?.args.at(-1) ?? "", /Start-Process/);
  assert.match(calls[0]?.args.at(-1) ?? "", /C:\\Tools\\Codex\\Codex\.exe/);
});

test("Windows 启动会按常见安装目录解析 Codex.exe", async () => {
  const { calls, runner } = createRecordingRunner(async () => ({
    stdout: "",
    stderr: "",
  }));

  await startCodexApp({
    platform: "win32",
    env: {
      LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local",
    },
    commandRunner: runner,
    fileExists: async (filePath) =>
      filePath ===
      "C:\\Users\\demo\\AppData\\Local\\Programs\\Codex\\Codex.exe",
  });

  assert.match(
    calls[0]?.args.at(-1) ?? "",
    /C:\\Users\\demo\\AppData\\Local\\Programs\\Codex\\Codex\.exe/,
  );
});

test("未知平台会明确禁用自动重启能力", () => {
  const capability = getCodexAppCapabilities({
    platform: "freebsd",
  });

  assert.equal(capability.platform, "unknown");
  assert.equal(capability.canRestart, false);
  assert.match(capability.restartHint ?? "", /暂不支持自动重启/);
});
