import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const REPO_ROOT = process.cwd();

/**
 * 本文件验证账号编辑流程的关键回归场景。
 * 由于相关模块会在导入时读取路径配置，这里通过子进程隔离环境变量，避免污染其他测试。
 */

/**
 * 创建一组仅供测试使用的临时目录。
 *
 * @returns 临时 home 与 switcher 目录。
 */
async function createIsolatedFixture() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "codex-space-switcher-update-"),
  );
  const homeDir = path.join(root, "home");
  const switcherHome = path.join(root, "switcher");
  const codexHome = path.join(homeDir, ".codex");

  await mkdir(codexHome, { recursive: true });
  await mkdir(path.join(switcherHome, "auth"), { recursive: true });

  return {
    root,
    homeDir,
    codexHome,
    switcherHome,
    accountsFile: path.join(switcherHome, "accounts.json"),
    gatewayStateFile: path.join(switcherHome, "gateway-state.json"),
    configFile: path.join(codexHome, "config.toml"),
  };
}

/**
 * 在隔离子进程里运行一段后端脚本，并读取 JSON 输出。
 *
 * @param fixture 测试目录信息。
 * @param script 需要执行的 ESM 脚本文本。
 * @returns 子进程标准输出解析后的对象。
 */
async function runBackendScript(
  fixture: Awaited<ReturnType<typeof createIsolatedFixture>>,
  script: string,
) {
  const entryFile = path.join(fixture.root, "runner.mjs");
  await writeFile(entryFile, script, "utf8");

  const { stdout, stderr } = await execFile(
    process.execPath,
    ["--experimental-transform-types", entryFile],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: fixture.homeDir,
        CODEX_SPACE_SWITCHER_HOME: fixture.switcherHome,
        NODE_NO_WARNINGS: "1",
      },
    },
  );

  if (stderr.trim()) {
    throw new Error(stderr.trim());
  }

  return JSON.parse(stdout);
}

