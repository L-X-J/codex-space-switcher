import { unlink } from "node:fs/promises";

import type {
  CreateAccountRequestBody,
  CreateAccountResponse,
} from "../../../packages/shared/src/index.ts";
import {
  buildPersistedOfficialSessionSnapshot,
  parseCodexSessionPayload,
} from "./codex-session-provider.ts";
import {
  appendGatewayAccountDefinition,
  listGatewayAccountDefinitions,
  saveOfficialSessionSnapshot,
} from "./gateway-account-config-store.ts";
import {
  resolveThirdPartyApiProtocol,
  type OfficialGatewayAccount,
} from "./gateway-account-store.ts";
import { OFFICIAL_CODEX_BASE_URL } from "./config.ts";
import { HttpError } from "./http-error.ts";
import { loadOfficialUsageSnapshot } from "./official-account-usage-provider.ts";
import { validateThirdPartyAccount } from "./third-party-account-validation.ts";
import { normalizeThirdPartyBillingRule } from "./third-party-billing-rules.ts";

/**
 * 本文件负责“新增账号”流程。
 * 它会先做格式校验与远端连通性测试，再把最终账号定义写入配置文件。
 */

/**
 * 按账号类型创建并保存一个新账号。
 *
 * @param input 前端提交的新增账号请求。
 * @returns 保存结果摘要。
 */
export async function createGatewayAccount(
  input: CreateAccountRequestBody,
): Promise<CreateAccountResponse> {
  if (input.kind !== "official" && input.kind !== "third_party") {
    throw new HttpError(400, "账号类型不支持。");
  }

  if (input.kind === "official") {
    return createOfficialGatewayAccount(input);
  }

  return createThirdPartyGatewayAccount(input);
}

/**
 * 创建一个官方账号定义。
 *
 * @param input 官方账号表单请求。
 * @returns 保存结果摘要。
 */
async function createOfficialGatewayAccount(
  input: Extract<CreateAccountRequestBody, { kind: "official" }>,
): Promise<CreateAccountResponse> {
  const sessionJson =
    typeof input.sessionJson === "string" ? input.sessionJson : "";
  const sessionPayload = parseJsonText(sessionJson, "官方账号登录态");
  const snapshot = buildPersistedOfficialSessionSnapshot(sessionPayload);
  const session = parseCodexSessionPayload(snapshot);

  if (!session.accountId) {
    throw new HttpError(
      400,
      "官方账号缺少 account.id，当前无法作为本地代理路由账号保存。",
    );
  }

  await validateOfficialSession(session);

  const definitions = await listGatewayAccountDefinitions();
  const displayName =
    (typeof input.name === "string" ? input.name.trim() : "") ||
    session.userName ||
    session.email ||
    session.accountId;
  const accountId = buildUniqueAccountId(
    "official",
    definitions.map((definition) => definition.id),
    displayName,
    session.accountId,
  );

  const snapshotFile = await saveOfficialSessionSnapshot(accountId, snapshot);

  try {
    await appendGatewayAccountDefinition({
      id: accountId,
      name: displayName,
      kind: "official",
      authFile: snapshotFile,
    });
  } catch (error) {
    await safeDelete(snapshotFile);
    throw error;
  }

  const expiryHint = session.expiresAt ? `，有效期到 ${session.expiresAt}` : "";
  return {
    accountId,
    accountName: displayName,
    kind: "official",
    message:
      `已保存官方账号，当前 accessToken 可直接用于路由与额度查询${expiryHint}。` +
      "由于 /api/auth/session 不提供 refresh_token，过期后需要重新粘贴一次。",
  };
}

/**
 * 创建一个第三方账号定义。
 *
 * @param input 第三方账号表单请求。
 * @returns 保存结果摘要。
 */
