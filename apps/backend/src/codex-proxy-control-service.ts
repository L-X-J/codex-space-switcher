import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CodexProxyConfigStatus,
  CodexProxyStatus,
  ProxyClientSnapshot,
} from "../../../packages/shared/src/index.ts";
import {
  CODEX_CONFIG_FILE,
  CODEX_PROXY_RECENT_WINDOW_MINUTES,
  GATEWAY_PROVIDER_BASE_PATH,
  HOST,
  MANAGED_CODEX_PROVIDER_NAME,
  PORT,
} from "./config.ts";
import type { GatewayPersistedState } from "./gateway-state-store.ts";
import {
  loadCodexProxyControlState,
  saveCodexProxyControlState,
} from "./codex-proxy-control-store.ts";
import { formatError, isNodeError } from "./utils.ts";

interface CodexProxyControlServiceOptions {
  configPath?: string;
  controlStatePath?: string;
  expectedBaseUrl?: string;
  providerName?: string;
}

/**
 * 本文件负责把网页开关映射到 `~/.codex/config.toml`。
 * 为了降低误改风险，这里只改两件事：顶层 `model_provider`，以及我们自己的 provider block。
 */

/**
 * 读取当前 `config.toml` 中与本地代理相关的状态。
 *
 * @param options 可选的覆盖项，主要用于测试。
 * @returns 可直接给前端展示的配置状态摘要。
 */
export async function readCodexProxyConfigStatus(
  options: CodexProxyControlServiceOptions = {},
): Promise<CodexProxyConfigStatus> {
  const configPath = options.configPath ?? CODEX_CONFIG_FILE;
  const providerName = options.providerName ?? MANAGED_CODEX_PROVIDER_NAME;
  const expectedBaseUrl =
    options.expectedBaseUrl ?? buildManagedProviderBaseUrl();
  const diagnostics: string[] = [];

  let content = "";
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      diagnostics.push("尚未找到 ~/.codex/config.toml。");
    } else {
      diagnostics.push(`读取 Codex 配置失败：${formatError(error)}`);
    }
  }

  const currentModelProvider = readTopLevelStringValue(content, "model_provider");
  const currentProviderBaseUrl = currentModelProvider
    ? readProviderStringValue(content, currentModelProvider, "base_url")
    : null;
  const configuredBaseUrl = readProviderStringValue(
    content,
    providerName,
    "base_url",
  );

  if (!currentModelProvider) {
    diagnostics.push("当前 config.toml 中未声明 model_provider。");
  }

  if (currentModelProvider && currentModelProvider !== providerName) {
    diagnostics.push(
      `当前 model_provider 指向 ${currentModelProvider}，尚未切到 ${providerName}。`,
    );
  }

  if (
    currentModelProvider === providerName &&
    currentProviderBaseUrl !== expectedBaseUrl
  ) {
    diagnostics.push("当前 provider 的 base_url 与本地代理期望地址不一致。");
  }

  return {
    configPath,
    providerName,
    currentModelProvider,
    currentProviderBaseUrl,
    configuredBaseUrl,
    expectedBaseUrl,
    isEnabled:
      currentModelProvider === providerName &&
      configuredBaseUrl === expectedBaseUrl,
    diagnostics,
  };
}

/**
 * 把 Codex 的 provider 切到本地代理，或恢复到此前的 provider。
 *
 * @param enabled `true` 表示接管，`false` 表示恢复。
 * @param options 可选的覆盖项，主要用于测试。
 * @returns 更新后的配置状态。
 * @throws 当关闭接管时缺少恢复目标，或配置文件无法写入时抛出异常。
 */
