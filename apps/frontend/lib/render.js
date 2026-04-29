import {
  formatAccountKind,
  formatCurrency,
  formatDateTime,
  formatDurationMs,
  formatPercent,
  formatProxyClientKind,
  formatResetCountdown,
  formatTokenCount,
  formatTokenRate,
  formatWindowMeta,
  translateHealth,
} from "./formatters.js";

/**
 * 本文件负责把状态对象投射到 DOM。
 * 页面逻辑会把“拿到的数据”交给这里，渲染函数只关心如何展示。
 */

/**
 * 渲染页面顶部状态。
 *
 * @param {any} status 当前状态摘要。
 * @param {Record<string, Element>} elements DOM 引用集合。
 * @returns {void}
 */
export function renderStatus(status, elements) {
  if (!status) {
    return;
  }

  elements.activeAccountName.textContent =
    status.activeAccountName ?? "未选择账号";
  elements.activeAccountDetail.textContent =
    status.gateway?.activeAccountName
      ? `${status.gateway.activeAccountName} 正在承接本地代理流量`
      : "当前还没有可用的路由账号";
  elements.gatewayBaseUrl.textContent =
    status.gateway?.listenBaseUrl ?? window.location.origin;
  elements.gatewayRoutePath.textContent =
    status.gateway?.responsesPath ?? "/ai-router/api/responses";
  elements.lastRequestAt.textContent = formatDateTime(
    status.gateway?.lastRequestAt ?? null,
  );

  const lastClientLabel = status.gateway?.lastRequestClientLabel ?? null;
  elements.lastRequestDetail.textContent =
    status.gateway?.lastRequestResult
      ? lastClientLabel
        ? `${status.gateway.lastRequestResult} · ${lastClientLabel}`
        : status.gateway.lastRequestResult
      : "还没有代理请求";
  elements.lastRequestModel.textContent =
    status.gateway?.lastRequestModel ?? "等待模型请求";
}

/**
 * 渲染 Codex 代理监控与开关区域。
 *
 * @param {any} codexProxy 当前 Codex 代理状态。
 * @param {Record<string, Element>} elements DOM 引用集合。
 * @param {{
 *   isMutating?: boolean,
 *   desiredEnabled?: boolean | null,
 *   feedback?: string | null,
 *   feedbackTone?: string | null,
 * }=} viewState 前端交互态。
 * @returns {void}
 */
export function renderCodexProxy(codexProxy, elements, viewState = {}) {
  const config = codexProxy?.config ?? null;
  const desiredEnabled =
    typeof viewState.desiredEnabled === "boolean"
      ? viewState.desiredEnabled
      : null;
  const visualEnabled = desiredEnabled ?? (config?.isEnabled === true);

  if (elements.codexProxyToggle) {
    elements.codexProxyToggle.checked = visualEnabled;
    elements.codexProxyToggle.disabled =
      viewState.isMutating === true || !config;
  }

  if (elements.codexProxyToggleHint) {
    elements.codexProxyToggleHint.textContent =
      viewState.isMutating === true
        ? "写入中"
        : visualEnabled
          ? "已接管"
          : "未接管";
  }

  setStatusChip(
    elements.codexProxyConfigBadge,
    config?.isEnabled ? "配置已接管" : "配置未接管",
    config?.isEnabled ? "healthy" : "warning",
  );

  const trafficLabel = codexProxy?.isCodexTrafficRecent
    ? `近 ${codexProxy.recentWindowMinutes} 分钟已检测`
    : config?.isEnabled
      ? `近 ${codexProxy?.recentWindowMinutes ?? 0} 分钟未检测`
      : "等待接管后检测";
  setStatusChip(
    elements.codexProxyTrafficBadge,
    trafficLabel,
    codexProxy?.isCodexTrafficRecent
      ? "healthy"
      : config?.isEnabled
        ? "warning"
        : "neutral",
  );

  const lastProxyClient = codexProxy?.lastProxyClient ?? null;
  const clientLabel = lastProxyClient
    ? `${formatProxyClientKind(lastProxyClient.kind)} · ${lastProxyClient.label}`
    : "暂无代理客户端";
  setStatusChip(
    elements.codexProxyClientBadge,
    clientLabel,
    mapClientBadgeState(lastProxyClient?.kind ?? null),
  );

  setTextContent(elements.codexProxyConfigPath, config?.configPath ?? "--");
  setTextContent(
    elements.codexProxyCurrentProvider,
    config?.currentModelProvider ?? "--",
  );
  setTextContent(
    elements.codexProxyCurrentBaseUrl,
    config?.currentProviderBaseUrl ?? "--",
  );
  setTextContent(
    elements.codexProxyExpectedProvider,
    config?.providerName ?? "--",
  );
  setTextContent(
    elements.codexProxyManagedBaseUrl,
    config?.configuredBaseUrl ?? "--",
  );
  setTextContent(
    elements.codexProxyExpectedBaseUrl,
    config?.expectedBaseUrl ?? "--",
  );
  setTextContent(
    elements.codexProxyLastCodexRequestAt,
    formatDateTime(codexProxy?.lastCodexRequestAt ?? null),
  );
  setTextContent(
    elements.codexProxyLastProxyRequestAt,
    formatDateTime(codexProxy?.lastProxyRequestAt ?? null),
  );

  const diagnostics = buildCodexProxyDiagnostics(codexProxy);
  renderTextList(
    elements.codexProxyDiagnostics,
    diagnostics.length > 0 ? diagnostics : ["当前没有额外诊断。"],
  );

  if (elements.codexProxyFeedback) {
    elements.codexProxyFeedback.textContent =
      viewState.feedback ?? buildDefaultProxyFeedback(codexProxy);
    elements.codexProxyFeedback.dataset.tone =
      viewState.feedbackTone ?? inferFeedbackTone(codexProxy);
  }
}

