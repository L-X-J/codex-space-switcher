import { AUTH_FILE } from "./config.ts";
import { decodeJwtPayload, readJsonFile } from "./utils.ts";

interface RawAuthFile {
  auth_mode?: string;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

interface RawChatGptSessionPayload {
  accessToken?: string;
  expires?: string;
  user?: {
    email?: string;
    name?: string;
  };
  account?: {
    id?: string;
  };
}

/**
 * 描述从 `https://chatgpt.com/api/auth/session` 保存下来的精简快照。
 * 这里故意只保留本项目真正会用到的字段，避免把不必要的敏感内容长期落盘。
 */
export interface PersistedOfficialSessionSnapshot {
  source: "chatgpt_api_auth_session";
  capturedAt: string;
  accessToken: string;
  accountId: string | null;
  email: string | null;
  userName: string | null;
  expiresAt: string | null;
}

export interface CodexSession {
  authMode: string;
  accessToken: string;
  refreshToken: string | null;
  accountId: string | null;
  email: string | null;
  userName: string | null;
  lastRefresh: string | null;
  expiresAt: string | null;
  sourceFile?: string;
}

/**
 * 本文件负责读取 Codex 的本地登录态。
 * 这是所有远程私有接口请求的入口，因此需要把异常信息做得足够明确。
 * 当前同时兼容两类来源：
 * 1. `~/.codex/auth.json` 这类带 `tokens.access_token` 的桌面端登录态；
 * 2. `https://chatgpt.com/api/auth/session` 的网页会话快照。
 */

/**
 * 从 `~/.codex/auth.json` 读取当前可用会话。
 *
 * @returns 当前解析出的会话对象。
 * @throws 当文件缺失、字段缺失或 token 非法时抛出异常。
 */
export async function loadCodexSession(): Promise<CodexSession> {
  return loadCodexSessionFromFile(AUTH_FILE);
}

/**
 * 从任意 `auth.json` 快照读取当前可用会话。
 *
 * @param authFile 登录态文件绝对路径。
 * @returns 当前解析出的会话对象。
 * @throws 当文件缺失、字段缺失或 token 非法时抛出异常。
 */
export async function loadCodexSessionFromFile(
  authFile: string,
): Promise<CodexSession> {
  const payload = await readJsonFile<unknown>(authFile);

  if (!payload) {
    throw new Error(`未找到 Codex 登录态文件：${authFile}`);
  }

  return parseCodexSessionPayload(payload, authFile);
}

/**
 * 从未知 JSON 负载中解析出统一的会话结构。
 *
 * @param payload 原始 JSON 负载。
 * @param sourceFile 可选的来源文件路径，仅用于诊断展示。
 * @returns 标准化后的会话对象。
 * @throws 当负载不属于本项目支持的登录态格式时抛出异常。
 */
export function parseCodexSessionPayload(
  payload: unknown,
  sourceFile?: string,
): CodexSession {
  const authFileSession = parseAuthFileSession(payload, sourceFile);
  if (authFileSession) {
    return authFileSession;
  }

  const persistedSession = parsePersistedOfficialSessionSnapshot(
    payload,
    sourceFile,
  );
  if (persistedSession) {
    return persistedSession;
  }

  const webSession = parseChatGptSessionPayload(payload, sourceFile);
  if (webSession) {
    return webSession;
  }

  throw new Error("无法识别登录态文件格式，仅支持 auth.json 或 /api/auth/session 快照。");
}

/**
 * 把网页端 `/api/auth/session` 返回体压缩成适合本地持久化的最小快照。
 *
 * @param payload 原始返回体。
 * @param capturedAt 保存时间，默认使用当前时间。
 * @returns 精简后的会话快照。
 * @throws 当返回体缺少关键字段时抛出异常。
 */
export function buildPersistedOfficialSessionSnapshot(
  payload: unknown,
  capturedAt = new Date().toISOString(),
): PersistedOfficialSessionSnapshot {
  const session = parseChatGptSessionPayload(payload);

  if (!session) {
    throw new Error(
      "粘贴的内容不是有效的 ChatGPT /api/auth/session 返回结果。",
    );
  }

  return {
    source: "chatgpt_api_auth_session",
    capturedAt,
    accessToken: session.accessToken,
    accountId: session.accountId,
    email: session.email,
    userName: session.userName,
    expiresAt: session.expiresAt,
  };
}

/**
 * 解析桌面端 `auth.json`。
 *
 * @param payload 原始 JSON。
 * @param sourceFile 来源文件路径。
 * @returns 解析成功时返回标准化会话，否则返回 `null`。
 */
function parseAuthFileSession(
  payload: unknown,
  sourceFile?: string,
): CodexSession | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const auth = payload as RawAuthFile;
  const accessToken = auth.tokens?.access_token;
  if (!accessToken) {
    return null;
  }

