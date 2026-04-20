import type { AccountKind } from "../../../packages/shared/src/index.ts";
import type { CodexSession } from "./codex-session-provider.ts";
import { loadCodexSessionFromFile } from "./codex-session-provider.ts";
import {
  AUTH_FILE,
  DEFAULT_THIRD_PARTY_BASE_URL,
  GATEWAY_ACCOUNTS_FILE,
  OFFICIAL_CODEX_BASE_URL,
} from "./config.ts";
import { formatError, readJsonFile } from "./utils.ts";

export interface GatewayAccountsFile {
  includeCurrentCodexSession?: boolean;
  accounts?: GatewayAccountDefinition[];
}

interface GatewayAccountDefinitionBase {
  id: string;
  name?: string;
  kind: AccountKind;
  enabled?: boolean;
}

export interface OfficialGatewayAccountDefinition extends GatewayAccountDefinitionBase {
  kind: "official";
  authFile?: string;
  baseUrl?: string;
}

export interface ThirdPartyGatewayAccountDefinition extends GatewayAccountDefinitionBase {
  kind: "third_party";
  apiBaseUrl?: string;
  apiKey?: string;
  apiKeyEnvName?: string;
  defaultModel?: string;
  requiresResponsesWebSocket?: boolean;
}

export type GatewayAccountDefinition =
  | OfficialGatewayAccountDefinition
  | ThirdPartyGatewayAccountDefinition;

interface GatewayAccountRuntimeBase {
  id: string;
  name: string;
  kind: AccountKind;
  isConfigured: boolean;
  isActive: boolean;
  rawDiagnostics: string[];
}

/**
 * 描述一个已经解析完本地凭据的官方账号。
 */
export interface OfficialGatewayAccount extends GatewayAccountRuntimeBase {
  kind: "official";
  session: CodexSession | null;
  authFile: string;
  baseUrl: string;
}

/**
 * 描述一个已经解析完 API Key 的第三方账号。
 */
export interface ThirdPartyGatewayAccount extends GatewayAccountRuntimeBase {
  kind: "third_party";
  apiKey: string | null;
  baseUrl: string;
  defaultModel: string | null;
  requiresResponsesWebSocket: boolean;
}

/**
 * 统一描述前端看板和本地代理都会用到的账号运行时信息。
 */
export type GatewayRuntimeAccount =
  | OfficialGatewayAccount
  | ThirdPartyGatewayAccount;

/**
 * 读取本地账号配置，并把其解析成可直接用于代理与看板的运行时账号列表。
 *
 * @param preferredActiveAccountId 用户上次选择的激活账号 ID。
 * @returns 按展示顺序排列的账号数组。
 */
export async function loadGatewayAccounts(
  preferredActiveAccountId: string | null,
): Promise<GatewayRuntimeAccount[]> {
  const file = await readJsonFile<GatewayAccountsFile>(GATEWAY_ACCOUNTS_FILE);
  const definitions = buildDefinitions(file);
  const accounts: GatewayRuntimeAccount[] = [];

  for (const definition of definitions) {
    accounts.push(await resolveAccountDefinition(definition));
  }

  const activeAccountId = pickActiveGatewayAccountId(
    accounts,
    preferredActiveAccountId,
  );

  return accounts.map((account) => ({
    ...account,
    isActive: account.id === activeAccountId,
  }));
}

/**
 * 在一组账号里挑出最合理的激活账号。
 *
 * @param accounts 账号列表。
 * @param preferredActiveAccountId 用户上次持久化的目标 ID。
 * @returns 可用账号 ID；当完全没有可用账号时返回 `null`。
 */
export function pickActiveGatewayAccountId(
  accounts: GatewayRuntimeAccount[],
  preferredActiveAccountId: string | null,
): string | null {
  const preferred = accounts.find(
    (account) =>
      account.id === preferredActiveAccountId && account.isConfigured,
  );
  if (preferred) {
    return preferred.id;
  }

  const firstConfigured = accounts.find((account) => account.isConfigured);
  return firstConfigured?.id ?? accounts[0]?.id ?? null;
}