/**
 * 渲染“需要重启 Codex 才能生效”的确认弹窗。
 *
 * @param {Record<string, Element>} elements DOM 引用集合。
 * @param {{
 *   isOpen: boolean,
 *   isRestarting: boolean,
 *   reason: string | null,
 *   feedback: string | null,
 *   tone: string | null,
 * }} viewState 当前弹窗状态。
 * @returns {void}
 */
export function renderCodexRestartModal(elements, viewState) {
  if (elements.codexRestartModal) {
    elements.codexRestartModal.dataset.open = String(viewState.isOpen === true);
    elements.codexRestartModal.setAttribute(
      "aria-hidden",
      String(viewState.isOpen !== true),
    );
  }

  if (elements.codexRestartMessage) {
    elements.codexRestartMessage.textContent =
      viewState.reason ??
      "配置已写入 ~/.codex/config.toml，需要重启 Codex Desktop 才能生效。";
  }

  if (elements.codexRestartConfirmButton) {
    elements.codexRestartConfirmButton.disabled = viewState.isRestarting === true;
    elements.codexRestartConfirmButton.textContent =
      viewState.isRestarting === true ? "正在重启..." : "立即重启";
  }

  if (elements.codexRestartDismissButton) {
    elements.codexRestartDismissButton.disabled = viewState.isRestarting === true;
  }

  if (elements.codexRestartFeedback) {
    elements.codexRestartFeedback.textContent =
      viewState.feedback ??
      "重启前，当前 Codex 仍会继续使用旧配置。";
    elements.codexRestartFeedback.dataset.tone = viewState.tone ?? "warning";
  }
}

/**
 * 渲染账号切换前的配置改写确认弹窗。
 *
 * @param {Record<string, Element>} elements DOM 引用集合。
 * @param {{
 *   isOpen: boolean,
 *   isSubmitting: boolean,
 *   message: string | null,
 *   feedback: string | null,
 *   tone: string | null,
 * }} viewState 当前弹窗状态。
 * @returns {void}
 */
