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