  const idTokenPayload = auth.tokens?.id_token
    ? decodeJwtPayload(auth.tokens.id_token)
    : null;

  return {
    authMode: auth.auth_mode ?? "unknown",
    accessToken,
    refreshToken: auth.tokens?.refresh_token ?? null,
    accountId: resolveAccountId(accessToken, auth.tokens?.account_id ?? null),
    email:
      typeof idTokenPayload?.email === "string" ? idTokenPayload.email : null,
    userName:
      typeof idTokenPayload?.name === "string" ? idTokenPayload.name : null,
    lastRefresh: auth.last_refresh ?? null,
    expiresAt: readJwtExpiration(accessToken),
    sourceFile,
  };
}

/**
 * 解析项目保存过的精简会话快照。
 *
 * @param payload 原始 JSON。
 * @param sourceFile 来源文件路径。
 * @returns 解析成功时返回标准化会话，否则返回 `null`。
 */
function parsePersistedOfficialSessionSnapshot(
  payload: unknown,
  sourceFile?: string,
): CodexSession | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const snapshot = payload as Partial<PersistedOfficialSessionSnapshot>;
  if (
    snapshot.source !== "chatgpt_api_auth_session" ||
    typeof snapshot.accessToken !== "string" ||
    snapshot.accessToken.trim().length === 0
  ) {
    return null;
  }

  return {
    authMode: "chatgpt_api_auth_session",
    accessToken: snapshot.accessToken,
    refreshToken: null,
    accountId: resolveAccountId(snapshot.accessToken, snapshot.accountId ?? null),
    email: typeof snapshot.email === "string" ? snapshot.email : null,
    userName: typeof snapshot.userName === "string" ? snapshot.userName : null,
    lastRefresh: null,
    expiresAt:
      typeof snapshot.expiresAt === "string"
        ? snapshot.expiresAt
        : readJwtExpiration(snapshot.accessToken),
    sourceFile,
  };
}

/**
 * 解析网页端 `/api/auth/session` 返回体。
 *
 * @param payload 原始 JSON。
 * @param sourceFile 来源文件路径。
 * @returns 解析成功时返回标准化会话，否则返回 `null`。
 */
function parseChatGptSessionPayload(
  payload: unknown,
  sourceFile?: string,
): CodexSession | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const session = payload as RawChatGptSessionPayload;
  if (typeof session.accessToken !== "string" || session.accessToken.length === 0) {
    return null;
  }

  const accountIdCandidate =
    typeof session.account?.id === "string" ? session.account.id : null;

  return {
    authMode: "chatgpt_api_auth_session",
    accessToken: session.accessToken,
    refreshToken: null,
    accountId: resolveAccountId(session.accessToken, accountIdCandidate),
    email: typeof session.user?.email === "string" ? session.user.email : null,
    userName: typeof session.user?.name === "string" ? session.user.name : null,
    lastRefresh: null,
    expiresAt:
      typeof session.expires === "string"
        ? session.expires
        : readJwtExpiration(session.accessToken),
    sourceFile,
  };
}

/**
 * 优先从 JWT 命名空间里读取账号 ID，并在缺失时回退到外部字段。
 *
 * @param accessToken access token 原文。
 * @param fallback 外部补充的账号 ID。
 * @returns 统一账号 ID；若都缺失则返回 `null`。
 */
function resolveAccountId(
  accessToken: string,
  fallback: string | null,
): string | null {
  const accessTokenPayload = decodeJwtPayload(accessToken);
  const authNamespace = accessTokenPayload?.["https://api.openai.com/auth"];
  if (
    typeof authNamespace === "object" &&
    authNamespace !== null &&
    typeof authNamespace["chatgpt_account_id"] === "string"
  ) {
    return authNamespace["chatgpt_account_id"];
  }

  return typeof fallback === "string" && fallback.trim().length > 0
    ? fallback
    : null;
}

/**
 * 从 JWT 的 `exp` 字段推断 ISO 过期时间。
 *
 * @param accessToken access token 原文。
 * @returns ISO 时间字符串；无法读取时返回 `null`。
 */
function readJwtExpiration(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  if (typeof payload?.exp !== "number" || !Number.isFinite(payload.exp)) {
    return null;
  }

  return new Date(payload.exp * 1000).toISOString();
}