export async function setCodexProxyEnabled(
  enabled: boolean,
  options: CodexProxyControlServiceOptions = {},
): Promise<CodexProxyConfigStatus> {
  const configPath = options.configPath ?? CODEX_CONFIG_FILE;
  const providerName = options.providerName ?? MANAGED_CODEX_PROVIDER_NAME;
  const expectedBaseUrl =
    options.expectedBaseUrl ?? buildManagedProviderBaseUrl();
  const now = new Date().toISOString();

  const content = await readConfigFileOrEmpty(configPath);
  const currentModelProvider = readTopLevelStringValue(content, "model_provider");
  const controlState = await loadCodexProxyControlState(options.controlStatePath);

  let nextContent = upsertTopLevelStringValue(
    content,
    "model_provider",
    enabled
      ? providerName
      : resolveRestoreProvider(currentModelProvider, controlState.previousModelProvider, providerName),
  );
  nextContent = upsertProviderBlock(
    nextContent,
    providerName,
    buildManagedProviderBlock(providerName, expectedBaseUrl),
  );

  await writeTextFile(configPath, nextContent);

  if (enabled) {
    await saveCodexProxyControlState({
      previousModelProvider:
        currentModelProvider && currentModelProvider !== providerName
          ? currentModelProvider
          : controlState.previousModelProvider,
      lastUpdatedAt: now,
    }, options.controlStatePath);
  } else {
    await saveCodexProxyControlState({
      ...controlState,
      lastUpdatedAt: now,
    }, options.controlStatePath);
  }

  return readCodexProxyConfigStatus({
    configPath,
    providerName,
    expectedBaseUrl,
  });
}

/**
 * 结合 `config.toml` 与最近一次代理请求，构造前端监控面板所需的摘要。
 *
 * @param config 当前接管配置状态。
 * @param gatewayState 本地代理持久化状态。
 * @param now 当前时间。
 * @returns 可直接挂到 `/api/status` 的监控对象。
 */
export function buildCodexProxyStatus(
  config: CodexProxyConfigStatus,
  gatewayState: GatewayPersistedState,
  now: Date = new Date(),
): CodexProxyStatus {
  const recentWindowMinutes = CODEX_PROXY_RECENT_WINDOW_MINUTES;
  const recentWindowMs = recentWindowMinutes * 60 * 1000;
  const lastCodexRequestAt = gatewayState.lastCodexRequestAt;
  const lastCodexRequestMs = lastCodexRequestAt
    ? new Date(lastCodexRequestAt).getTime()
    : Number.NaN;

  const lastProxyClient =
    gatewayState.lastRequestClientKind && gatewayState.lastRequestClientLabel
      ? ({
          kind: gatewayState.lastRequestClientKind,
          label: gatewayState.lastRequestClientLabel,
          lastSeenAt: gatewayState.lastRequestAt,
        } satisfies ProxyClientSnapshot)
      : null;

  return {
    config,
    recentWindowMinutes,
    lastProxyRequestAt: gatewayState.lastRequestAt,
    lastCodexRequestAt,
    isCodexTrafficRecent:
      config.isEnabled &&
      Number.isFinite(lastCodexRequestMs) &&
      now.getTime() - lastCodexRequestMs <= recentWindowMs,
    lastProxyClient,
  };
}

/**
 * 生成本地代理在 Codex 配置里应该写入的 `base_url`。
 *
 * @returns 指向本地服务的 provider `base_url`。
 */
export function buildManagedProviderBaseUrl(): string {
  return `http://${HOST}:${PORT}${GATEWAY_PROVIDER_BASE_PATH}`;
}

/**
 * 从 TOML 顶层读取一个字符串字段。
 *
 * @param content 原始 TOML 文本。
 * @param key 字段名。
 * @returns 命中的字符串值；若不存在则返回 `null`。
 */
export function readTopLevelStringValue(
  content: string,
  key: string,
): string | null {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      break;
    }

    const matched = line.match(
      new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?$`),
    );
    if (matched) {
      return matched[1] ?? null;
    }
  }

  return null;
}

/**
 * 从指定 provider block 中读取一个字符串字段。
 *
 * @param content 原始 TOML 文本。
 * @param providerName provider 名称。
 * @param key 字段名。
 * @returns 命中的字符串值；若不存在则返回 `null`。
 */
export function readProviderStringValue(
  content: string,
  providerName: string,
  key: string,
): string | null {
  const range = findProviderBlockRange(content, providerName);
  if (!range) {
    return null;
  }

  for (const line of range.lines) {
    const matched = line.match(
      new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?$`),
    );
    if (matched) {
      return matched[1] ?? null;
    }
  }

  return null;
}

/**
 * 更新 TOML 顶层的字符串字段；若不存在则自动插入。
 *
 * @param content 原始 TOML 文本。
 * @param key 字段名。
 * @param value 目标值。
 * @returns 更新后的 TOML 文本。
 */
