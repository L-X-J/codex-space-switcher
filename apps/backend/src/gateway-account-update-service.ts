import type {
  EditableAccountDetail,
  UpdateAccountRequestBody,
  UpdateAccountResponse,
} from "../../../packages/shared/src/index.ts";
import {
  buildPersistedOfficialSessionSnapshot,
  type PersistedOfficialSessionSnapshot,
  parseCodexSessionPayload,
} from "./codex-session-provider.ts";
import {
  getGatewayAccountDefinitionById,
  readOfficialSessionSnapshotText,
  saveOfficialSessionSnapshot,
  updateGatewayAccountDefinition,
} from "./gateway-account-config-store.ts";
import type {
  OfficialGatewayAccount,
  OfficialGatewayAccountDefinition,
  ThirdPartyGatewayAccountDefinition,
} from "./gateway-account-store.ts";
import { AUTH_FILE, OFFICIAL_CODEX_BASE_URL } from "./config.ts";
import { HttpError } from "./http-error.ts";
import { loadOfficialUsageSnapshot } from "./official-account-usage-provider.ts";
import { validateThirdPartyAccount } from "./third-party-account-validation.ts";
import { normalizeThirdPartyBillingRule } from "./third-party-billing-rules.ts";

/**
 * 本文件负责账号编辑流程。
 * 它会先读取可编辑详情，再在保存前执行和新增账号一致的校验逻辑，避免把无效配置写回本地。
 */

/**
 * 读取某个账号用于编辑的表单详情。
 *
 * @param accountId 目标账号 ID。
 * @returns 可直接回填到前端表单的对象。
 */
export async function getEditableAccountDetail(
  accountId: string,
): Promise<EditableAccountDetail> {
  const definition = await getGatewayAccountDefinitionById(accountId);
  if (!definition) {
    throw new HttpError(404, "未找到可编辑账号。");
  }

  if (definition.kind === "official") {
    return buildEditableOfficialAccount(definition);
  }

  return {
    id: definition.id,
    kind: "third_party",
    name: definition.name?.trim() || definition.id,
    apiKey: definition.apiKey ?? "",
    apiBaseUrl: definition.apiBaseUrl ?? "",
    defaultModel: definition.defaultModel ?? "",
    requiresResponsesWebSocket:
      definition.requiresResponsesWebSocket === true,
    billingRule: definition.billingRule ?? null,
  };
}

/**
 * 更新某个账号定义。
 *
 * @param accountId 目标账号 ID。
 * @param input 前端提交的编辑请求。
 * @returns 更新结果摘要。
 */
export async function updateGatewayAccount(
  accountId: string,
  input: UpdateAccountRequestBody,
): Promise<UpdateAccountResponse> {
  const definition = await getGatewayAccountDefinitionById(accountId);
  if (!definition) {
    throw new HttpError(404, "未找到可编辑账号。");
  }

  if (definition.kind !== input.kind) {
    throw new HttpError(400, "账号类型不匹配，无法更新。");
  }

  if (definition.kind === "official") {
    return updateOfficialGatewayAccount(definition, input);
  }

  return updateThirdPartyGatewayAccount(definition, input);
}

/**
 * 构造官方账号的编辑回填数据。
 *
 * @param definition 官方账号定义。
 * @returns 可用于前端回填的详情。
 */
async function buildEditableOfficialAccount(
  definition: OfficialGatewayAccountDefinition,
): Promise<EditableAccountDetail> {
  const authFile = definition.authFile;
  if (!authFile || authFile === AUTH_FILE) {
    throw new HttpError(400, "当前内置官方账号跟随 ~/.codex/auth.json，不支持在此编辑。");
  }

  return {
    id: definition.id,
    kind: "official",
    name: definition.name?.trim() || definition.id,
    sessionJson: await readOfficialSessionSnapshotText(authFile),
  };
}

/**
 * 更新一个官方账号定义。
 *
 * @param definition 原始定义。
 * @param input 编辑请求。
 * @returns 更新结果摘要。
 */
