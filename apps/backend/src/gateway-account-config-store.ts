import path from "node:path";
import { readFile } from "node:fs/promises";

import { GATEWAY_ACCOUNTS_FILE, GATEWAY_OFFICIAL_SESSION_DIR } from "./config.ts";
import type {
  GatewayAccountDefinition,
  GatewayAccountsFile,
  OfficialGatewayAccountDefinition,
  ThirdPartyGatewayAccountDefinition,
} from "./gateway-account-store.ts";
import { HttpError } from "./http-error.ts";
import type { PersistedOfficialSessionSnapshot } from "./codex-session-provider.ts";
import { readJsonFile, writeJsonFile } from "./utils.ts";

/**
 * 本文件负责账号配置文件的增量读写。
 * 运行时账号解析与远端校验会放在别的模块里，避免把“配置存储”和“业务验证”混在一起。
 */

/**
 * 读取账号配置文件；若文件不存在则返回带默认值的空结构。
 *
 * @returns 当前配置文件内容。
 */
export async function loadGatewayAccountsConfig(): Promise<GatewayAccountsFile> {
  return (
    (await readJsonFile<GatewayAccountsFile>(GATEWAY_ACCOUNTS_FILE)) ?? {
      includeCurrentCodexSession: true,
      accounts: [],
    }
  );
}

/**
 * 获取当前所有已配置账号定义。
 *
 * @returns 账号定义数组。
 */
export async function listGatewayAccountDefinitions(): Promise<
  GatewayAccountDefinition[]
> {
  const config = await loadGatewayAccountsConfig();
  return [...(config.accounts ?? [])];
}

/**
 * 追加一个新的账号定义到 `accounts.json`。
 *
 * @param definition 待保存的账号定义。
 * @returns 无返回值。
 * @throws 当账号 ID 已存在时抛出 409。
 */
export async function appendGatewayAccountDefinition(
  definition: GatewayAccountDefinition,
): Promise<void> {
  const config = await loadGatewayAccountsConfig();
  const nextAccounts = [...(config.accounts ?? [])];

  if (nextAccounts.some((account) => account.id === definition.id)) {
    throw new HttpError(409, `账号 ID 已存在：${definition.id}`);
  }

  nextAccounts.push(definition);

  await writeJsonFile(GATEWAY_ACCOUNTS_FILE, {
    includeCurrentCodexSession: config.includeCurrentCodexSession ?? true,
    accounts: nextAccounts,
  } satisfies GatewayAccountsFile);
}

/**
 * 通过账号 ID 读取一条静态定义。
 *
 * @param accountId 账号 ID。
 * @returns 命中的账号定义；不存在时返回 `null`。
 */
export async function getGatewayAccountDefinitionById(
  accountId: string,
): Promise<GatewayAccountDefinition | null> {
  const definitions = await listGatewayAccountDefinitions();
  return definitions.find((account) => account.id === accountId) ?? null;
}

/**
 * 更新一条已有账号定义。
 *
 * @param accountId 目标账号 ID。
 * @param nextDefinition 替换后的账号定义。
 * @returns 无返回值。
 * @throws 当目标账号不存在时抛出 404。
 */
export async function updateGatewayAccountDefinition(
  accountId: string,
  nextDefinition:
    | OfficialGatewayAccountDefinition
    | ThirdPartyGatewayAccountDefinition,
): Promise<void> {
  const config = await loadGatewayAccountsConfig();
  const nextAccounts = [...(config.accounts ?? [])];
  const targetIndex = nextAccounts.findIndex((account) => account.id === accountId);

  if (targetIndex < 0) {
    throw new HttpError(404, `未找到可编辑账号：${accountId}`);
  }

  nextAccounts[targetIndex] = nextDefinition;
  await writeJsonFile(GATEWAY_ACCOUNTS_FILE, {
    includeCurrentCodexSession: config.includeCurrentCodexSession ?? true,
    accounts: nextAccounts,
  } satisfies GatewayAccountsFile);
}

/**
 * 读取某个官方账号保存过的会话快照原文。
 *
 * @param filePath 快照文件路径。
 * @returns 原始 JSON 文本。
 */
export async function readOfficialSessionSnapshotText(
  filePath: string,
): Promise<string> {
  return readFile(filePath, "utf8");
}

/**
 * 保存官方网页登录态的精简快照，并返回可写入账号定义的文件路径。
 *
 * @param accountId 账号 ID，用于生成快照文件名。
 * @param snapshot 需要持久化的会话快照。
 * @returns 快照文件的绝对路径。
 */
export async function saveOfficialSessionSnapshot(
  accountId: string,
  snapshot: PersistedOfficialSessionSnapshot,
): Promise<string> {
  const snapshotFile = path.join(GATEWAY_OFFICIAL_SESSION_DIR, `${accountId}.json`);

  await writeJsonFile(snapshotFile, snapshot);
  return snapshotFile;
}
