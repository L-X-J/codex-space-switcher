import { API_BASE_URL, DESKTOP_ORIGINATOR } from "./config.ts";
import type { CodexSession } from "./codex-session-provider.ts";

/**
 * 本文件封装所有对私有接口的请求。
 * 这样可以把鉴权头、默认域名和重试策略集中管理，后续替换真实接口时改动面最小。
 */

export interface InternalApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  url: string;
  body: T | null;
  rawText: string;
}

/**
 * 发送一个带 Codex 会话头的私有请求。
 *
 * @param session 当前本机会话。
 * @param path 私有接口路径。
 * @param init 可选请求参数。
 * @returns 带状态码与响应体的统一结果。
 */
export async function callInternalApi<T>(
  session: CodexSession,
  path: string,
  init: RequestInit = {},
): Promise<InternalApiResponse<T>> {
  const url = new URL(path, API_BASE_URL).toString();
  const headers = new Headers(init.headers ?? {});

  headers.set("Authorization", `Bearer ${session.accessToken}`);
  headers.set("originator", DESKTOP_ORIGINATOR);
  headers.set("User-Agent", "Codex Desktop/Local Space Switcher");

  if (session.accountId) {
    headers.set("ChatGPT-Account-Id", session.accountId);
  }

  if (
    init.body &&
    !(init.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    ...init,
    headers,
  });
  const rawText = await response.text();
  let body: T | null = null;

  try {
    body = rawText.length > 0 ? (JSON.parse(rawText) as T) : null;
  } catch {
    body = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    url,
    body,
    rawText,
  };
}