export function renderAccountSwitchConfirmModal(elements, viewState) {
  if (elements.accountSwitchConfirmModal) {
    elements.accountSwitchConfirmModal.dataset.open = String(viewState.isOpen === true);
    elements.accountSwitchConfirmModal.setAttribute(
      "aria-hidden",
      String(viewState.isOpen !== true),
    );
  }

  if (elements.accountSwitchConfirmMessage) {
    elements.accountSwitchConfirmMessage.textContent =
      viewState.message ??
      "切换到该账号会先改写 ~/.codex/config.toml，随后需要重启 Codex Desktop 才能生效。是否继续？";
  }

  if (elements.accountSwitchConfirmContinueButton) {
    elements.accountSwitchConfirmContinueButton.disabled =
      viewState.isSubmitting === true;
    elements.accountSwitchConfirmContinueButton.textContent =
      viewState.isSubmitting === true ? "正在切换..." : "继续切换";
  }

  if (elements.accountSwitchConfirmCancelButton) {
    elements.accountSwitchConfirmCancelButton.disabled =
      viewState.isSubmitting === true;
  }

  if (elements.accountSwitchConfirmFeedback) {
    elements.accountSwitchConfirmFeedback.textContent =
      viewState.feedback ??
      "只有你确认继续后，系统才会真正写入 ~/.codex/config.toml。";
    elements.accountSwitchConfirmFeedback.dataset.tone = viewState.tone ?? "warning";
  }
}

/**
 * 渲染筛选下拉框。
 *
 * @param {any} usageDashboard 当前统计摘要。
 * @param {string} selectedFilterId 当前选中的筛选项。
 * @param {HTMLSelectElement} select 筛选下拉框。
 * @returns {void}
 */
export function renderFilterOptions(usageDashboard, selectedFilterId, select) {
  if (!usageDashboard?.filters) {
    return;
  }

  const nextOptions = usageDashboard.filters
    .map(
      (filter) =>
        `<option value="${escapeHtml(filter.id)}">${escapeHtml(filter.label)}</option>`,
    )
    .join("");
  if (select.innerHTML !== nextOptions) {
    select.innerHTML = nextOptions;
  }

  select.value = selectedFilterId;
}

/**
 * 渲染统计窗口面板。
 *
 * @param {any} usageDashboard 当前统计摘要。
 * @param {Record<string, Element>} elements DOM 引用集合。
 * @returns {void}
 */
export function renderUsagePanels(usageDashboard, elements) {
  elements.usagePanels.innerHTML = "";
  if (!usageDashboard) {
    return;
  }

  for (const windowSummary of [
    usageDashboard.today,
    usageDashboard.last5Hours,
    usageDashboard.last7Days,
    usageDashboard.cumulative,
  ]) {
    const fragment = elements.usageWindowTemplate.content.cloneNode(true);
    fragment.querySelector(".usage-window-title").textContent = windowSummary.label;
    fragment.querySelector(".usage-metric-input").textContent = formatTokenCount(
      windowSummary.totals.inputTokens,
    );
    fragment.querySelector(".usage-metric-cache").textContent = formatTokenCount(
      windowSummary.totals.cachedInputTokens,
    );
    fragment.querySelector(".usage-metric-output").textContent = formatTokenCount(
      windowSummary.totals.outputTokens,
    );
    fragment.querySelector(".usage-metric-total").textContent = formatTokenCount(
      windowSummary.totals.totalTokens,
    );
    fragment.querySelector(".usage-metric-rate").textContent = formatTokenRate(
      windowSummary.totals.tokenRatePerSecond,
    );
    fragment.querySelector(".usage-metric-first-output").textContent =
      formatDurationMs(windowSummary.totals.averageFirstOutputLatencyMs);
    fragment.querySelector(".usage-metric-cost").textContent = formatCurrency(
      windowSummary.totals.estimatedCostUsd,
    );
    fragment.querySelector(".usage-window-meta").textContent = formatWindowMeta(
      windowSummary,
    );
    elements.usagePanels.appendChild(fragment);
  }
}

/**
 * 渲染账号路由列表。
 *
 * @param {any[]} accounts 当前账号卡片数组。
 * @param {Record<string, Element>} elements DOM 引用集合。
 * @param {(accountId: string) => Promise<void>} onActivate 激活账号的动作。
 * @param {(accountId: string) => Promise<void>} onEdit 编辑账号的动作。
 * @returns {void}
 */