async function createThirdPartyGatewayAccount(
  input: Extract<CreateAccountRequestBody, { kind: "third_party" }>,
): Promise<CreateAccountResponse> {
  const accountName = typeof input.name === "string" ? input.name.trim() : "";
  if (!accountName) {
    throw new HttpError(400, "第三方账号名称不能为空。");
  }

  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!apiKey) {
    throw new HttpError(400, "第三方账号 API Key 不能为空。");
  }

  const apiBaseUrl = normalizeBaseUrl(
    typeof input.apiBaseUrl === "string" ? input.apiBaseUrl : "",
  );
  const billingRule = normalizeThirdPartyBillingRule(input.billingRule);
  const apiProtocol = resolveThirdPartyApiProtocol(input.apiProtocol);
  await validateThirdPartyAccount({
    apiBaseUrl,
    apiKey,
    skipConnectivityCheck: input.skipConnectivityCheck === true,
  });

  const definitions = await listGatewayAccountDefinitions();
  const accountId = buildUniqueAccountId(
    "third-party",
    definitions.map((definition) => definition.id),
    accountName,
  );

  await appendGatewayAccountDefinition({
    id: accountId,
    name: accountName,
    kind: "third_party",
    apiBaseUrl,
    apiKey,
    apiProtocol,
    defaultModel:
      typeof input.defaultModel === "string"
        ? input.defaultModel.trim() || undefined
        : undefined,
    requiresResponsesWebSocket:
      apiProtocol === "responses" && input.requiresResponsesWebSocket === true,
    billingRule,
  });

  return {
    accountId,
    accountName,
    kind: "third_party",
    message:
      input.skipConnectivityCheck === true
        ? "第三方账号已保存，并跳过了本次 /models 连通性测试。"
        : "第三方账号测试通过，已保存到本地路由配置。",
  };
}

/**
 * 用现有官方额度接口验证网页 access token 是否可用。
 *
 * @param session 已归一化的官方会话。
 * @returns 无返回值。
 */
async function validateOfficialSession(
  session: ReturnType<typeof parseCodexSessionPayload>,
): Promise<void> {
  const runtimeAccount: OfficialGatewayAccount = {
    id: "official-validation",
    name: session.userName || session.email || session.accountId || "official",
    kind: "official",
    isConfigured: true,
    isActive: false,
    rawDiagnostics: [],
    session,
    authFile: "(pasted-session)",
    baseUrl: OFFICIAL_CODEX_BASE_URL,
  };

  try {
    await loadOfficialUsageSnapshot(runtimeAccount);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(
      400,
      `官方账号校验失败：${message}。请确认你粘贴的是 https://chatgpt.com/api/auth/session 的完整返回结果，并且登录态尚未过期。`,
    );
  }
}

/**
 * 解析表单里的一段 JSON 文本。
 *
 * @param rawText 原始文本。
 * @param fieldLabel 字段展示名。
 * @returns 解析后的 JSON 值。
 */
function parseJsonText(rawText: string, fieldLabel: string): unknown {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new HttpError(400, `${fieldLabel}不能为空。`);
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    throw new HttpError(400, `${fieldLabel}不是有效 JSON。`);
  }
}

/**
 * 标准化第三方接口地址，并在格式非法时给出明确错误。
 *
 * @param value 用户填写的 URL。
 * @returns 标准化后的基础地址。
 */
function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new HttpError(400, "第三方账号 URL 不能为空。");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new HttpError(400, "第三方账号 URL 格式不正确。");
  }

  if (!/^https?:$/.test(url.protocol)) {
    throw new HttpError(400, "第三方账号 URL 只支持 http 或 https。");
  }

  return url.toString().replace(/\/+$/, "");
}

/**
 * 生成一个不与现有账号冲突的本地账号 ID。
 *
 * @param prefix ID 前缀。
 * @param existingIds 已存在的账号 ID。
 * @param preferredName 优先使用的名称。
 * @param stableHint 可选的稳定提示，例如官方 account_id。
 * @returns 唯一账号 ID。
 */
function buildUniqueAccountId(
  prefix: string,
  existingIds: string[],
  preferredName: string,
  stableHint?: string,
): string {
  const existing = new Set(existingIds);
  const base =
    slugify(stableHint || preferredName) || `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

  const preferredId = base.startsWith(`${prefix}-`) ? base : `${prefix}-${base}`;
  if (!existing.has(preferredId)) {
    return preferredId;
  }

  let counter = 2;
  while (existing.has(`${preferredId}-${counter}`)) {
    counter += 1;
  }

  return `${preferredId}-${counter}`;
}

/**
 * 将任意名称压缩成适合文件名与配置 ID 的安全片段。
 *
 * @param value 原始名称。
 * @returns 简短 slug；若无法得到 ASCII 片段则返回空字符串。
 */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 尝试清理已写入的快照文件，避免配置写入失败后残留孤儿文件。
 *
 * @param filePath 待删除文件路径。
 * @returns 无返回值。
 */
async function safeDelete(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // 清理失败不应覆盖掉真正的业务错误。
  }
}
