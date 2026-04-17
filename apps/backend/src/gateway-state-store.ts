import type { ProxyClientKind } from "../../../packages/shared/src/index.ts";
import { GATEWAY_STATE_FILE } from "./config.ts";
import { readJsonFile, writeJsonFile } from "./utils.ts";

/**
 * 持久化本地代理路由状态。
 * 这个文件只保存“当前激活账号”和最近一次代理请求摘要，避免和旧的空间切换状态互相覆盖。
 */
export interface GatewayPersistedState {
  activeAccountId: string | null;
  lastRequestAt: string | null;
  lastRequestModel: string | null;
  lastRequestResult: string | null;
  lastRequestClientKind: ProxyClientKind | null;
  lastRequestClientLabel: string | null;
  lastCodexRequestAt: string | null;
}

/**
 * 读取之前保存的代理状态。
 *
 * @returns 若文件不存在则返回默认空状态。
 */
export async function loadGatewayState(): Promise<GatewayPersistedState> {
  return (
    (await readJsonFile<GatewayPersistedState>(GATEWAY_STATE_FILE)) ?? {
      activeAccountId: null,
      lastRequestAt: null,
      lastRequestModel: null,
      lastRequestResult: null,
      lastRequestClientKind: null,
      lastRequestClientLabel: null,
      lastCodexRequestAt: null,
    }
  );
}

/**
 * 保存当前代理状态。
 *
 * @param state 需要持久化的状态对象。
 * @returns 无返回值。
 */
export async function saveGatewayState(
  state: GatewayPersistedState,
): Promise<void> {
  await writeJsonFile(GATEWAY_STATE_FILE, state);
}
