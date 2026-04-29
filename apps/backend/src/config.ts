import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 本文件集中维护本地工具依赖的路径与默认配置。
 * 这样可以把运行期常量与业务逻辑解耦，便于后续迁移到别的机器。
 */

export const APP_NAME = "Codex Space Switcher";
export const HOST = process.env.CODEX_SPACE_SWITCHER_HOST ?? "127.0.0.1";
export const PORT = Number.parseInt(
  process.env.CODEX_SPACE_SWITCHER_PORT ?? "14318",
  10,
);
export const API_BASE_URL = "https://chatgpt.com";
export const DESKTOP_ORIGINATOR = "codex-desktop";
export const SWITCH_BUSY_WAIT_TIMEOUT_MS = 15_000;
export const OFFICIAL_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const DEFAULT_THIRD_PARTY_BASE_URL = "https://api.openai.com/v1";
export const GATEWAY_BASE_PATH = "/ai-router/api/v1";
export const GATEWAY_PROVIDER_BASE_PATH = "/ai-router/api";
export const MANAGED_CODEX_PROVIDER_NAME = "space_switcher";
export const CODEX_PROXY_RECENT_WINDOW_MINUTES = 10;
export const CODEX_APP_EXECUTABLE_ENV = "CODEX_SPACE_SWITCHER_CODEX_EXE";
export const CODEX_APP_RESTART_COMMAND_ENV =
  "CODEX_SPACE_SWITCHER_RESTART_COMMAND";

export const CODEX_HOME = path.join(os.homedir(), ".codex");
export const CODEX_CONFIG_FILE = path.join(CODEX_HOME, "config.toml");
export const DESKTOP_SUPPORT_HOME =
  process.platform === "win32"
    ? path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "Codex",
      )
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Codex")
      : path.join(CODEX_HOME, "desktop");
export const SWITCHER_HOME =
  process.env.CODEX_SPACE_SWITCHER_HOME ??
  path.resolve(process.cwd(), ".codex-space-switcher-state");
export const SWITCHER_STATE_FILE = path.join(SWITCHER_HOME, "state.json");
export const MANUAL_SPACES_FILE = path.join(
  SWITCHER_HOME,
  "manual-spaces.json",
);
export const GATEWAY_ACCOUNTS_FILE = path.join(
  SWITCHER_HOME,
  "accounts.json",
);
export const GATEWAY_OFFICIAL_SESSION_DIR = path.join(
  SWITCHER_HOME,
  "auth",
);
export const GATEWAY_STATE_FILE = path.join(
  SWITCHER_HOME,
  "gateway-state.json",
);
export const GATEWAY_USAGE_EVENTS_FILE = path.join(
  SWITCHER_HOME,
  "usage-events.jsonl",
);
export const CODEX_PROXY_CONTROL_STATE_FILE = path.join(
  SWITCHER_HOME,
  "codex-proxy-control.json",
);

export const AUTH_FILE = path.join(CODEX_HOME, "auth.json");
export const GLOBAL_STATE_FILE = path.join(CODEX_HOME, ".codex-global-state.json");
export const STATE_SQLITE_FILE = path.join(CODEX_HOME, "state_5.sqlite");
export const LOGS_SQLITE_FILE = path.join(CODEX_HOME, "logs_1.sqlite");
export const SESSION_HISTORY_ROOT = path.join(CODEX_HOME, "sessions");
export const SESSION_ARCHIVE_ROOT = path.join(CODEX_HOME, "archived_sessions");

const BACKEND_SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));

export const FRONTEND_ROOT = path.resolve(
  BACKEND_SOURCE_ROOT,
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