export function renderAccountRows(accounts, elements, onActivate, onEdit) {
  elements.accountsList.innerHTML = "";

  if (accounts.length === 0) {
    elements.accountsList.innerHTML =
      '<div class="empty-state">还没有配置任何账号。</div>';
    return;
  }

  for (const account of accounts) {
    const fragment = elements.accountRowTemplate.content.cloneNode(true);
    const root = fragment.querySelector(".account-row");
    const activateButton = fragment.querySelector(".account-activate");
    const editButton = fragment.querySelector(".account-edit");
    const health = fragment.querySelector(".health-pill");
    const primaryUsage = account.officialUsage?.primary ?? null;
    const secondaryUsage = account.officialUsage?.secondary ?? null;
    const thirdPartyQuotaSlots = pickThirdPartyQuotaSlots(
      account.thirdPartyBudgetSnapshot,
    );
    const primaryQuota = thirdPartyQuotaSlots[0] ?? null;
    const secondaryQuota = thirdPartyQuotaSlots[1] ?? null;

    root.dataset.active = account.isActive ? "true" : "false";
    fragment.querySelector(".account-name").textContent = account.name;
    fragment.querySelector(".account-kind").textContent = formatAccountKind(account.kind);
    fragment.querySelector(".account-status").textContent = account.statusLabel;
    fragment.querySelector(".account-diagnostics").textContent =
      buildAccountDetailText(account);
    fragment.querySelector(".account-total-tokens").textContent = formatTokenCount(
      account.cumulativeUsage.totalTokens,
    );
    fragment.querySelector(".account-estimated-cost").textContent = formatCurrency(
      account.cumulativeUsage.estimatedCostUsd,
    );
    fragment.querySelector(".account-short-window-label").textContent =
      primaryQuota?.label ??
      (account.kind === "official" ? "5 小时剩余" : "额度剩余");
    fragment.querySelector(".account-weekly-window-label").textContent =
      secondaryQuota?.label ??
      (account.kind === "official" ? "近一周剩余" : "更多额度");
    fragment.querySelector(".account-primary-remaining").textContent =
      account.kind === "third_party"
        ? formatQuotaRemaining(primaryQuota)
        : formatPercent(primaryUsage?.remainingPercent ?? null);
    fragment.querySelector(".account-primary-reset").textContent =
      account.kind === "third_party"
        ? formatQuotaMeta(primaryQuota)
        : formatResetCountdown(primaryUsage?.resetsAt ?? null);
    fragment.querySelector(".account-secondary-remaining").textContent =
      account.kind === "third_party"
        ? formatQuotaRemaining(secondaryQuota)
        : formatPercent(secondaryUsage?.remainingPercent ?? null);
    fragment.querySelector(".account-secondary-reset").textContent =
      account.kind === "third_party"
        ? formatQuotaMeta(secondaryQuota)
        : formatResetCountdown(secondaryUsage?.resetsAt ?? null);

    health.textContent = translateHealth(account.health);
    health.dataset.health = account.health;

    activateButton.disabled = account.isActive;
    activateButton.textContent = account.isActive ? "当前路由" : "切到这里";
    activateButton.addEventListener("click", () => onActivate(account.id));

    if (editButton) {
      const isEditable = account.id !== "current-official";
      editButton.disabled = !isEditable;
      editButton.textContent = isEditable ? "编辑" : "内置账号";
      if (isEditable) {
        editButton.addEventListener("click", () => onEdit(account.id));
      }
    }

    elements.accountsList.appendChild(fragment);
  }
}

/**
 * 渲染新增账号弹窗，以及表单的提交态与反馈文案。
 *
 * @param {Record<string, Element>} elements DOM 引用集合。
 * @param {{
 *   isOpen: boolean,
 *   mode: "create" | "edit",
 *   selectedKind: "official" | "third_party",
 *   official: { pending: boolean, feedback: string, tone: string },
 *   thirdParty: {
 *     pending: boolean,
 *     feedback: string,
 *     tone: string,
 *     awaitingConfirmation?: boolean,
 *   },
 * }} viewState 表单视图状态。
 * @returns {void}
 */
