import type { DashboardStatus, SwitchJob } from "../../../packages/shared/src/index.ts";
import { SWITCHER_STATE_FILE } from "./config.ts";
import { readJsonFile, writeJsonFile } from "./utils.ts";

interface PersistedState {
  lastSwitchResult: string | null;
  switchJob: SwitchJob;
}

/**
 * 本文件负责本地状态持久化。
 * 其目标是让服务重启后仍能恢复最近一次切换结果与队列状态，而不是把状态完全丢在内存里。
 */

/**
 * 加载之前持久化的切换状态。
 *
 * @returns 若存在持久化文件则返回状态对象，否则返回默认值。
 */
export async function loadPersistedState(): Promise<PersistedState> {
  const state = await readJsonFile<PersistedState>(SWITCHER_STATE_FILE);

  return (
    state ?? {
      lastSwitchResult: null,
      switchJob: createIdleSwitchJob(),
    }
  );
}

/**
 * 持久化最近一次切换结果与队列信息。
 *
 * @param dashboardStatus 当前面板摘要。
 * @returns 无返回值。
 */
export async function savePersistedState(
  dashboardStatus: DashboardStatus,
): Promise<void> {
  await writeJsonFile(SWITCHER_STATE_FILE, {
    lastSwitchResult: dashboardStatus.lastSwitchResult,
    switchJob: dashboardStatus.switchJob,
  } satisfies PersistedState);
}

/**
 * 创建一个空闲状态的切换任务。
 *
 * @returns 空闲任务对象。
 */
export function createIdleSwitchJob(): SwitchJob {
  return {
    id: "idle",
    targetSpaceId: null,
    targetSpaceName: null,
    stage: "idle",
    message: "当前没有待执行的切换任务。",
    createdAt: null,
    updatedAt: null,
    error: null,
  };
}
