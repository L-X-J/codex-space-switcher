import { CODEX_PROXY_CONTROL_STATE_FILE } from "./config.ts";
import { readJsonFile, writeJsonFile } from "./utils.ts";

/**
 * 持久化网页开关“接管 Codex 配置”时的恢复上下文。
 * 当前主要记录切换前的 `model_provider`，便于用户关闭开关后回退到原来的代理。
 */
export interface CodexProxyControlState {
  previousModelProvider: string | null;
  lastUpdatedAt: string | null;
}

/**
 * 读取之前保存的接管上下文。
 *
 * @returns 若文件不存在则返回默认空状态。
 */
export async function loadCodexProxyControlState(
  filePath: string = CODEX_PROXY_CONTROL_STATE_FILE,
): Promise<CodexProxyControlState> {
  return (
    (await readJsonFile<CodexProxyControlState>(filePath)) ?? {
      previousModelProvider: null,
      lastUpdatedAt: null,
    }
  );
}

/**
 * 保存接管上下文。
 *
 * @param state 需要持久化的状态对象。
 * @returns 无返回值。
 */
export async function saveCodexProxyControlState(
  state: CodexProxyControlState,
  filePath: string = CODEX_PROXY_CONTROL_STATE_FILE,
): Promise<void> {
  await writeJsonFile(filePath, state);
}
