import type { CodexRuntimeStatus } from "../../../packages/shared/src/index.ts";
import { LOGS_SQLITE_FILE, RESTART_COMMAND, STATE_SQLITE_FILE } from "./config.ts";
import { formatError, runCommand, runSql } from "./utils.ts";

/**
 * 本文件负责观察 Codex Desktop 的运行态。
 * 首版以本地数据库与进程探测为主，避免对桌面端做侵入式改造。
 */

/**
 * 读取当前 Codex Desktop 的运行状态。
 *
 * @returns 归一化后的运行态摘要。
 */
export async function inspectCodexRuntime(): Promise<CodexRuntimeStatus> {
  const lastObservedAt = new Date().toISOString();

  try {
    const running = await isCodexRunning();
    const busy = running ? await isCodexBusy() : false;

    return {
      state: running ? (busy ? "busy" : "running") : "stopped",
      isBusy: busy,
      lastObservedAt,
      detail: running
        ? busy
          ? "检测到 Codex Desktop 近期仍有活跃任务或事件。"
          : "Codex Desktop 正在运行，且当前看起来处于空闲状态。"
        : "未检测到 Codex Desktop 进程。",
    };
  } catch (error) {
    return {
      state: "unknown",
      isBusy: false,
      lastObservedAt,
      detail: `运行态探测失败：${formatError(error)}`,
    };
  }
}

/**
 * 判断 Codex Desktop 当前是否仍有活跃任务。
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
 * 判断 Codex Desktop 进程是否存在。
 *
 * @returns 当检测到进程时返回 `true`。
 */
export async function isCodexRunning(): Promise<boolean> {
  const probeErrors: string[] = [];

  try {
    const { stdout } = await runCommand("osascript", [
      "-e",
      'application "Codex" is running',
    ]);
    if (stdout.trim() === "true") {
      return true;
    }
  } catch (error) {
    probeErrors.push(`AppleScript: ${formatError(error)}`);
  }

  for (const pattern of [
    "/Applications/Codex.app/Contents/MacOS/Codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "Codex.app",
  ]) {
    try {
      const { stdout } = await runCommand("pgrep", ["-af", pattern]);
      const lines = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.includes("codex-space-switcher/apps/backend/src/server.ts"));

      if (lines.length > 0) {
        return true;
      }
    } catch (error) {
      probeErrors.push(`pgrep(${pattern}): ${formatError(error)}`);
    }
  }

  if (probeErrors.length > 0) {
    console.warn(`Codex 运行态探测未命中：${probeErrors.join(" | ")}`);
  }

  return false;
}

/**
 * 请求关闭正在运行的 Codex Desktop。
 *
 * @returns 无返回值。
 */
export async function stopCodexApp(): Promise<void> {
  await runCommand("osascript", [
    "-e",
    'tell application "Codex" to quit',
  ]);
}

/**
 * 拉起 Codex Desktop。
 *
 * @returns 无返回值。
 */
export async function startCodexApp(): Promise<void> {
  await runCommand(RESTART_COMMAND[0], RESTART_COMMAND.slice(1));
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
