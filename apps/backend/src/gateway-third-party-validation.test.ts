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
 * 本文件验证第三方账号保存前的软确认逻辑。
 * 重点覆盖“首次 `/models` 失败先给提示、用户再次确认后可跳过校验保存”这条回归路径。
 */

/**
 * 创建一组隔离目录，供后端子进程读写本地配置。
 *
 * @returns 测试期间使用的临时路径集合。
 */
async function createIsolatedFixture() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "codex-space-switcher-third-party-validation-"),
  );
  const homeDir = path.join(root, "home");
  const switcherHome = path.join(root, "switcher");
  const codexHome = path.join(homeDir, ".codex");

  await mkdir(codexHome, { recursive: true });
  await mkdir(switcherHome, { recursive: true });

  return {
    root,
    homeDir,
    codexHome,
    switcherHome,
    accountsFile: path.join(switcherHome, "accounts.json"),
  };
}

/**
 * 在隔离环境里运行一段后端 ESM 脚本，并把标准输出解析成 JSON。
 *
 * @param fixture 测试目录信息。
 * @param script 需要执行的脚本文本。
 * @returns 子进程输出的 JSON 对象。
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

test("createGatewayAccount 在 `/models` 失败时应先返回可二次确认的错误", async () => {
  const fixture = await createIsolatedFixture();

  const result = await runBackendScript(
    fixture,
    `
      import { createGatewayAccount } from ${JSON.stringify(
        path.join(REPO_ROOT, "apps/backend/src/gateway-account-creation-service.ts"),
      )};

      globalThis.fetch = async () =>
        new Response("models disabled", {
          status: 404,
          headers: { "Content-Type": "text/plain" },
        });

      try {
        await createGatewayAccount({
          kind: "third_party",
          name: "兼容中转",
          apiKey: "demo-key",
          apiBaseUrl: "https://relay.example.com/v1",
        });
      } catch (error) {
        console.log(
          JSON.stringify({
            statusCode: error?.statusCode ?? null,
            code: error?.code ?? null,
            message: error?.message ?? null,
          }),
        );
      }
    `,
  );

  assert.equal(result.statusCode, 409);
  assert.equal(
    result.code,
    "third_party_validation_confirmation_required",
  );
  assert.match(result.message, /再次点击保存/);
});

test("createGatewayAccount 在用户确认后应允许跳过 `/models` 校验并保存", async () => {
  const fixture = await createIsolatedFixture();

  const result = await runBackendScript(
    fixture,
    `
      import { readFile } from "node:fs/promises";
      import { createGatewayAccount } from ${JSON.stringify(
        path.join(REPO_ROOT, "apps/backend/src/gateway-account-creation-service.ts"),
      )};

      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls += 1;
        throw new Error("should not fetch when skipConnectivityCheck=true");
      };

      const created = await createGatewayAccount({
        kind: "third_party",
        name: "兼容中转",
        apiKey: "demo-key",
        apiBaseUrl: "https://relay.example.com/v1/",
        skipConnectivityCheck: true,
      });

      const saved = JSON.parse(
        await readFile(process.env.CODEX_SPACE_SWITCHER_HOME + "/accounts.json", "utf8"),
      );

      console.log(JSON.stringify({ created, saved, fetchCalls }));
    `,
  );

  assert.equal(result.fetchCalls, 0);
  assert.equal(result.created.accountName, "兼容中转");
  assert.match(result.created.message, /跳过了本次 \/models 连通性测试/);
  assert.equal(result.saved.accounts[0].apiBaseUrl, "https://relay.example.com/v1");
});

test("updateGatewayAccount 在用户确认后也应允许跳过 `/models` 校验并保存", async () => {
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

      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls += 1;
        throw new Error("should not fetch when skipConnectivityCheck=true");
      };

      const updated = await updateGatewayAccount("demo-third-party", {
        kind: "third_party",
        name: "新中转",
        apiKey: "new-key",
        apiBaseUrl: "https://relay.example.com/v1/",
        defaultModel: "gpt-5.4",
        requiresResponsesWebSocket: true,
        skipConnectivityCheck: true,
      });

      const saved = JSON.parse(
        await readFile(process.env.CODEX_SPACE_SWITCHER_HOME + "/accounts.json", "utf8"),
      );

      console.log(JSON.stringify({ updated, saved, fetchCalls }));
    `,
  );

  assert.equal(result.fetchCalls, 0);
  assert.equal(result.updated.accountId, "demo-third-party");
  assert.match(result.updated.message, /跳过了本次 \/models 连通性测试/);
  assert.equal(result.saved.accounts[0].defaultModel, "gpt-5.4");
  assert.equal(result.saved.accounts[0].requiresResponsesWebSocket, true);
});