export function renderAccountCreationForms(elements, viewState) {
  if (elements.accountCreateModal) {
    elements.accountCreateModal.dataset.open = String(viewState.isOpen === true);
    elements.accountCreateModal.setAttribute(
      "aria-hidden",
      String(viewState.isOpen !== true),
    );
  }

  if (elements.accountCreateCloseButton) {
    elements.accountCreateCloseButton.disabled =
      viewState.official.pending === true || viewState.thirdParty.pending === true;
  }

  if (elements.accountCreateModalTitle) {
    elements.accountCreateModalTitle.textContent =
      viewState.mode === "edit" ? "编辑账号" : "新增账号";
  }

  if (elements.accountCreateModalEyebrow) {
    elements.accountCreateModalEyebrow.textContent =
      viewState.mode === "edit" ? "Edit Account" : "Create Account";
  }

  if (elements.accountCreateModalDescription) {
    elements.accountCreateModalDescription.textContent =
      viewState.mode === "edit"
        ? "仅允许修改该账号已有类型下的配置。若当前账号正承接本地代理，保存后可能需要重启 Codex Desktop 才能生效。"
        : "先选择账号类型，再填写对应信息。保存前都会先做一次必要校验，避免把无效账号写进路由配置。";
  }

  for (const tab of elements.accountCreationKindTabs ?? []) {
    const isActive = tab.dataset.accountKindTarget === viewState.selectedKind;
    tab.dataset.active = String(isActive);
    tab.setAttribute("aria-selected", String(isActive));
    tab.disabled = viewState.mode === "edit" && !isActive;
  }

  for (const panel of elements.accountCreationPanels ?? []) {
    const isActive = panel.dataset.accountKindPanel === viewState.selectedKind;
    panel.dataset.active = String(isActive);
    panel.setAttribute("aria-hidden", String(!isActive));
  }

  renderAccountCreationPanel(
    elements.officialAccountSubmit,
    [
      elements.officialAccountNameInput,
      elements.officialAccountSessionInput,
    ],
    elements.officialAccountFeedback,
    viewState.official,
    viewState.mode === "edit" ? "保存官方修改" : "保存官方账号",
    viewState.mode === "edit" ? "正在更新官方账号..." : "正在校验官方账号...",
  );

  renderAccountCreationPanel(
    elements.thirdPartyAccountSubmit,
    [
      elements.thirdPartyAccountNameInput,
      elements.thirdPartyAccountApiKeyInput,
      elements.thirdPartyAccountBaseUrlInput,
      elements.thirdPartyAccountDefaultModelInput,
      elements.thirdPartyAccountPresetInput,
      elements.thirdPartyAccountApiProtocolInput,
      elements.thirdPartyAccountInputPriceInput,
      elements.thirdPartyAccountOutputPriceInput,
      elements.thirdPartyAccountCachePriceInput,
      elements.thirdPartyAccountWeeklyBudgetInput,
      elements.thirdPartyAccountShortWindowBudgetInput,
      elements.thirdPartyAccountShortWindowKindInput,
      elements.thirdPartyAccountTotalBudgetInput,
      elements.thirdPartyAccountMonthlyTokenLimitInput,
      elements.thirdPartyAccountWsRequiredInput,
    ],
    elements.thirdPartyAccountFeedback,
    viewState.thirdParty,
    viewState.thirdParty.awaitingConfirmation === true
      ? viewState.mode === "edit"
        ? "确认仍然保存"
        : "确认保存第三方账号"
      : viewState.mode === "edit"
        ? "保存第三方修改"
        : "保存第三方账号",
    viewState.mode === "edit" ? "正在更新第三方账号..." : "正在测试第三方账号...",
  );
}

/**
 * 渲染最近请求记录。
 *
 * @param {any[]} events 最近事件数组。
 * @param {Record<string, Element>} elements DOM 引用集合。
 * @returns {void}
 */
export function renderUsageEvents(events, elements) {
  elements.eventsList.innerHTML = "";

  if (!events.length) {
    elements.eventsList.innerHTML =
      '<div class="empty-state">当前筛选项下还没有代理请求记录。</div>';
    return;
  }

  for (const event of events) {
    const fragment = elements.eventRowTemplate.content.cloneNode(true);
    fragment.querySelector(".event-model").textContent = event.model;
    fragment.querySelector(".event-account").textContent = `${event.accountName} · ${formatAccountKind(event.accountKind)}`;
    fragment.querySelector(".event-created-at").textContent = formatDateTime(
      event.createdAt,
    );
    fragment.querySelector(".event-input-tokens").textContent = formatTokenCount(
      event.inputTokens,
    );
    fragment.querySelector(".event-cache-tokens").textContent = formatTokenCount(
      event.cachedInputTokens,
    );
    fragment.querySelector(".event-output-tokens").textContent = formatTokenCount(
      event.outputTokens,
    );
    fragment.querySelector(".event-total-tokens").textContent = formatTokenCount(
      event.totalTokens,
    );
    fragment.querySelector(".event-token-rate").textContent = formatTokenRate(
      event.tokenRatePerSecond ?? calculateFallbackTokenRate(event),
    );
    fragment.querySelector(".event-first-output-latency").textContent =
      formatDurationMs(event.firstOutputLatencyMs ?? null);
    fragment.querySelector(".event-cost").textContent = formatCurrency(
      event.estimatedCostUsd,
    );
    fragment.querySelector(".event-status").textContent = event.status;
    elements.eventsList.appendChild(fragment);
  }
}

