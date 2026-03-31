import os from "node:os";
import path from "node:path";

/**
 * 本文件集中维护本地工具依赖的路径与默认配置。
 * 这样可以把运行期常量与业务逻辑解耦，便于后续迁移到别的机器。
 */

export const APP_NAME = "Codex Space Switcher";
export const HOST = "127.0.0.1";
export const PORT = 4318;
export const API_BASE_URL = "https://chatgpt.com";
export const DESKTOP_ORIGINATOR = "codex-desktop";

export const CODEX_HOME = path.join(os.homedir(), ".codex");
export const DESKTOP_SUPPORT_HOME = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Codex",
);
export const SWITCHER_HOME =
  process.env.CODEX_SPACE_SWITCHER_HOME ??
  path.resolve(process.cwd(), ".codex-space-switcher-state");
export const SWITCHER_STATE_FILE = path.join(SWITCHER_HOME, "state.json");
export const MANUAL_SPACES_FILE = path.join(
  SWITCHER_HOME,
  "manual-spaces.json",
);

export const AUTH_FILE = path.join(CODEX_HOME, "auth.json");
export const GLOBAL_STATE_FILE = path.join(CODEX_HOME, ".codex-global-state.json");
export const STATE_SQLITE_FILE = path.join(CODEX_HOME, "state_5.sqlite");
export const LOGS_SQLITE_FILE = path.join(CODEX_HOME, "logs_1.sqlite");
export const SESSION_HISTORY_ROOT = path.join(CODEX_HOME, "sessions");
export const SESSION_ARCHIVE_ROOT = path.join(CODEX_HOME, "archived_sessions");

export const FRONTEND_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../frontend",
);

export const SPACE_PROBE_CANDIDATES = [
  "/backend-api/accounts",
  "/backend-api/accounts/check",
  "/backend-api/accounts/check/v4-2023-04-27",
  "/backend-api/workspaces",
  "/backend-api/me",
  "/wham/accounts/check",
  "/wham/usage",
] as const;

export const SWITCH_CANDIDATES = [
  {
    method: "POST" as const,
    path: "/backend-api/accounts/switch",
    bodyKey: "account_id",
  },
  {
    method: "POST" as const,
    path: "/backend-api/workspaces/switch",
    bodyKey: "workspace_id",
  },
  {
    method: "PUT" as const,
    path: "/backend-api/accounts/default",
    bodyKey: "account_id",
  },
] as const;

export const RESTART_COMMAND = [
  "open",
  "-a",
  "/Applications/Codex.app",
];
