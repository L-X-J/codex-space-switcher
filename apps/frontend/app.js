import {
  activateAccount,
  getAccounts,
  getStatus,
  getUsageDashboard,
  getUsageEvents,
  refreshDashboard,
  setCodexProxyEnabled,
} from "./lib/api.js";
import {
  renderAccountRows,
  renderCodexProxy,
  renderFilterOptions,
  renderStatus,
  renderUsageEvents,
  renderUsagePanels,
} from "./lib/render.js";

const AVAILABLE_PAGES = new Set(["proxy", "accounts", "usage"]);

const state = {
  accounts: [],
  status: null,
  usageDashboard: null,
  usageEvents: [],
  selectedPage: readInitialPage(),
  selectedFilterId: "all",
  codexProxyChangePending: false,
  codexProxyDesiredEnabled: null,
  codexProxyFeedback: null,
  codexProxyFeedbackTone: null,
};

const elements = {
  refreshButton: document.querySelector("#refreshButton"),
  connectionBadge: document.querySelector("#connectionBadge"),
  pageStage: document.querySelector("#pageStage"),
  pageTrack: document.querySelector("#pageTrack"),
  pageTabs: Array.from(document.querySelectorAll("[data-page-target]")),
  pageViews: Array.from(document.querySelectorAll("[data-page]")),
  codexProxyToggle: document.querySelector("#codexProxyToggle"),
  codexProxyToggleHint: document.querySelector("#codexProxyToggleHint"),
  codexProxyConfigBadge: document.querySelector("#codexProxyConfigBadge"),
  codexProxyTrafficBadge: document.querySelector("#codexProxyTrafficBadge"),
  codexProxyClientBadge: document.querySelector("#codexProxyClientBadge"),
  codexProxyConfigPath: document.querySelector("#codexProxyConfigPath"),
  codexProxyCurrentProvider: document.querySelector("#codexProxyCurrentProvider"),
  codexProxyCurrentBaseUrl: document.querySelector("#codexProxyCurrentBaseUrl"),
  codexProxyExpectedProvider: document.querySelector("#codexProxyExpectedProvider"),
  codexProxyManagedBaseUrl: document.querySelector("#codexProxyManagedBaseUrl"),
  codexProxyExpectedBaseUrl: document.querySelector("#codexProxyExpectedBaseUrl"),
  codexProxyLastCodexRequestAt: document.querySelector("#codexProxyLastCodexRequestAt"),
  codexProxyLastProxyRequestAt: document.querySelector("#codexProxyLastProxyRequestAt"),
  codexProxyDiagnostics: document.querySelector("#codexProxyDiagnostics"),
  codexProxyFeedback: document.querySelector("#codexProxyFeedback"),
  usageFilterSelect: document.querySelector("#usageFilterSelect"),
  activeAccountName: document.querySelector("#activeAccountName"),
  activeAccountDetail: document.querySelector("#activeAccountDetail"),
  gatewayBaseUrl: document.querySelector("#gatewayBaseUrl"),
  gatewayRoutePath: document.querySelector("#gatewayRoutePath"),
  lastRequestAt: document.querySelector("#lastRequestAt"),
  lastRequestDetail: document.querySelector("#lastRequestDetail"),
  lastRequestModel: document.querySelector("#lastRequestModel"),
  usagePanels: document.querySelector("#usagePanels"),
  accountsList: document.querySelector("#accountsList"),
  eventsList: document.querySelector("#eventsList"),
  usageWindowTemplate: document.querySelector("#usageWindowTemplate"),
  accountRowTemplate: document.querySelector("#accountRowTemplate"),
  eventRowTemplate: document.querySelector("#eventRowTemplate"),
};

/**
 * 初始化页面事件与首屏数据。
 *
 * @returns {Promise<void>}
 */
