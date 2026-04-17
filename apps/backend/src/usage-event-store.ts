import { appendFile } from "node:fs/promises";

import type { UsageEventRecord } from "../../../packages/shared/src/index.ts";
import { GATEWAY_USAGE_EVENTS_FILE } from "./config.ts";
import { isNodeError, readJsonFile, writeJsonFile } from "./utils.ts";

/**
 * 本文件负责持久化本地代理捕获到的 token 用量事件。
 * 采用 JSONL 追加写入，便于后续做聚合、裁剪和离线审计。
 */

/**
 * 追加写入一条代理用量事件。
 *
 * @param event 需要落盘的事件对象。
 * @returns 无返回值。
 */
export async function appendUsageEvent(event: UsageEventRecord): Promise<void> {
  const path = await import("node:path");
  const { mkdir } = await import("node:fs/promises");

  await mkdir(path.dirname(GATEWAY_USAGE_EVENTS_FILE), { recursive: true });
  await appendFile(
    GATEWAY_USAGE_EVENTS_FILE,
    `${JSON.stringify(event)}\n`,
    "utf8",
  );
}

/**
 * 读取所有已落盘的代理用量事件。
 *
 * @returns 事件数组，文件不存在时返回空数组。
 */
export async function loadUsageEvents(): Promise<UsageEventRecord[]> {
  const { readFile } = await import("node:fs/promises");

  try {
    const raw = await readFile(GATEWAY_USAGE_EVENTS_FILE, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as UsageEventRecord];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}