/**
 * 构造最终需要加载的账号定义列表。
 *
 * @param file 账号配置文件内容。
 * @returns 去重后的定义数组。
 */
function buildDefinitions(file: GatewayAccountsFile | null): GatewayAccountDefinition[] {
  const definitions: GatewayAccountDefinition[] = [];
  const includeCurrentCodexSession = file?.includeCurrentCodexSession ?? true;

  if (includeCurrentCodexSession) {
    definitions.push({
      id: "current-official",
      kind: "official",
      authFile: AUTH_FILE,
    });
  }

  for (const rawDefinition of file?.accounts ?? []) {
    if (rawDefinition.enabled === false) {
      continue;
    }

    if (!rawDefinition.id || !rawDefinition.kind) {
      continue;
    }

    definitions.push(rawDefinition);
  }

  const deduped = new Map<string, GatewayAccountDefinition>();
  for (const definition of definitions) {
    deduped.set(definition.id, definition);
  }

  return [...deduped.values()];
}

/**
 * 把静态定义解析成带有真实凭据状态的运行时账号。
 *
 * @param definition 账号定义。
 * @returns 运行时账号对象。
 */
async function resolveAccountDefinition(
  definition: GatewayAccountDefinition,
): Promise<GatewayRuntimeAccount> {
  if (definition.kind === "official") {
    return resolveOfficialAccount(definition);
  }

  return resolveThirdPartyAccount(definition);
}

/**
 * 解析官方账号定义，并读取其对应的 `auth.json` 快照。
 *
 * @param definition 官方账号定义。
 * @returns 带有会话解析结果的运行时账号。
 */
async function resolveOfficialAccount(
  definition: OfficialGatewayAccountDefinition,
): Promise<OfficialGatewayAccount> {
  const authFile = definition.authFile ?? AUTH_FILE;
  const diagnostics: string[] = [];

  try {
    const session = await loadCodexSessionFromFile(authFile);
    if (session.expiresAt) {
      diagnostics.push(`登录态有效期至 ${session.expiresAt}。`);
    }
    const displayName =
      definition.name?.trim() ||
      session.userName ||
      session.email ||
      session.accountId ||
      definition.id;

    return {
      id: definition.id,
      name: displayName,
      kind: "official",
      isConfigured: true,
      isActive: false,
      rawDiagnostics: diagnostics,
      session,
      authFile,
      baseUrl: definition.baseUrl ?? OFFICIAL_CODEX_BASE_URL,
    };
  } catch (error) {
    diagnostics.push(`官方登录态不可用：${formatError(error)}`);
    return {
      id: definition.id,
      name: definition.name?.trim() || definition.id,
      kind: "official",
      isConfigured: false,
      isActive: false,
      rawDiagnostics: diagnostics,
      session: null,
      authFile,
      baseUrl: definition.baseUrl ?? OFFICIAL_CODEX_BASE_URL,
    };
  }
}

/**
 * 解析第三方账号定义，并优先从环境变量读取 API Key。
 *
 * @param definition 第三方账号定义。
 * @returns 带有 API Key 状态的运行时账号。
 */
function resolveThirdPartyAccount(
  definition: ThirdPartyGatewayAccountDefinition,
): ThirdPartyGatewayAccount {
  const diagnostics: string[] = [];
  const apiKey =
    definition.apiKeyEnvName && process.env[definition.apiKeyEnvName]
      ? process.env[definition.apiKeyEnvName] ?? null
      : definition.apiKey ?? null;

  if (!apiKey) {
    diagnostics.push(
      definition.apiKeyEnvName
        ? `未找到环境变量 ${definition.apiKeyEnvName}。`
        : "第三方账号缺少 API Key。",
    );
  }

  return {
    id: definition.id,
    name: definition.name?.trim() || definition.id,
    kind: "third_party",
    isConfigured: Boolean(apiKey),
    isActive: false,
    rawDiagnostics: diagnostics,
    apiKey,
    baseUrl: definition.apiBaseUrl ?? DEFAULT_THIRD_PARTY_BASE_URL,
    defaultModel: definition.defaultModel?.trim() || null,
    requiresResponsesWebSocket: definition.requiresResponsesWebSocket === true,
  };
}
