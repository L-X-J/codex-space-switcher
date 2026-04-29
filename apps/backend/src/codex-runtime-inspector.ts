import type { CodexRuntimeStatus } from "../../../packages/shared/src/index.ts";
import { LOGS_SQLITE_FILE, STATE_SQLITE_FILE } from "./config.ts";
import {
  getCodexAppCapabilities,
  isCodexAppRunning,
  startCodexApp as startPlatformCodexApp,
  stopCodexApp as stopPlatformCodexApp,
} from "./codex-app-controller.ts";
import { formatError, runSql } from "./utils.ts";

/**
 * 本文件负责观察 Codex App / CLI 的运行态。
 * 它只组合“平台进程控制”和“本地日志忙碌判断”，具体平台命令由
 * `codex-app-controller.ts` 隔离，避免 Windows/macOS 分支污染业务流程。
 */

/**
 * 读取当前 Codex App / CLI 的运行状态。
 *
 * @returns 归一化后的运行态摘要。
 */
export async function inspectCodexRuntime(): Promise<CodexRuntimeStatus> {
  const lastObservedAt = new Date().toISOString();
  const capabilities = getCodexAppCapabilities();

  try {
    const running = await isCodexRunning();
    const busy = running ? await isCodexBusy() : false;

    return {
      state: running ? (busy ? "busy" : "running") : "stopped",
      isBusy: busy,
      platform: capabilities.platform,
      canRestart: capabilities.canRestart,
      restartHint: capabilities.restartHint,
      lastObservedAt,
      detail: running
        ? busy
          ? "检测到 Codex 近期仍有活跃任务或事件。"
          : "Codex 正在运行，且当前看起来处于空闲状态。"
        : "未检测到 Codex 进程。",
    };
  } catch (error) {
    return {
      state: "unknown",
      isBusy: false,
      platform: capabilities.platform,
      canRestart: capabilities.canRestart,
      restartHint: capabilities.restartHint,
      lastObservedAt,
      detail: `运行态探测失败：${formatError(error)}`,
    };
  }
}

/**
 * 判断 Codex 当前是否仍有活跃任务。
 *
 * @returns 当检测到近期活跃事件时返回 `true`。
 */
export async function isCodexBusy(): Promise<boolean> {
  const currentEpochSeconds = Math.floor(Date.now() / 1000);
  const sql = `
    SELECT target || '|' || substr(coalesce(feedback_log_body, ''), 1, 240)
    FROM logs
    WHERE ts >= ${currentEpochSeconds - 300}
      AND (
        feedback_log_body LIKE '%response.in_progress%'
        OR feedback_log_body LIKE '%session_task.turn%'
        OR feedback_log_body LIKE '%waitingOnApproval%'
        OR feedback_log_body LIKE '%waitingOnUserInput%'
        OR feedback_log_body LIKE '%task_complete%'
        OR target LIKE '%session_task.turn%'
      )
    ORDER BY ts DESC, ts_nanos DESC, id DESC
    LIMIT 40;
  `;
  let logsText = "";
  try {
    logsText = await runSql(LOGS_SQLITE_FILE, sql);
  } catch (error) {
    if (
      formatError(error).includes("no such table: logs") ||
      formatError(error).includes("unable to open database file")
    ) {
      return false;
    }
    console.warn(`Codex 忙碌探测降级为空闲：${formatError(error)}`);
    return false;
  }

  const lines = logsText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return false;
  }

  const joined = lines.join("\n");
  if (
    /task_complete/.test(joined) &&
    !/session_task\.turn|response\.in_progress|waitingOnApproval|waitingOnUserInput/.test(
      joined,
    )
  ) {
    return false;
  }

  return /session_task\.turn|response\.in_progress|waitingOnApproval|waitingOnUserInput/.test(
    joined,
  );
}

/**
 * 判断 Codex 进程是否存在。
 *
 * @returns 当检测到进程时返回 `true`。
 */
export async function isCodexRunning(): Promise<boolean> {
  return isCodexAppRunning();
}

/**
 * 请求关闭正在运行的 Codex。
 *
 * @returns 无返回值。
 */
export async function stopCodexApp(): Promise<void> {
  await stopPlatformCodexApp();
}

/**
 * 拉起 Codex。
 *
 * @returns 无返回值。
 */
export async function startCodexApp(): Promise<void> {
  await startPlatformCodexApp();
}

/**
 * 返回当前状态库的基本信息，便于在诊断里快速确认本地环境是否可读。
 *
 * @returns 表名列表文本。
 */
export async function inspectStateDatabase(): Promise<string> {
  try {
    return await runSql(STATE_SQLITE_FILE, ".tables");
  } catch (error) {
    return `state sqlite 不可读：${formatError(error)}`;
  }
}