test("updateGatewayAccount 应持久化第三方账号编辑结果", async () => {
  const fixture = await createIsolatedFixture();
  await writeFile(
    fixture.accountsFile,
    JSON.stringify(
      {
        includeCurrentCodexSession: false,
        accounts: [
          {
            id: "demo-third-party",
            kind: "third_party",
            name: "旧中转",
            apiBaseUrl: "https://old.example.com/v1",
            apiKey: "old-key",
            defaultModel: "gpt-old",
            requiresResponsesWebSocket: false,
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const result = await runBackendScript(
    fixture,
    `
      import { readFile } from "node:fs/promises";
      import { updateGatewayAccount } from ${JSON.stringify(
        path.join(REPO_ROOT, "apps/backend/src/gateway-account-update-service.ts"),
      )};

      globalThis.fetch = async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      const updateResult = await updateGatewayAccount("demo-third-party", {
        kind: "third_party",
        name: "新中转",
        apiKey: "new-key",
        apiBaseUrl: "https://new.example.com/v1/",
        defaultModel: "gpt-4.1-mini",
        requiresResponsesWebSocket: true,
        billingRule: {
          pricing: {
            inputPerMillionUsd: 1,
            outputPerMillionUsd: 2,
            cachedInputPerMillionUsd: 0.1,
          },
          quota: {
            weeklyBudgetUsd: 30,
            shortWindowBudgetUsd: 5,
            shortWindowKind: "daily",
          },
        },
      });

      const saved = JSON.parse(
        await readFile(process.env.CODEX_SPACE_SWITCHER_HOME + "/accounts.json", "utf8"),
      );

      console.log(JSON.stringify({ updateResult, saved }));
    `,
  );

  assert.equal(result.updateResult.accountId, "demo-third-party");
  assert.equal(result.updateResult.message, "第三方账号已更新。");
  assert.equal(result.saved.accounts[0].name, "新中转");
  assert.equal(result.saved.accounts[0].apiKey, "new-key");
  assert.equal(result.saved.accounts[0].apiBaseUrl, "https://new.example.com/v1");
  assert.equal(result.saved.accounts[0].defaultModel, "gpt-4.1-mini");
  assert.equal(result.saved.accounts[0].requiresResponsesWebSocket, true);
  assert.deepEqual(result.saved.accounts[0].billingRule, {
    pricing: {
      inputPerMillionUsd: 1,
      outputPerMillionUsd: 2,
      cachedInputPerMillionUsd: 0.1,
    },
    quota: {
      weeklyBudgetUsd: 30,
      shortWindowBudgetUsd: 5,
      shortWindowKind: "daily",
    },
  });
});

test("handleAccountDefinitionUpdated 会在激活账号编辑后同步 config.toml", async () => {
  const fixture = await createIsolatedFixture();
  await writeFile(
    fixture.accountsFile,
    JSON.stringify(
      {
        includeCurrentCodexSession: false,
        accounts: [
          {
            id: "demo-third-party",
            kind: "third_party",
            name: "旧中转",
            apiBaseUrl: "https://old.example.com/v1",
            apiKey: "old-key",
            defaultModel: "gpt-old",
            requiresResponsesWebSocket: false,
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    fixture.gatewayStateFile,
    JSON.stringify(
      {
        activeAccountId: "demo-third-party",
        lastRequestAt: null,
        lastRequestModel: null,
        lastRequestResult: null,
        lastRequestClientKind: null,
        lastRequestClientLabel: null,
        lastCodexRequestAt: null,
        codexConfigRestartPending: false,
        codexConfigRestartReason: null,
        codexConfigLastUpdatedAt: null,
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    fixture.configFile,
    `model_provider = "space_switcher"

[model_providers.space_switcher]
name = "space_switcher"
base_url = "http://127.0.0.1:14318/ai-router/api"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
store = false
`,
    "utf8",
  );

  const result = await runBackendScript(
    fixture,
    `
      import { readFile } from "node:fs/promises";
      import { GatewayDashboardService } from ${JSON.stringify(
        path.join(REPO_ROOT, "apps/backend/src/gateway-dashboard-service.ts"),
      )};
      import { updateGatewayAccount } from ${JSON.stringify(
        path.join(REPO_ROOT, "apps/backend/src/gateway-account-update-service.ts"),
      )};
      import { buildManagedProviderBaseUrl } from ${JSON.stringify(
        path.join(REPO_ROOT, "apps/backend/src/codex-proxy-control-service.ts"),
      )};

      globalThis.fetch = async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      await updateGatewayAccount("demo-third-party", {
        kind: "third_party",
        name: "新中转",
        apiKey: "new-key",
        apiBaseUrl: "https://new.example.com/v1",
        defaultModel: "gpt-4.1-mini",
        requiresResponsesWebSocket: true,
      });

      const dashboard = new GatewayDashboardService();
      dashboard.gatewayState = {
        activeAccountId: "demo-third-party",
        lastRequestAt: null,
        lastRequestModel: null,
        lastRequestResult: null,
        lastRequestClientKind: null,
        lastRequestClientLabel: null,
        lastCodexRequestAt: null,
        codexConfigRestartPending: false,
        codexConfigRestartReason: null,
        codexConfigLastUpdatedAt: null,
      };
      dashboard.codexProxyStatus = {
        config: {
          configPath: process.env.HOME + "/.codex/config.toml",
          providerName: "space_switcher",
          currentModelProvider: "space_switcher",
          currentProviderBaseUrl: buildManagedProviderBaseUrl(),
          configuredBaseUrl: buildManagedProviderBaseUrl(),
          expectedBaseUrl: buildManagedProviderBaseUrl(),
          configuredSupportsWebsockets: false,
          expectedSupportsWebsockets: false,
          isEnabled: true,
          diagnostics: [],
        },
        recentWindowMinutes: 10,
        lastProxyRequestAt: null,
        lastCodexRequestAt: null,
        isCodexTrafficRecent: false,
        lastProxyClient: null,
        restartRequired: false,
        restartReason: null,
        restartRequestedAt: null,
      };

      const mutation = await dashboard.handleAccountDefinitionUpdated("demo-third-party");
      const configText = await readFile(process.env.HOME + "/.codex/config.toml", "utf8");
      const gatewayState = JSON.parse(
        await readFile(process.env.CODEX_SPACE_SWITCHER_HOME + "/gateway-state.json", "utf8"),
      );

      console.log(JSON.stringify({ mutation, configText, gatewayState }));
    `,
  );

  assert.equal(result.mutation.configChanged, true);
  assert.equal(result.mutation.restartRequired, true);
  assert.match(result.mutation.restartReason, /需要重启 Codex Desktop/);
  assert.match(result.configText, /supports_websockets = true/);
  assert.equal(result.gatewayState.codexConfigRestartPending, true);
  assert.match(result.gatewayState.codexConfigRestartReason, /需要重启 Codex Desktop/);
});