async function main() {
  elements.refreshButton?.addEventListener("click", handleManualRefresh);
  elements.codexProxyToggle?.addEventListener("change", handleCodexProxyToggle);
  bindPageTabs();
  elements.usageFilterSelect?.addEventListener("change", async (event) => {
    state.selectedFilterId = event.currentTarget.value;
    await refreshUsage();
  });
  window.addEventListener("hashchange", handleHashChange);
  window.addEventListener("resize", syncPageStageHeight);

  await refreshAll();
  connectEvents();
}

/**
 * 刷新整页状态。
 *
 * @returns {Promise<void>}
 */
async function refreshAll() {
  const [accounts, status] = await Promise.all([getAccounts(), getStatus()]);
  state.accounts = accounts;
  state.status = status;

  const preferredFilterId = pickPreferredFilterId();
  state.usageDashboard = await getUsageDashboard(preferredFilterId);
  state.selectedFilterId = state.usageDashboard.selectedFilterId;
  state.usageEvents = await getUsageEvents(state.selectedFilterId);
  render();
}

/**
 * 只刷新统计和最近请求区域。
 *
 * @returns {Promise<void>}
 */
async function refreshUsage() {
  state.usageDashboard = await getUsageDashboard(state.selectedFilterId);
  state.selectedFilterId = state.usageDashboard.selectedFilterId;
  state.usageEvents = await getUsageEvents(state.selectedFilterId);
  renderUsage();
}

/**
 * 手动触发后端刷新，并同步更新页面。
 *
 * @returns {Promise<void>}
 */
async function handleManualRefresh() {
  elements.refreshButton.disabled = true;
  try {
    await refreshDashboard();
    await refreshAll();
  } finally {
    elements.refreshButton.disabled = false;
  }
}

/**
 * 切换 Codex 是否接管到当前本地代理。
 *
 * @param {Event} event checkbox change 事件。
 * @returns {Promise<void>}
 */
async function handleCodexProxyToggle(event) {
  const nextEnabled = event.currentTarget.checked === true;
  state.codexProxyChangePending = true;
  state.codexProxyDesiredEnabled = nextEnabled;
  state.codexProxyFeedback = nextEnabled
    ? "正在写入 ~/.codex/config.toml ..."
    : "正在恢复上一次 provider ...";
  state.codexProxyFeedbackTone = "neutral";
  renderProxy();

  try {
    await setCodexProxyEnabled(nextEnabled);
    await refreshAll();
    state.codexProxyFeedback = nextEnabled
      ? "已把 Codex 配置切到本地代理。"
      : "已恢复到切换前的 provider。";
    state.codexProxyFeedbackTone = "success";
  } catch (error) {
    state.codexProxyFeedback =
      error instanceof Error ? error.message : String(error);
    state.codexProxyFeedbackTone = "error";
  } finally {
    state.codexProxyChangePending = false;
    state.codexProxyDesiredEnabled = null;
    renderProxy();
  }
}

/**
 * 执行账号激活动作。
 *
 * @param {string} accountId 目标账号 ID。
 * @returns {Promise<void>}
 */
async function handleActivateAccount(accountId) {
  await activateAccount(accountId);
  await refreshAll();
}

/**
 * 建立 SSE 事件流，局部刷新页面。
 */
function connectEvents() {
  const events = new EventSource("/api/events");
  elements.connectionBadge.textContent = "实时连接中";

  events.addEventListener("accounts.updated", async (event) => {
    state.accounts = JSON.parse(event.data);
    renderAccounts();
    await refreshUsage();
  });

  events.addEventListener("codex.status_changed", (event) => {
    state.status = JSON.parse(event.data);
    renderStatus(state.status, elements);
    renderProxy();
  });

  events.addEventListener("usage_dashboard.updated", async () => {
    await refreshUsage();
  });

  events.onerror = () => {
    elements.connectionBadge.textContent = "连接中断";
  };
}

/**
 * 渲染整页。
 */
function render() {
  renderPageNavigation();
  renderStatus(state.status, elements);
  renderProxy();
  renderUsage();
  renderAccounts();
}

/**
 * 渲染统计区。
 */
