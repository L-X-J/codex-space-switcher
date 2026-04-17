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

export interface CodexSession {
  authMode: string;
  accessToken: string;
  refreshToken: string | null;
  accountId: string | null;
  email: string | null;
  userName: string | null;
  lastRefresh: string | null;
  sourceFile?: string;
}

/**
 * 本文件负责读取 Codex Desktop 的本地登录态。
 * 这是所有远程私有接口请求的入口，因此需要把异常信息做得足够明确。
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
  const auth = await readJsonFile<RawAuthFile>(authFile);

  if (!auth) {
    throw new Error(`未找到 Codex 登录态文件：${authFile}`);
  }

  const accessToken = auth.tokens?.access_token;
  if (!accessToken) {
    throw new Error("Codex 登录态中缺少 access_token，当前无法访问私有接口。");
  }

  const idTokenPayload = auth.tokens?.id_token
    ? decodeJwtPayload(auth.tokens.id_token)
    : null;
  const accessTokenPayload = decodeJwtPayload(accessToken);
  const authNamespace = accessTokenPayload?.["https://api.openai.com/auth"];
  const accountId =
    typeof authNamespace === "object" &&
    authNamespace !== null &&
    typeof authNamespace["chatgpt_account_id"] === "string"
      ? authNamespace["chatgpt_account_id"]
      : auth.tokens?.account_id ?? null;

  return {
    authMode: auth.auth_mode ?? "unknown",
    accessToken,
    refreshToken: auth.tokens?.refresh_token ?? null,
    accountId,
    email:
      typeof idTokenPayload?.email === "string" ? idTokenPayload.email : null,
    userName:
      typeof idTokenPayload?.name === "string" ? idTokenPayload.name : null,
    lastRefresh: auth.last_refresh ?? null,
    sourceFile: authFile,
  };
}
