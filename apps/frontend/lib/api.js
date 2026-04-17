/**
 * 本文件集中封装前端对本地控制台的所有 HTTP 请求。
 * 这样在页面交互层只需要处理“拿什么数据”和“何时刷新”，不用关心具体接口细节。
 */

/**
 * 发送一个 JSON 请求，并在失败时抛出带后端文案的异常。
 *
 * @param {string} url 请求地址。
 * @param {RequestInit=} init fetch 配置。
 * @returns {Promise<any>}
 */
export async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  const payload = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(payload?.error ?? `请求失败：${response.status}`);
  }

  return payload;
}

/**
 * 获取账号卡片列表。
 *
 * @returns {Promise<any[]>}
 */
export function getAccounts() {
  return fetchJson("/api/accounts");
}

/**
 * 获取顶部状态摘要。
 *
 * @returns {Promise<any>}
 */
export function getStatus() {
  return fetchJson("/api/status");
}

/**
 * 获取当前筛选项下的统计面板数据。
 *
 * @param {string} filterId 当前筛选项 ID。
 * @returns {Promise<any>}
 */
export function getUsageDashboard(filterId) {
  const url = new URL("/api/usage-dashboard", window.location.origin);
  if (filterId) {
    url.searchParams.set("filter", filterId);
  }

  return fetchJson(url.toString());
}

/**
 * 获取最近的代理事件列表。
 *
 * @param {string} filterId 当前筛选项 ID。
 * @param {number=} limit 最多返回多少条。
 * @returns {Promise<any[]>}
 */
export function getUsageEvents(filterId, limit = 16) {
  const url = new URL("/api/usage-events", window.location.origin);
  if (filterId) {
    url.searchParams.set("filter", filterId);
  }
  url.searchParams.set("limit", String(limit));
  return fetchJson(url.toString());
}

/**
 * 手动触发后端刷新。
 *
 * @returns {Promise<any>}
 */
export function refreshDashboard() {
  return fetchJson("/api/refresh", {
    method: "POST",
  });
}

/**
 * 将本地代理的激活账号切到指定目标。
 *
 * @param {string} targetAccountId 目标账号 ID。
 * @returns {Promise<any>}
 */
export function activateAccount(targetAccountId) {
  return fetchJson("/api/accounts/activate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      targetAccountId,
    }),
  });
}

/**
 * 打开或关闭 Codex 本地代理接管。
 *
 * @param {boolean} enabled 是否启用本地代理接管。
 * @returns {Promise<any>}
 */
export function setCodexProxyEnabled(enabled) {
  return fetchJson("/api/codex-proxy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      enabled,
    }),
  });
}