export function upsertTopLevelStringValue(
  content: string,
  key: string,
  value: string,
): string {
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const replacement = `${key} = "${value}"`;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed.startsWith("[")) {
      break;
    }

    if (
      new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(lines[index]!)
    ) {
      lines[index] = replacement;
      return normalizeToml(lines);
    }
  }

  let insertIndex = 0;
  while (
    insertIndex < lines.length &&
    (lines[insertIndex]!.trim() === "" || lines[insertIndex]!.trim().startsWith("#"))
  ) {
    insertIndex += 1;
  }

  lines.splice(insertIndex, 0, replacement);
  return normalizeToml(lines);
}

/**
 * 更新或追加我们的 provider block。
 *
 * @param content 原始 TOML 文本。
 * @param providerName provider 名称。
 * @param blockLines 目标 block 内容。
 * @returns 更新后的 TOML 文本。
 */
export function upsertProviderBlock(
  content: string,
  providerName: string,
  blockLines: string[],
): string {
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const range = findProviderBlockRange(content, providerName);

  if (range) {
    lines.splice(range.start, range.endExclusive - range.start, ...blockLines);
    return normalizeToml(lines);
  }

  if (lines.length > 0 && lines.at(-1)?.trim() !== "") {
    lines.push("");
  }
  lines.push(...blockLines);
  return normalizeToml(lines);
}

/**
 * 构造我们在 `config.toml` 中维护的 provider block。
 *
 * @param providerName provider 名称。
 * @param baseUrl 目标 base_url。
 * @returns 可直接写入 TOML 的 block 行数组。
 */
function buildManagedProviderBlock(
  providerName: string,
  baseUrl: string,
): string[] {
  return [
    `[model_providers.${providerName}]`,
    `name = "${providerName}"`,
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "store = false",
  ];
}

/**
 * 找到指定 provider block 的起止范围。
 *
 * @param content 原始 TOML 文本。
 * @param providerName provider 名称。
 * @returns 若存在则返回范围信息，否则返回 `null`。
 */
function findProviderBlockRange(content: string, providerName: string) {
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const header = `[model_providers.${providerName}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) {
    return null;
  }

  let endExclusive = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]!.trim().startsWith("[")) {
      endExclusive = index;
      break;
    }
  }

  return {
    start,
    endExclusive,
    lines: lines.slice(start + 1, endExclusive),
  };
}

/**
 * 决定在关闭接管时应该恢复到哪个 provider。
 *
 * @param currentModelProvider 当前 `model_provider`。
 * @param previousModelProvider 上一次保存的 provider。
 * @param providerName 我们自己的 provider 名称。
 * @returns 要写回去的 provider 名称。
 * @throws 当当前已是我们的 provider 但又缺少恢复目标时抛出异常。
 */
function resolveRestoreProvider(
  currentModelProvider: string | null,
  previousModelProvider: string | null,
  providerName: string,
): string {
  if (currentModelProvider && currentModelProvider !== providerName) {
    return currentModelProvider;
  }

  if (previousModelProvider) {
    return previousModelProvider;
  }

  throw new Error("当前缺少上一次 model_provider 记录，无法自动恢复。");
}

/**
 * 读取配置文件；若不存在则返回空文本，便于首次接管时直接创建。
 *
 * @param filePath 配置文件绝对路径。
 * @returns 文件文本。
 */
async function readConfigFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

/**
 * 原子方式写回 TOML 文本。
 *
 * @param filePath 配置文件绝对路径。
 * @param content 需要写回的 TOML 文本。
 * @returns 无返回值。
 */
async function writeTextFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${content.trimEnd()}\n`, "utf8");
}

/**
 * 统一规范 TOML 文本的空行和结尾换行。
 *
 * @param lines 文本行数组。
 * @returns 归一化后的 TOML 文本。
 */
function normalizeToml(lines: string[]): string {
  const normalized = [...lines];
  while (normalized.length > 1 && normalized.at(-1)?.trim() === "") {
    normalized.pop();
  }

  return normalized.join("\n");
}

/**
 * 转义正则中的特殊字符。
 *
 * @param value 原始文本。
 * @returns 可安全拼进正则的文本。
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