/**
 * 为旧版审计记录补算输出 token 速率。
 *
 * @param {any} event 已落盘的代理请求事件。
 * @returns {number} token/秒；缺少有效耗时时返回 0。
 */
function calculateFallbackTokenRate(event) {
  const outputTokens = Number(event?.outputTokens ?? 0);
  const outputDurationMs = Number(event?.outputDurationMs ?? 0);
  const latencyMs = Number(event?.latencyMs ?? 0);
  const rateDurationMs = outputDurationMs > 0 ? outputDurationMs : latencyMs;
  if (
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(rateDurationMs) ||
    rateDurationMs <= 0
  ) {
    return 0;
  }

  return Math.max(outputTokens, 0) / (rateDurationMs / 1000);
}

/**
 * 为避免 option 文本注入，手动转义 HTML。
 *
 * @param {string} value 原始文本。
 * @returns {string}
 */
function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * 将一段纯文本写入指定节点。
 *
 * @param {Element | null | undefined} element 目标节点。
 * @param {string} value 文本值。
 * @returns {void}
 */
function setTextContent(element, value) {
  if (!element) {
    return;
  }

  element.textContent = value;
}

/**
 * 渲染统一样式的状态胶囊。
 *
 * @param {Element | null | undefined} element 目标节点。
 * @param {string} text 展示文本。
 * @param {string} state 状态名。
 * @returns {void}
 */
function setStatusChip(element, text, state) {
  if (!element) {
    return;
  }

  element.textContent = text;
  element.dataset.state = state;
}

/**
 * 渲染一组纯文本列表项。
 *
 * @param {Element | null | undefined} container 列表容器。
 * @param {string[]} items 列表文本。
 * @returns {void}
 */
function renderTextList(container, items) {
  if (!container) {
    return;
  }

  container.innerHTML = items
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
}

/**
 * 把代理客户端类型映射成 UI 胶囊颜色。
 *
 * @param {string | null} kind 客户端类型。
 * @returns {string}
 */
function mapClientBadgeState(kind) {
  if (kind === "codex") {
    return "healthy";
  }

  if (kind === "browser") {
    return "warning";
  }

  return "neutral";
}

/**
 * 组合 Codex 代理监控需要展示的诊断文本。
 *
 * @param {any} codexProxy 当前 Codex 代理状态。
 * @returns {string[]}
 */
function buildCodexProxyDiagnostics(codexProxy) {
  const diagnostics = [...(codexProxy?.config?.diagnostics ?? [])];

  if (codexProxy?.config?.isEnabled && !codexProxy?.isCodexTrafficRecent) {
    diagnostics.push("配置已经切到本地代理，但最近还没有识别到 Codex 请求头。");
  }

  if (codexProxy?.restartRequired && codexProxy?.restartReason) {
    diagnostics.push(codexProxy.restartReason);
  }

  return diagnostics;
}

/**
 * 为代理开关生成默认提示文案。
 *
 * @param {any} codexProxy 当前 Codex 代理状态。
 * @returns {string}
 */
function buildDefaultProxyFeedback(codexProxy) {
  if (!codexProxy?.config) {
    return "等待后端返回 Codex 代理状态。";
  }

  if (codexProxy.restartRequired && codexProxy.restartReason) {
    return codexProxy.restartReason;
  }

  if (codexProxy.config.isEnabled && codexProxy.isCodexTrafficRecent) {
    return "配置已接管，最近也检测到了 Codex 请求经过本地代理。";
  }

  if (codexProxy.config.isEnabled) {
    return "配置已接管。下一次新的 Codex 请求会开始经过这个本地代理。";
  }

  return `打开开关后，会把 model_provider 切到 ${codexProxy.config.providerName}。`;
}