function renderUsage() {
  renderFilterOptions(
    state.usageDashboard,
    state.selectedFilterId,
    elements.usageFilterSelect,
  );
  renderUsagePanels(state.usageDashboard, elements);
  renderUsageEvents(state.usageEvents, elements);
  syncPageStageHeight();
}

/**
 * 渲染 Codex 代理开关与监控面板。
 */
function renderProxy() {
  renderCodexProxy(state.status?.codexProxy, elements, {
    isMutating: state.codexProxyChangePending,
    desiredEnabled: state.codexProxyDesiredEnabled,
    feedback: state.codexProxyFeedback,
    feedbackTone: state.codexProxyFeedbackTone,
  });
  syncPageStageHeight();
}

/**
 * 渲染账号相关区域。
 */
function renderAccounts() {
  renderAccountRows(state.accounts, elements, handleActivateAccount);
  syncPageStageHeight();
}

/**
 * 绑定顶部分页按钮。
 */
function bindPageTabs() {
  for (const tab of elements.pageTabs) {
    tab.addEventListener("click", () => {
      const nextPage = tab.dataset.pageTarget;
      if (!nextPage) {
        return;
      }

      setSelectedPage(nextPage);
    });
  }
}

/**
 * 根据当前状态切换分页显隐。
 */
function renderPageNavigation() {
  const activeIndex = Array.from(AVAILABLE_PAGES).indexOf(state.selectedPage);

  for (const tab of elements.pageTabs) {
    const isActive = tab.dataset.pageTarget === state.selectedPage;
    tab.dataset.active = String(isActive);
    tab.setAttribute("aria-selected", String(isActive));
  }

  for (const view of elements.pageViews) {
    const isActive = view.dataset.page === state.selectedPage;
    view.dataset.active = String(isActive);
    view.setAttribute("aria-hidden", String(!isActive));
  }

  if (elements.pageTrack) {
    elements.pageTrack.style.transform = `translateX(-${activeIndex * 100}%)`;
  }

  syncPageStageHeight();
}

/**
 * 切换当前选中的分页。
 *
 * @param {string} pageId 目标分页 ID。
 */
function setSelectedPage(pageId) {
  if (!AVAILABLE_PAGES.has(pageId) || pageId === state.selectedPage) {
    return;
  }

  state.selectedPage = pageId;
  window.history.replaceState(null, "", `#${pageId}`);
  renderPageNavigation();
}

/**
 * 响应浏览器 hash 变化，保持页签与 URL 同步。
 */
function handleHashChange() {
  const pageId = normalizePageId(window.location.hash.slice(1));
  if (pageId === state.selectedPage) {
    return;
  }

  state.selectedPage = pageId;
  renderPageNavigation();
}

/**
 * 让 banner 容器的高度跟随当前页内容变化，避免出现大块空白。
 */
function syncPageStageHeight() {
  if (!elements.pageStage) {
    return;
  }

  const activeView = elements.pageViews.find(
    (view) => view.dataset.page === state.selectedPage,
  );
  if (!activeView) {
    return;
  }

  window.requestAnimationFrame(() => {
    elements.pageStage.style.height = `${activeView.scrollHeight}px`;
  });
}

/**
 * 当当前筛选项已失效时，回退到后端返回的默认筛选项。
 *
 * @returns {string}
 */
function pickPreferredFilterId() {
  if (!state.usageDashboard?.filters) {
    return state.selectedFilterId;
  }

  return (
    state.usageDashboard.filters.find(
      (filter) => filter.id === state.selectedFilterId,
    )?.id ?? "all"
  );
}

/**
 * 读取初始分页，优先跟随 URL hash。
 *
 * @returns {string}
 */
function readInitialPage() {
  return normalizePageId(window.location.hash.slice(1));
}

/**
 * 规范化分页 ID，避免落到不存在的页面。
 *
 * @param {string} pageId 原始分页 ID。
 * @returns {string}
 */
function normalizePageId(pageId) {
  return AVAILABLE_PAGES.has(pageId) ? pageId : "proxy";
}

void main();