async function updateOfficialGatewayAccount(
  definition: OfficialGatewayAccountDefinition,
  input: Extract<UpdateAccountRequestBody, { kind: "official" }>,
): Promise<UpdateAccountResponse> {
  const authFile = definition.authFile;
  if (!authFile || authFile === AUTH_FILE) {
    throw new HttpError(400, "当前内置官方账号跟随 ~/.codex/auth.json，不支持在此编辑。");
  }

  const sessionPayload = parseJsonText(input.sessionJson, "官方账号登录态");
  const snapshot = normalizeOfficialSessionSnapshot(sessionPayload);
  const session = parseCodexSessionPayload(snapshot);

  if (!session.accountId) {
    throw new HttpError(
      400,
      "官方账号缺少 account.id，当前无法作为本地代理路由账号保存。",
    );
  }

  await validateOfficialSession(session);
  await saveOfficialSessionSnapshot(definition.id, snapshot);

  const displayName =
    (typeof input.name === "string" ? input.name.trim() : "") ||
    session.userName ||
    session.email ||
    session.accountId ||
    definition.id;

  await updateGatewayAccountDefinition(definition.id, {
    ...definition,
    name: displayName,
    authFile,
  });

  return {
    accountId: definition.id,
    accountName: displayName,
    kind: "official",
    message: "官方账号已更新。",
  };
}

/**
 * 更新一个第三方账号定义。
 *
 * @param definition 原始定义。
 * @param input 编辑请求。
 * @returns 更新结果摘要。
 */
async function updateThirdPartyGatewayAccount(
  definition: ThirdPartyGatewayAccountDefinition,
  input: Extract<UpdateAccountRequestBody, { kind: "third_party" }>,
): Promise<UpdateAccountResponse> {
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
  await validateThirdPartyAccount({
    apiBaseUrl,
    apiKey,
    skipConnectivityCheck: input.skipConnectivityCheck === true,
  });

  const nextDefinition: ThirdPartyGatewayAccountDefinition = {
    ...definition,
    name: accountName,
    apiBaseUrl,
    apiKey,
    defaultModel:
      typeof input.defaultModel === "string"
        ? input.defaultModel.trim() || undefined
        : undefined,
    requiresResponsesWebSocket: input.requiresResponsesWebSocket === true,
    billingRule,
  };
  await updateGatewayAccountDefinition(definition.id, nextDefinition);

  return {
    accountId: definition.id,
    accountName,
    kind: "third_party",
    message:
      input.skipConnectivityCheck === true
        ? "第三方账号已更新，并跳过了本次 /models 连通性测试。"
        : "第三方账号已更新。",
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
    authFile: "(edited-session)",
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
 * 规范化第三方 base URL，避免用户填成裸域名或多余斜杠。
 *
 * @param value 原始输入。
 * @returns 可直接用于代理的 base_url。
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
    throw new HttpError(400, "第三方账号 URL 不是合法的绝对地址。");
  }

  url.pathname = url.pathname.replace(/\/+$/, "") || "/v1";
  return url.toString().replace(/\/$/, "");
}

/**
 * 把表单里的 JSON 文本解析成对象。
 *
 * @param text 原始文本。
 * @param label 字段标签。
 * @returns 解析后的 JSON 对象。
 */
function parseJsonText(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, `${label} 不是合法 JSON。`);
  }
}

/**
 * 把“网页 /api/auth/session 返回体”或“项目保存过的精简快照”统一归一成可落盘快照。
 *
 * @param payload 原始 JSON 对象。
 * @returns 规范化后的官方会话快照。
 */
function normalizeOfficialSessionSnapshot(
  payload: unknown,
): PersistedOfficialSessionSnapshot {
  try {
    return buildPersistedOfficialSessionSnapshot(payload);
  } catch {
    const session = parseCodexSessionPayload(payload);
    return {
      source: "chatgpt_api_auth_session",
      capturedAt: new Date().toISOString(),
      accessToken: session.accessToken,
      accountId: session.accountId,
      email: session.email,
      userName: session.userName,
      expiresAt: session.expiresAt,
    };
  }
}
