import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCodexProxyStatus,
  readCodexProxyConfigStatus,
  setCodexProxyEnabled,
} from "./codex-proxy-control-service.ts";

const TEST_PROVIDER_NAME = "space_switcher";
const TEST_EXPECTED_BASE_URL = "http://127.0.0.1:14318/ai-router/api";

/**
 * 本文件验证网页开关对 `config.toml` 的改写和恢复逻辑。
 * 所有测试都运行在临时目录里，避免误碰真实用户配置。
 */

/**
 * 创建临时配置文件与控制状态文件。
 *
 * @param initialConfig 初始 TOML 文本。
 * @returns 一组仅供测试使用的临时路径。
 */
async function createTempFixture(initialConfig: string) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "codex-space-switcher-proxy-"),
  );
  const configPath = path.join(root, "config.toml");
  const controlStatePath = path.join(root, "codex-proxy-control.json");
  await writeFile(configPath, `${initialConfig.trim()}\n`, "utf8");

  return {
    configPath,
    controlStatePath,
  };
}

test("readCodexProxyConfigStatus 应识别当前 provider 与其 base_url", async () => {
  const fixture = await createTempFixture(`
model_provider = "aigate"

[model_providers.aigate]
name = "aigate"
base_url = "http://127.0.0.1:6789/ai-router/api"
wire_api = "responses"
`);

  const status = await readCodexProxyConfigStatus({
    configPath: fixture.configPath,
    providerName: TEST_PROVIDER_NAME,
    expectedBaseUrl: TEST_EXPECTED_BASE_URL,
  });

  assert.equal(status.currentModelProvider, "aigate");
  assert.equal(
    status.currentProviderBaseUrl,
    "http://127.0.0.1:6789/ai-router/api",
  );
  assert.equal(status.configuredBaseUrl, null);
  assert.equal(status.isEnabled, false);
});

test("setCodexProxyEnabled(true) 应写入受管 provider 并保存恢复上下文", async () => {
  const fixture = await createTempFixture(`
model_provider = "aigate"

[model_providers.aigate]
name = "aigate"
base_url = "http://127.0.0.1:6789/ai-router/api"
wire_api = "responses"
`);

  const status = await setCodexProxyEnabled(true, {
    configPath: fixture.configPath,
    controlStatePath: fixture.controlStatePath,
    providerName: TEST_PROVIDER_NAME,
    expectedBaseUrl: TEST_EXPECTED_BASE_URL,
  });

  const content = await readFile(fixture.configPath, "utf8");
  const controlState = JSON.parse(
    await readFile(fixture.controlStatePath, "utf8"),
  ) as {
    previousModelProvider: string | null;
  };

  assert.equal(status.isEnabled, true);
  assert.equal(status.currentModelProvider, TEST_PROVIDER_NAME);
  assert.equal(status.currentProviderBaseUrl, TEST_EXPECTED_BASE_URL);
  assert.match(content, /model_provider = "space_switcher"/);
  assert.match(content, /\[model_providers\.space_switcher\]/);
  assert.match(
    content,
    /base_url = "http:\/\/127\.0\.0\.1:14318\/ai-router\/api"/,
  );
  assert.equal(controlState.previousModelProvider, "aigate");
});

test("setCodexProxyEnabled(false) 应恢复之前的 provider", async () => {
  const fixture = await createTempFixture(`
model_provider = "aigate"

[model_providers.aigate]
name = "aigate"
base_url = "http://127.0.0.1:6789/ai-router/api"
wire_api = "responses"
`);

  await setCodexProxyEnabled(true, {
    configPath: fixture.configPath,
    controlStatePath: fixture.controlStatePath,
    providerName: TEST_PROVIDER_NAME,
    expectedBaseUrl: TEST_EXPECTED_BASE_URL,
  });

  const status = await setCodexProxyEnabled(false, {
    configPath: fixture.configPath,
    controlStatePath: fixture.controlStatePath,
    providerName: TEST_PROVIDER_NAME,
    expectedBaseUrl: TEST_EXPECTED_BASE_URL,
  });

  const content = await readFile(fixture.configPath, "utf8");

  assert.equal(status.currentModelProvider, "aigate");
  assert.equal(
    status.currentProviderBaseUrl,
    "http://127.0.0.1:6789/ai-router/api",
  );
  assert.equal(status.isEnabled, false);
  assert.match(content, /model_provider = "aigate"/);
});

test("buildCodexProxyStatus 应在最近窗口内识别到 Codex 流量", () => {
  const now = new Date("2026-04-17T10:00:00.000Z");
  const status = buildCodexProxyStatus(
    {
      configPath: "/tmp/config.toml",
      providerName: TEST_PROVIDER_NAME,
      currentModelProvider: TEST_PROVIDER_NAME,
      currentProviderBaseUrl: TEST_EXPECTED_BASE_URL,
      configuredBaseUrl: TEST_EXPECTED_BASE_URL,
      expectedBaseUrl: TEST_EXPECTED_BASE_URL,
      isEnabled: true,
      diagnostics: [],
    },
    {
      activeAccountId: "official-a",
      lastRequestAt: "2026-04-17T09:57:00.000Z",
      lastRequestModel: "gpt-5.3-codex",
      lastRequestResult: "Official A 返回 200",
      lastRequestClientKind: "codex",
      lastRequestClientLabel: "Codex",
      lastCodexRequestAt: "2026-04-17T09:57:00.000Z",
    },
    now,
  );

  assert.equal(status.isCodexTrafficRecent, true);
  assert.equal(status.lastProxyClient?.label, "Codex");
});
