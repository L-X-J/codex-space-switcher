import test from "node:test";
import assert from "node:assert/strict";
import type { DashboardStatus, SpaceCard } from "../../../packages/shared/src/index.ts";
import { createIdleSwitchJob } from "./state-store.ts";
import { SpaceSwitchService } from "./space-switch-service.ts";

/**
 * 本文件验证切换队列的基础保护逻辑。
 * 首版最关键的交互之一就是“当前空间不可重复切换”，因此这里用最小上下文把行为锁住。
 */

/**
 * 创建一个最小可运行的状态上下文。
 *
 * @param spaces 初始空间列表。
 * @returns 适合注入切换服务的上下文对象。
 */
function createContext(spaces: SpaceCard[]) {
  let currentSpaces = spaces;
  let status: DashboardStatus = {
    activeSpaceId: spaces.find((space) => space.isActive)?.id ?? null,
    activeSpaceName: spaces.find((space) => space.isActive)?.name ?? null,
    runtime: {
      state: "running",
      isBusy: false,
      lastObservedAt: new Date().toISOString(),
      detail: "mock runtime",
    },
    switchJob: createIdleSwitchJob(),
    lastSwitchResult: null,
  };

  return {
    context: {
      getSpaces: async () => currentSpaces,
      getStatus: async () => status,
      setStatus: async (updater: (draft: DashboardStatus) => DashboardStatus) => {
        status = updater(status);
      },
      reloadSpaces: async () => currentSpaces,
    },
    getStatus: () => status,
  };
}

/**
 * 轮询等待状态满足给定条件。
 *
 * @param readStatus 读取当前状态的函数。
 * @param predicate 判定条件。
 * @returns 命中条件时的最终状态。
 * @throws 当在有限轮询内始终未满足条件时抛出异常。
 */
async function waitForStatus(
  readStatus: () => DashboardStatus,
  predicate: (status: DashboardStatus) => boolean,
): Promise<DashboardStatus> {
  for (let index = 0; index < 50; index += 1) {
    const status = readStatus();
    if (predicate(status)) {
      return status;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  throw new Error("等待切换状态更新超时。");
}

test("enqueue 对当前激活空间返回 rejected", async () => {
  const spaces: SpaceCard[] = [
    {
      id: "plus",
      name: "Personal Plus",
      kind: "plus",
      isActive: true,
      usageSummary: null,
      quotaSummary: null,
      health: "healthy",
      lastCheckedAt: new Date().toISOString(),
      rawDiagnostics: [],
    },
  ];
  const { context } = createContext(spaces);
  const service = new SpaceSwitchService(context);

  const result = await service.enqueue("plus");
  assert.equal(result, "rejected");
});

test("当 Codex 长时间忙碌时，切换任务会失败并给出明确提示", async () => {
  const spaces: SpaceCard[] = [
    {
      id: "plus",
      name: "Personal Plus",
      kind: "plus",
      isActive: true,
      usageSummary: null,
      quotaSummary: null,
      health: "healthy",
      lastCheckedAt: new Date().toISOString(),
      rawDiagnostics: [],
    },
    {
      id: "team",
      name: "MyTeam",
      kind: "team",
      isActive: false,
      usageSummary: null,
      quotaSummary: null,
      health: "healthy",
      lastCheckedAt: new Date().toISOString(),
      rawDiagnostics: [],
    },
  ];
  const { context, getStatus } = createContext(spaces);
  const service = new SpaceSwitchService(context, {
    busyWaitTimeoutMs: 0,
    adapter: {
      isCodexBusy: async () => true,
      loadCodexSession: async () => ({
        authMode: "web",
        accessToken: "token",
        refreshToken: null,
        accountId: "plus",
        email: null,
        userName: null,
        lastRefresh: null,
      }),
      callInternalApi: async () => ({
        ok: false,
        status: 500,
        url: "https://chatgpt.com/backend-api/accounts/switch",
        body: null,
        rawText: "not called",
      }),
      stopCodexApp: async () => {},
      startCodexApp: async () => {},
      sleep: async () => {},
    },
  });

  const result = await service.enqueue("team");
  assert.equal(result, "queued");

  const status = await waitForStatus(getStatus, (current) => current.switchJob.stage === "failed");
  assert.equal(status.switchJob.stage, "failed");
  assert.match(status.switchJob.message, /持续忙碌超过/);
});

test("当所有切换候选均失败时，任务会明确提示当前尚无自动切换机制", async () => {
  const spaces: SpaceCard[] = [
    {
      id: "plus",
      name: "Personal Plus",
      kind: "plus",
      isActive: true,
      usageSummary: null,
      quotaSummary: null,
      health: "healthy",
      lastCheckedAt: new Date().toISOString(),
      rawDiagnostics: [],
    },
    {
      id: "team",
      name: "MyTeam",
      kind: "team",
      isActive: false,
      usageSummary: null,
      quotaSummary: null,
      health: "healthy",
      lastCheckedAt: new Date().toISOString(),
      rawDiagnostics: [],
    },
  ];
  const { context, getStatus } = createContext(spaces);
  const service = new SpaceSwitchService(context, {
    adapter: {
      isCodexBusy: async () => false,
      loadCodexSession: async () => ({
        authMode: "web",
        accessToken: "token",
        refreshToken: null,
        accountId: "plus",
        email: null,
        userName: null,
        lastRefresh: null,
      }),
      callInternalApi: async (_session, path, init) => ({
        ok: false,
        status: path.includes("workspaces") ? 404 : 405,
        url: `https://chatgpt.com${path}`,
        body: null,
        rawText: `${init.method} ${path} failed`,
      }),
      stopCodexApp: async () => {},
      startCodexApp: async () => {},
      sleep: async () => {},
    },
  });

  const result = await service.enqueue("team");
  assert.equal(result, "queued");

  const status = await waitForStatus(getStatus, (current) => current.switchJob.stage === "failed");
  assert.equal(status.switchJob.stage, "failed");
  assert.match(status.switchJob.message, /尚未找到可用的 Codex Desktop 自动切换机制/);
  assert.match(status.switchJob.message, /405/);
  assert.match(status.switchJob.message, /404/);
});