/**
 * 根据当前代理状态推断反馈区颜色。
 *
 * @param {any} codexProxy 当前 Codex 代理状态。
 * @returns {string}
 */
function inferFeedbackTone(codexProxy) {
  if (codexProxy?.restartRequired) {
    return "warning";
  }

  if (codexProxy?.config?.isEnabled && codexProxy?.isCodexTrafficRecent) {
    return "success";
  }

  if (codexProxy?.config?.isEnabled) {
    return "warning";
  }

  return "neutral";
}

/**
 * 生成账号主信息区域的说明文案。
 *
 * @param {any} account 当前账号卡片对象。
 * @returns {string}
 */
function buildAccountDetailText(account) {
  if (account.rawDiagnostics[0]) {
    return account.rawDiagnostics[0];
  }

  if (account.lastCheckedAt) {
    return `最近检查：${formatDateTime(account.lastCheckedAt)}`;
  }

  return "等待首次检查。";
}

/**
 * 格式化第三方额度窗口的剩余额度。
 *
 * @param {any} quotaWindow 单个额度窗口。
 * @returns {string}
 */
function formatQuotaRemaining(quotaWindow) {
  if (!quotaWindow) {
    return "--";
  }

  if (isTokenQuotaWindow(quotaWindow)) {
    return formatTokenCount(quotaWindow.remainingTokens ?? 0);
  }

  return formatCurrency(quotaWindow.remainingUsd ?? 0);
}

/**
 * 格式化第三方额度窗口的说明文案。
 *
 * @param {any} quotaWindow 单个额度窗口。
 * @returns {string}
 */
function formatQuotaMeta(quotaWindow) {
  if (!quotaWindow) {
    return "未设置额度";
  }

  const resetText = quotaWindow.resetsAt
    ? formatResetCountdown(quotaWindow.resetsAt)
    : "不重置";

  if (isTokenQuotaWindow(quotaWindow)) {
    return `已用 ${formatTokenCount(quotaWindow.usedTokens)} / ${formatTokenCount(quotaWindow.limitTokens)} · ${resetText}`;
  }

  return `已用 ${formatCurrency(quotaWindow.spentUsd)} / ${formatCurrency(quotaWindow.limitUsd)} · ${resetText}`;
}

/**
 * 从第三方额度摘要中挑出账号列表优先展示的两个窗口。
 * 列表只有两个额度列，因此按既有短周期/周额度优先，其次展示新增的总金额和 token 额度。
 *
 * @param {any} snapshot 第三方额度摘要。
 * @returns {any[]} 最多两个额度窗口。
 */
function pickThirdPartyQuotaSlots(snapshot) {
  if (!snapshot) {
    return [];
  }

  return [
    snapshot.shortWindow,
    snapshot.weeklyWindow,
    snapshot.totalBudget,
    snapshot.tokenWindow,
  ].filter(Boolean).slice(0, 2);
}

/**
 * 判断一个额度摘要是否使用 token 作为扣减单位。
 *
 * @param {any} quotaWindow 单个额度窗口。
 * @returns {boolean}
 */
function isTokenQuotaWindow(quotaWindow) {
  return quotaWindow && "limitTokens" in quotaWindow;
}

/**
 * 渲染单个新增账号面板的按钮、输入禁用态与反馈文案。
 *
 * @param {HTMLButtonElement | null | undefined} submitButton 提交按钮。
 * @param {(HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null | undefined)[]} fields 输入控件。
 * @param {HTMLElement | null | undefined} feedbackElement 反馈节点。
 * @param {{ pending: boolean, feedback: string, tone: string }} state 当前面板状态。
 * @param {string} idleLabel 空闲时按钮文案。
 * @param {string} pendingLabel 提交中按钮文案。
 * @returns {void}
 */
function renderAccountCreationPanel(
  submitButton,
  fields,
  feedbackElement,
  state,
  idleLabel,
  pendingLabel,
) {
  if (submitButton) {
    submitButton.disabled = state.pending;
    submitButton.textContent = state.pending ? pendingLabel : idleLabel;
  }

  for (const field of fields) {
    if (field) {
      field.disabled = state.pending;
    }
  }

  if (feedbackElement) {
    feedbackElement.textContent = state.feedback;
    feedbackElement.dataset.tone = state.tone;
  }
}
