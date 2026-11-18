/**
 * 本文件集中封装前端对本地控制台的所有 HTTP 请求。
 * 这样在页面交互层只需要处理“拿什么数据”和“何时刷新”，不用关心具体接口细节。
 */

/**
 * 读取服务端注入到首页的控制台 token（每次服务启动随机生成）。
 *
 * @returns {string}
 */
export function getControlToken() {
  return (
    document.querySelector('meta[name="switcher-token"]')?.getAttribute("content") ?? ""
  );
}

/**
 * 构造携带控制台 token 的 SSE 地址（EventSource 无法设置自定义请求头）。
 *
 * @returns {string}
 */
export function buildEventsUrl() {
  const url = new URL("/api/events", window.location.origin);
  url.searchParams.set("token", getControlToken());
  return url.toString();
}

/**
 * 发送一个 JSON 请求，并在失败时抛出带后端文案的异常。
 *
 * @param {string} url 请求地址。
 * @param {RequestInit=} init fetch 配置。
 * @returns {Promise<any>}
 */
export async function fetchJson(url, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("X-Switcher-Token", getControlToken());
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  const payload = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(payload?.error ?? `请求失败：${response.status}`);
    error.statusCode = response.status;
    error.code = payload?.code ?? null;
    error.payload = payload;
    throw error;
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
 * 新增一个账号定义。
 *
 * @param {any} payload 新账号请求体。
 * @returns {Promise<any>}
 */
export function createAccount(payload) {
  return fetchJson("/api/accounts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

/**
 * 读取某个账号的可编辑详情。
 *
 * @param {string} accountId 账号 ID。
 * @returns {Promise<any>}
 */
export function getEditableAccount(accountId) {
  return fetchJson(`/api/accounts/${encodeURIComponent(accountId)}/edit`);
}

/**
 * 更新一个已有账号。
 *
 * @param {string} accountId 账号 ID。
 * @param {any} payload 更新请求体。
 * @returns {Promise<any>}
 */
export function updateAccount(accountId, payload) {
  return fetchJson(`/api/accounts/${encodeURIComponent(accountId)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
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
 * 预览切换某个路由账号时，是否会触发 `config.toml` 改写。
 *
 * @param {string} targetAccountId 目标账号 ID。
 * @returns {Promise<any>}
 */
export function previewActivateAccount(targetAccountId) {
  return fetchJson("/api/accounts/activate-preview", {
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
 * 请求重启本机 Codex。
 *
 * @returns {Promise<any>}
 */
export function restartCodexApp() {
  return fetchJson("/api/codex/restart", {
    method: "POST",
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
