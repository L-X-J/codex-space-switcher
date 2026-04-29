import {
  activateAccount,
  createAccount,
  getEditableAccount,
  getAccounts,
  getStatus,
  previewActivateAccount,
  getUsageDashboard,
  getUsageEvents,
  refreshDashboard,
  restartCodexApp,
  setCodexProxyEnabled,
  updateAccount,
} from "./lib/api.js";
import {
  renderAccountCreationForms,
  renderAccountSwitchConfirmModal,
  renderAccountRows,
  renderCodexRestartModal,
  renderCodexProxy,
  renderFilterOptions,
  renderStatus,
  renderUsageEvents,
  renderUsagePanels,
} from "./lib/render.js";

const AVAILABLE_PAGES = new Set(["proxy", "accounts", "usage"]);
const ACCOUNT_CREATION_TONES = {
  neutral: "neutral",
  success: "success",
  error: "error",
};
const ACCOUNT_CREATION_DEFAULT_FEEDBACK = {
  official: "只会保存路由所需字段，不会额外保存 sessionToken。",
  thirdParty: "保存前会先做一次连通性测试。",
};
const THIRD_PARTY_VALIDATION_CONFIRMATION_CODE =
  "third_party_validation_confirmation_required";
const THIRD_PARTY_PRESETS = {
  "mimo-token-cn": {
    name: "MiMo Token Plan CN",
    apiBaseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    apiProtocol: "chat_completions",
    defaultModel: "mimo-v2.5-pro",
    apiKeyPlaceholder: "tp-xxxxx",
  },
  "mimo-token-sgp": {
    name: "MiMo Token Plan SGP",
    apiBaseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    apiProtocol: "chat_completions",
    defaultModel: "mimo-v2.5-pro",
    apiKeyPlaceholder: "tp-xxxxx",
  },
  "mimo-token-ams": {
    name: "MiMo Token Plan AMS",
    apiBaseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
    apiProtocol: "chat_completions",
    defaultModel: "mimo-v2.5-pro",
    apiKeyPlaceholder: "tp-xxxxx",
  },
};

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
  accountCreation: {
    isOpen: false,
    mode: "create",
    targetAccountId: null,
    selectedKind: "official",
    official: {
      pending: false,
      feedback: ACCOUNT_CREATION_DEFAULT_FEEDBACK.official,
      tone: ACCOUNT_CREATION_TONES.neutral,
    },
    thirdParty: {
      pending: false,
      feedback: ACCOUNT_CREATION_DEFAULT_FEEDBACK.thirdParty,
      tone: ACCOUNT_CREATION_TONES.neutral,
      awaitingConfirmation: false,
      confirmFingerprint: null,
    },
  },
  codexRestart: {
    isOpen: false,
    isRestarting: false,
    canRestart: true,
    reason: null,
    feedback: null,
    tone: "warning",
  },
  accountSwitchConfirm: {
    isOpen: false,
    isSubmitting: false,
    targetAccountId: null,
    message: null,
    feedback: null,
    tone: "warning",
  },
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
  accountCreateOpenButton: document.querySelector("#accountCreateOpenButton"),
  accountCreateModal: document.querySelector("#accountCreateModal"),
  accountCreateModalEyebrow: document.querySelector("#accountCreateModalEyebrow"),
  accountCreateModalTitle: document.querySelector("#accountCreateModalTitle"),
  accountCreateModalDescription: document.querySelector(
    "#accountCreateModalDescription",
  ),
  accountCreateCloseButton: document.querySelector("#accountCreateCloseButton"),
  accountCreationKindTabs: Array.from(
    document.querySelectorAll("[data-account-kind-target]"),
  ),
  accountCreationPanels: Array.from(
    document.querySelectorAll("[data-account-kind-panel]"),
  ),
  officialAccountForm: document.querySelector("#officialAccountForm"),
  officialAccountNameInput: document.querySelector("#officialAccountNameInput"),
  officialAccountSessionInput: document.querySelector("#officialAccountSessionInput"),
  officialAccountSubmit: document.querySelector("#officialAccountSubmit"),
  officialAccountFeedback: document.querySelector("#officialAccountFeedback"),
  thirdPartyAccountForm: document.querySelector("#thirdPartyAccountForm"),
  thirdPartyAccountPresetInput: document.querySelector("#thirdPartyAccountPresetInput"),
  thirdPartyAccountApiProtocolInput: document.querySelector("#thirdPartyAccountApiProtocolInput"),
  thirdPartyAccountNameInput: document.querySelector("#thirdPartyAccountNameInput"),
  thirdPartyAccountApiKeyInput: document.querySelector("#thirdPartyAccountApiKeyInput"),
  thirdPartyAccountBaseUrlInput: document.querySelector("#thirdPartyAccountBaseUrlInput"),
  thirdPartyAccountDefaultModelInput: document.querySelector("#thirdPartyAccountDefaultModelInput"),
  thirdPartyAccountInputPriceInput: document.querySelector("#thirdPartyAccountInputPriceInput"),
  thirdPartyAccountOutputPriceInput: document.querySelector("#thirdPartyAccountOutputPriceInput"),
  thirdPartyAccountCachePriceInput: document.querySelector("#thirdPartyAccountCachePriceInput"),
  thirdPartyAccountWeeklyBudgetInput: document.querySelector("#thirdPartyAccountWeeklyBudgetInput"),
  thirdPartyAccountShortWindowBudgetInput: document.querySelector("#thirdPartyAccountShortWindowBudgetInput"),
  thirdPartyAccountShortWindowKindInput: document.querySelector("#thirdPartyAccountShortWindowKindInput"),
  thirdPartyAccountTotalBudgetInput: document.querySelector("#thirdPartyAccountTotalBudgetInput"),
  thirdPartyAccountMonthlyTokenLimitInput: document.querySelector("#thirdPartyAccountMonthlyTokenLimitInput"),
  thirdPartyAccountWsRequiredInput: document.querySelector("#thirdPartyAccountWsRequiredInput"),
  thirdPartyAccountSubmit: document.querySelector("#thirdPartyAccountSubmit"),
  thirdPartyAccountFeedback: document.querySelector("#thirdPartyAccountFeedback"),
  codexRestartModal: document.querySelector("#codexRestartModal"),
  codexRestartMessage: document.querySelector("#codexRestartModalMessage"),
  codexRestartConfirmButton: document.querySelector("#codexRestartConfirmButton"),
  codexRestartDismissButton: document.querySelector("#codexRestartDismissButton"),
  codexRestartFeedback: document.querySelector("#codexRestartFeedback"),
  accountSwitchConfirmModal: document.querySelector("#accountSwitchConfirmModal"),
  accountSwitchConfirmMessage: document.querySelector("#accountSwitchConfirmMessage"),
  accountSwitchConfirmContinueButton: document.querySelector("#accountSwitchConfirmContinueButton"),
  accountSwitchConfirmCancelButton: document.querySelector("#accountSwitchConfirmCancelButton"),
  accountSwitchConfirmFeedback: document.querySelector("#accountSwitchConfirmFeedback"),
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
  bindAccountForms();
  bindCodexRestartModal();
  bindAccountSwitchConfirmModal();
  elements.usageFilterSelect?.addEventListener("change", async (event) => {
    state.selectedFilterId = event.currentTarget.value;
    await refreshUsage();
  });
  window.addEventListener("hashchange", handleHashChange);
  window.addEventListener("resize", syncPageStageHeight);
  window.addEventListener("keydown", handleWindowKeydown);

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
    const result = await setCodexProxyEnabled(nextEnabled);
    await refreshAll();
    state.codexProxyFeedback = result.restartRequired
      ? result.restartReason
      : nextEnabled
        ? "已把 Codex 配置切到本地代理。"
        : "已恢复到切换前的 provider。";
    state.codexProxyFeedbackTone = result.restartRequired ? "warning" : "success";
    if (result.restartRequired) {
      openCodexRestartModal(result.restartReason);
    }
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
  const preview = await previewActivateAccount(accountId);
  if (preview.requiresConfigRewrite) {
    openAccountSwitchConfirmModal(accountId, preview.message);
    return;
  }

  await performAccountActivation(accountId);
}

/**
 * 打开已有账号的编辑弹窗。
 *
 * @param {string} accountId 目标账号 ID。
 * @returns {Promise<void>}
 */
async function handleEditAccount(accountId) {
  resetAccountCreationFeedback();

  try {
    const detail = await getEditableAccount(accountId);
    state.accountCreation.isOpen = true;
    state.accountCreation.mode = "edit";
    state.accountCreation.targetAccountId = accountId;
    state.accountCreation.selectedKind = detail.kind;
    fillAccountCreationForm(detail);
    renderAccountCreation();
    focusActiveAccountCreationField();
  } catch (error) {
    closeAccountCreationModal();
    state.codexProxyFeedback =
      error instanceof Error ? error.message : String(error);
    state.codexProxyFeedbackTone = "error";
    renderProxy();
  }
}

/**
 * 绑定“新增账号”表单。
 */
function bindAccountForms() {
  elements.accountCreateOpenButton?.addEventListener("click", () => {
    openAccountCreationModal("official");
  });
  elements.accountCreateCloseButton?.addEventListener("click", closeAccountCreationModal);
  elements.accountCreateModal?.addEventListener("click", handleAccountModalBackdropClick);

  for (const tab of elements.accountCreationKindTabs) {
    tab.addEventListener("click", () => {
      const nextKind = tab.dataset.accountKindTarget;
      if (!nextKind) {
        return;
      }

      setAccountCreationKind(nextKind);
    });
  }

  elements.officialAccountForm?.addEventListener("submit", handleOfficialAccountCreate);
  elements.thirdPartyAccountForm?.addEventListener(
    "submit",
    handleThirdPartyAccountCreate,
  );
  elements.thirdPartyAccountPresetInput?.addEventListener(
    "change",
    handleThirdPartyPresetChange,
  );
  elements.thirdPartyAccountApiProtocolInput?.addEventListener(
    "change",
    handleThirdPartyProtocolChange,
  );

  for (const field of [
    elements.thirdPartyAccountPresetInput,
    elements.thirdPartyAccountApiProtocolInput,
    elements.thirdPartyAccountNameInput,
    elements.thirdPartyAccountApiKeyInput,
    elements.thirdPartyAccountBaseUrlInput,
    elements.thirdPartyAccountDefaultModelInput,
    elements.thirdPartyAccountInputPriceInput,
    elements.thirdPartyAccountOutputPriceInput,
    elements.thirdPartyAccountCachePriceInput,
    elements.thirdPartyAccountWeeklyBudgetInput,
    elements.thirdPartyAccountShortWindowBudgetInput,
    elements.thirdPartyAccountShortWindowKindInput,
    elements.thirdPartyAccountTotalBudgetInput,
    elements.thirdPartyAccountMonthlyTokenLimitInput,
    elements.thirdPartyAccountWsRequiredInput,
  ]) {
    field?.addEventListener("input", clearThirdPartyValidationConfirmation);
    field?.addEventListener("change", clearThirdPartyValidationConfirmation);
  }
}

/**
 * 绑定“重启 Codex 生效”弹窗。
 */
function bindCodexRestartModal() {
  elements.codexRestartConfirmButton?.addEventListener("click", handleCodexRestartConfirm);
  elements.codexRestartDismissButton?.addEventListener("click", closeCodexRestartModal);
  elements.codexRestartModal?.addEventListener("click", (event) => {
    if (event.target !== elements.codexRestartModal) {
      return;
    }

    closeCodexRestartModal();
  });
}

/**
 * 绑定“账号切换前确认”弹窗。
 */
function bindAccountSwitchConfirmModal() {
  elements.accountSwitchConfirmContinueButton?.addEventListener(
    "click",
    handleAccountSwitchConfirmContinue,
  );
  elements.accountSwitchConfirmCancelButton?.addEventListener(
    "click",
    closeAccountSwitchConfirmModal,
  );
  elements.accountSwitchConfirmModal?.addEventListener("click", (event) => {
    if (event.target !== elements.accountSwitchConfirmModal) {
      return;
    }

    closeAccountSwitchConfirmModal();
  });
}

/**
 * 提交官方账号新增请求。
 *
 * @param {SubmitEvent} event 表单事件。
 * @returns {Promise<void>}
 */
async function handleOfficialAccountCreate(event) {
  event.preventDefault();
  state.accountCreation.selectedKind = "official";
  state.accountCreation.official.pending = true;
  state.accountCreation.official.feedback =
    state.accountCreation.mode === "edit"
      ? "正在校验并更新官方账号..."
      : "正在校验官方账号...";
  state.accountCreation.official.tone = ACCOUNT_CREATION_TONES.neutral;
  renderAccountCreation();

  try {
    const payload = {
      kind: "official",
      name: elements.officialAccountNameInput?.value ?? "",
      sessionJson: elements.officialAccountSessionInput?.value ?? "",
    };
    const result =
      state.accountCreation.mode === "edit" &&
      state.accountCreation.targetAccountId
        ? await updateAccount(state.accountCreation.targetAccountId, payload)
        : await createAccount(payload);
    if (elements.officialAccountForm) {
      elements.officialAccountForm.reset();
    }
    state.accountCreation.official.feedback = result.message;
    state.accountCreation.official.tone = ACCOUNT_CREATION_TONES.success;
    await refreshAll();
    if (result.codexConfig?.restartRequired) {
      openCodexRestartModal(result.codexConfig.restartReason);
    }
    if (state.accountCreation.mode === "edit") {
      closeAccountCreationModal();
    }
  } catch (error) {
    state.accountCreation.official.feedback =
      error instanceof Error ? error.message : String(error);
    state.accountCreation.official.tone = ACCOUNT_CREATION_TONES.error;
  } finally {
    state.accountCreation.official.pending = false;
    renderAccountCreation();
  }
}

/**
 * 提交第三方账号新增请求。
 *
 * @param {SubmitEvent} event 表单事件。
 * @returns {Promise<void>}
 */
async function handleThirdPartyAccountCreate(event) {
  event.preventDefault();
  state.accountCreation.selectedKind = "third_party";
  state.accountCreation.thirdParty.pending = true;
  state.accountCreation.thirdParty.feedback =
    state.accountCreation.mode === "edit"
      ? "正在测试并更新第三方账号..."
      : "正在测试第三方账号...";
  state.accountCreation.thirdParty.tone = ACCOUNT_CREATION_TONES.neutral;
  renderAccountCreation();

  try {
    const payload = buildThirdPartyAccountPayload();
    const payloadFingerprint = buildThirdPartyPayloadFingerprint(payload);
    payload.skipConnectivityCheck =
      shouldSkipThirdPartyConnectivityCheck(payloadFingerprint);

    const result =
      state.accountCreation.mode === "edit" &&
      state.accountCreation.targetAccountId
        ? await updateAccount(state.accountCreation.targetAccountId, payload)
        : await createAccount(payload);
    clearThirdPartyValidationConfirmation();
    if (elements.thirdPartyAccountForm) {
      elements.thirdPartyAccountForm.reset();
    }
    state.accountCreation.thirdParty.feedback = result.message;
    state.accountCreation.thirdParty.tone = ACCOUNT_CREATION_TONES.success;
    await refreshAll();
    if (result.codexConfig?.restartRequired) {
      openCodexRestartModal(result.codexConfig.restartReason);
    }
    if (state.accountCreation.mode === "edit") {
      closeAccountCreationModal();
    }
  } catch (error) {
    if (isThirdPartyValidationConfirmationError(error)) {
      armThirdPartyValidationConfirmation(
        buildThirdPartyPayloadFingerprint(buildThirdPartyAccountPayload()),
        error.message,
      );
    } else {
      clearThirdPartyValidationConfirmation();
      state.accountCreation.thirdParty.feedback =
        error instanceof Error ? error.message : String(error);
      state.accountCreation.thirdParty.tone = ACCOUNT_CREATION_TONES.error;
    }
  } finally {
    state.accountCreation.thirdParty.pending = false;
    renderAccountCreation();
  }
}

/**
 * 读取第三方账号表单，生成一次提交所需的请求体。
 *
 * @returns {any}
 */
function buildThirdPartyAccountPayload() {
  const inputPrice = readOptionalNumber(
    elements.thirdPartyAccountInputPriceInput?.value,
  );
  const outputPrice = readOptionalNumber(
    elements.thirdPartyAccountOutputPriceInput?.value,
  );
  const cachePrice = readOptionalNumber(
    elements.thirdPartyAccountCachePriceInput?.value,
  );
  const weeklyBudgetUsd = readOptionalNumber(
    elements.thirdPartyAccountWeeklyBudgetInput?.value,
  );
  const shortWindowBudgetUsd = readOptionalNumber(
    elements.thirdPartyAccountShortWindowBudgetInput?.value,
  );
  const totalBudgetUsd = readOptionalNumber(
    elements.thirdPartyAccountTotalBudgetInput?.value,
  );
  const monthlyTokenLimit = readOptionalNumber(
    elements.thirdPartyAccountMonthlyTokenLimitInput?.value,
  );

  const billingRule = {};
  if (
    inputPrice !== undefined ||
    outputPrice !== undefined ||
    cachePrice !== undefined
  ) {
    billingRule.pricing = {
      inputPerMillionUsd: inputPrice,
      outputPerMillionUsd: outputPrice,
      cachedInputPerMillionUsd: cachePrice,
    };
  }

  if (
    weeklyBudgetUsd !== undefined ||
    shortWindowBudgetUsd !== undefined ||
    totalBudgetUsd !== undefined ||
    monthlyTokenLimit !== undefined
  ) {
    billingRule.quota = {
      weeklyBudgetUsd,
      shortWindowBudgetUsd,
      ...(shortWindowBudgetUsd !== undefined
        ? {
            shortWindowKind:
              elements.thirdPartyAccountShortWindowKindInput?.value || "five_hour",
          }
        : {}),
      totalBudgetUsd,
      ...(monthlyTokenLimit !== undefined
        ? {
            tokenQuota: {
              limitTokens: monthlyTokenLimit,
              windowKind: "monthly",
            },
          }
        : {}),
    };
  }

  return {
    kind: "third_party",
    name: elements.thirdPartyAccountNameInput?.value ?? "",
    apiKey: elements.thirdPartyAccountApiKeyInput?.value ?? "",
    apiBaseUrl: elements.thirdPartyAccountBaseUrlInput?.value ?? "",
    apiProtocol:
      elements.thirdPartyAccountApiProtocolInput?.value ?? "responses",
    defaultModel: elements.thirdPartyAccountDefaultModelInput?.value ?? "",
    requiresResponsesWebSocket:
      elements.thirdPartyAccountApiProtocolInput?.value !== "chat_completions" &&
      elements.thirdPartyAccountWsRequiredInput?.checked === true,
    billingRule:
      Object.keys(billingRule).length > 0 ? billingRule : undefined,
  };
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
  renderAccountCreation();
  renderAccountSwitchConfirm();
  renderCodexRestart();
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
  renderAccountRows(
    state.accounts,
    elements,
    handleActivateAccount,
    handleEditAccount,
  );
  syncPageStageHeight();
}

/**
 * 渲染新增账号表单。
 */
function renderAccountCreation() {
  renderAccountCreationForms(elements, state.accountCreation);
  syncThirdPartyProtocolDependentFields();
  syncBodyModalState();
}

/**
 * 渲染账号切换前确认弹窗。
 */
function renderAccountSwitchConfirm() {
  renderAccountSwitchConfirmModal(elements, state.accountSwitchConfirm);
  syncBodyModalState();
}

/**
 * 渲染 Codex 重启确认弹窗。
 */
function renderCodexRestart() {
  renderCodexRestartModal(elements, state.codexRestart);
  syncBodyModalState();
}

/**
 * 打开新增账号弹窗，并切换到指定账号类型。
 *
 * @param {"official" | "third_party"} kind 目标账号类型。
 * @returns {void}
 */
function openAccountCreationModal(kind) {
  state.accountCreation.mode = "create";
  state.accountCreation.targetAccountId = null;
  state.accountCreation.isOpen = true;
  resetAccountCreationForms();
  resetAccountCreationFeedback();
  setAccountCreationKind(kind);
  renderAccountCreation();
  focusActiveAccountCreationField();
}

/**
 * 关闭新增账号弹窗。
 *
 * @returns {void}
 */
function closeAccountCreationModal() {
  if (isAnyAccountCreationPending()) {
    return;
  }

  state.accountCreation.isOpen = false;
  state.accountCreation.mode = "create";
  state.accountCreation.targetAccountId = null;
  renderAccountCreation();
  window.requestAnimationFrame(() => {
    elements.accountCreateOpenButton?.focus();
  });
}

/**
 * 打开 Codex 重启确认弹窗。
 *
 * @param {string | null | undefined} reason 提示文案。
 */
function openCodexRestartModal(reason) {
  const runtime = state.status?.runtime ?? null;
  const canRestart = runtime?.canRestart !== false;
  state.codexRestart.isOpen = true;
  state.codexRestart.canRestart = canRestart;
  state.codexRestart.reason =
    reason ?? "配置已写入 ~/.codex/config.toml，需要重启 Codex 后才能生效。";
  state.codexRestart.feedback =
    canRestart
      ? "重启前，当前 Codex 仍会继续使用旧配置。"
      : runtime?.restartHint ?? "当前平台暂不支持自动重启 Codex，请手动重启。";
  state.codexRestart.tone = canRestart ? "warning" : "error";
  renderCodexRestart();
}

/**
 * 打开账号切换前确认弹窗。
 *
 * @param {string} accountId 目标账号 ID。
 * @param {string | null | undefined} message 提示文案。
 */
function openAccountSwitchConfirmModal(accountId, message) {
  state.accountSwitchConfirm.isOpen = true;
  state.accountSwitchConfirm.targetAccountId = accountId;
  state.accountSwitchConfirm.message =
    message ??
    "切换到该账号会先改写 ~/.codex/config.toml，随后需要重启 Codex 后才能生效。是否继续？";
  state.accountSwitchConfirm.feedback =
    "只有你确认继续后，系统才会真正写入 ~/.codex/config.toml。";
  state.accountSwitchConfirm.tone = "warning";
  renderAccountSwitchConfirm();
}

/**
 * 关闭账号切换前确认弹窗。
 */
function closeAccountSwitchConfirmModal() {
  if (state.accountSwitchConfirm.isSubmitting === true) {
    return;
  }

  state.accountSwitchConfirm.isOpen = false;
  state.accountSwitchConfirm.targetAccountId = null;
  renderAccountSwitchConfirm();
}

/**
 * 关闭 Codex 重启确认弹窗。
 */
function closeCodexRestartModal() {
  if (state.codexRestart.isRestarting === true) {
    return;
  }

  state.codexRestart.isOpen = false;
  state.codexRestart.canRestart = true;
  renderCodexRestart();
}

/**
 * 切换弹窗里当前展示的账号类型。
 *
 * @param {string} kind 原始类型值。
 * @returns {void}
 */
function setAccountCreationKind(kind) {
  if (kind !== "official" && kind !== "third_party") {
    return;
  }

  if (
    state.accountCreation.mode === "edit" &&
    kind !== state.accountCreation.selectedKind
  ) {
    return;
  }

  state.accountCreation.selectedKind = kind;
  renderAccountCreation();
}

/**
 * 应用第三方账号预设，尤其是 MiMo Token Plan 的 Chat Completions 协议与区域地址。
 *
 * @param {Event} event 下拉框 change 事件。
 * @returns {void}
 */
function handleThirdPartyPresetChange(event) {
  const preset = THIRD_PARTY_PRESETS[event.currentTarget.value];
  if (!preset) {
    syncThirdPartyProtocolDependentFields();
    return;
  }

  if (
    elements.thirdPartyAccountNameInput &&
    !elements.thirdPartyAccountNameInput.value
  ) {
    elements.thirdPartyAccountNameInput.value = preset.name;
  }
  if (elements.thirdPartyAccountBaseUrlInput) {
    elements.thirdPartyAccountBaseUrlInput.value = preset.apiBaseUrl;
  }
  if (elements.thirdPartyAccountDefaultModelInput) {
    elements.thirdPartyAccountDefaultModelInput.value = preset.defaultModel;
  }
  if (elements.thirdPartyAccountApiProtocolInput) {
    elements.thirdPartyAccountApiProtocolInput.value = preset.apiProtocol;
  }
  if (elements.thirdPartyAccountApiKeyInput) {
    elements.thirdPartyAccountApiKeyInput.placeholder = preset.apiKeyPlaceholder;
  }

  state.accountCreation.thirdParty.feedback =
    "MiMo Token Plan 使用 tp-xxxxx API Key；Codex 无需降级，代理会自动把 Responses SSE 适配到 Chat Completions。";
  state.accountCreation.thirdParty.tone = ACCOUNT_CREATION_TONES.neutral;
  syncThirdPartyProtocolDependentFields();
  renderAccountCreation();
}

/**
 * 根据上游协议切换 WebSocket 选项可用性。
 *
 * @returns {void}
 */
function handleThirdPartyProtocolChange() {
  if (elements.thirdPartyAccountPresetInput) {
    elements.thirdPartyAccountPresetInput.value = inferThirdPartyPreset({
      apiBaseUrl: elements.thirdPartyAccountBaseUrlInput?.value ?? "",
      apiProtocol: elements.thirdPartyAccountApiProtocolInput?.value ?? "responses",
      defaultModel: elements.thirdPartyAccountDefaultModelInput?.value ?? "",
    });
  }

  syncThirdPartyProtocolDependentFields();
  renderAccountCreation();
}

/**
 * Chat Completions 适配必须经由 HTTP SSE，不能让 Codex 走 WebSocket 隧道。
 *
 * @returns {void}
 */
function syncThirdPartyProtocolDependentFields() {
  const isChatProtocol =
    elements.thirdPartyAccountApiProtocolInput?.value === "chat_completions";
  const isPending = state.accountCreation.thirdParty.pending === true;

  if (elements.thirdPartyAccountWsRequiredInput) {
    if (isChatProtocol) {
      elements.thirdPartyAccountWsRequiredInput.checked = false;
    }
    elements.thirdPartyAccountWsRequiredInput.disabled =
      isPending || isChatProtocol;
  }

  if (elements.thirdPartyAccountApiKeyInput) {
    elements.thirdPartyAccountApiKeyInput.placeholder = isChatProtocol
      ? "tp-xxxxx"
      : "sk-...";
  }
}

/**
 * 根据编辑详情或当前表单值推断应该选中的第三方预设。
 *
 * @param {any} detail 第三方账号详情或表单快照。
 * @returns {string}
 */
function inferThirdPartyPreset(detail) {
  const apiBaseUrl = detail.apiBaseUrl ?? "";
  const apiProtocol = detail.apiProtocol ?? "responses";
  const defaultModel = detail.defaultModel ?? "";

  for (const [presetId, preset] of Object.entries(THIRD_PARTY_PRESETS)) {
    if (
      apiBaseUrl === preset.apiBaseUrl &&
      apiProtocol === preset.apiProtocol &&
      (!defaultModel || defaultModel === preset.defaultModel)
    ) {
      return presetId;
    }
  }

  return "custom";
}

/**
 * 把编辑详情回填到账号弹窗表单中。
 *
 * @param {any} detail 账号编辑详情。
 * @returns {void}
 */
function fillAccountCreationForm(detail) {
  resetAccountCreationForms();

  if (detail.kind === "official") {
    if (elements.officialAccountNameInput) {
      elements.officialAccountNameInput.value = detail.name ?? "";
    }
    if (elements.officialAccountSessionInput) {
      elements.officialAccountSessionInput.value = detail.sessionJson ?? "";
    }
    return;
  }

  if (elements.thirdPartyAccountNameInput) {
    elements.thirdPartyAccountNameInput.value = detail.name ?? "";
  }
  if (elements.thirdPartyAccountApiKeyInput) {
    elements.thirdPartyAccountApiKeyInput.value = detail.apiKey ?? "";
  }
  if (elements.thirdPartyAccountBaseUrlInput) {
    elements.thirdPartyAccountBaseUrlInput.value = detail.apiBaseUrl ?? "";
  }
  if (elements.thirdPartyAccountApiProtocolInput) {
    elements.thirdPartyAccountApiProtocolInput.value =
      detail.apiProtocol ?? "responses";
  }
  if (elements.thirdPartyAccountPresetInput) {
    elements.thirdPartyAccountPresetInput.value = inferThirdPartyPreset(detail);
  }
  if (elements.thirdPartyAccountDefaultModelInput) {
    elements.thirdPartyAccountDefaultModelInput.value = detail.defaultModel ?? "";
  }
  if (elements.thirdPartyAccountInputPriceInput) {
    elements.thirdPartyAccountInputPriceInput.value =
      detail.billingRule?.pricing?.inputPerMillionUsd?.toString() ?? "";
  }
  if (elements.thirdPartyAccountOutputPriceInput) {
    elements.thirdPartyAccountOutputPriceInput.value =
      detail.billingRule?.pricing?.outputPerMillionUsd?.toString() ?? "";
  }
  if (elements.thirdPartyAccountCachePriceInput) {
    elements.thirdPartyAccountCachePriceInput.value =
      detail.billingRule?.pricing?.cachedInputPerMillionUsd?.toString() ?? "";
  }
  if (elements.thirdPartyAccountWeeklyBudgetInput) {
    elements.thirdPartyAccountWeeklyBudgetInput.value =
      detail.billingRule?.quota?.weeklyBudgetUsd?.toString() ?? "";
  }
  if (elements.thirdPartyAccountShortWindowBudgetInput) {
    elements.thirdPartyAccountShortWindowBudgetInput.value =
      detail.billingRule?.quota?.shortWindowBudgetUsd?.toString() ?? "";
  }
  if (elements.thirdPartyAccountShortWindowKindInput) {
    elements.thirdPartyAccountShortWindowKindInput.value =
      detail.billingRule?.quota?.shortWindowKind ?? "five_hour";
  }
  if (elements.thirdPartyAccountTotalBudgetInput) {
    elements.thirdPartyAccountTotalBudgetInput.value =
      detail.billingRule?.quota?.totalBudgetUsd?.toString() ?? "";
  }
  if (elements.thirdPartyAccountMonthlyTokenLimitInput) {
    elements.thirdPartyAccountMonthlyTokenLimitInput.value =
      detail.billingRule?.quota?.tokenQuota?.limitTokens?.toString() ?? "";
  }
  if (elements.thirdPartyAccountWsRequiredInput) {
    elements.thirdPartyAccountWsRequiredInput.checked =
      detail.requiresResponsesWebSocket === true;
  }
  syncThirdPartyProtocolDependentFields();
}

/**
 * 重置账号弹窗内所有输入控件。
 *
 * @returns {void}
 */
function resetAccountCreationForms() {
  elements.officialAccountForm?.reset();
  elements.thirdPartyAccountForm?.reset();
  syncThirdPartyProtocolDependentFields();
}

/**
 * 把账号弹窗反馈文案恢复到默认值。
 *
 * @returns {void}
 */
function resetAccountCreationFeedback() {
  state.accountCreation.official.feedback =
    ACCOUNT_CREATION_DEFAULT_FEEDBACK.official;
  state.accountCreation.official.tone = ACCOUNT_CREATION_TONES.neutral;
  clearThirdPartyValidationConfirmation();
  state.accountCreation.thirdParty.feedback =
    ACCOUNT_CREATION_DEFAULT_FEEDBACK.thirdParty;
  state.accountCreation.thirdParty.tone = ACCOUNT_CREATION_TONES.neutral;
}

/**
 * 撤销第三方表单当前已获得的“跳过 /models 校验”确认态。
 *
 * @returns {void}
 */
function clearThirdPartyValidationConfirmation() {
  const shouldResetFeedback =
    state.accountCreation.thirdParty.awaitingConfirmation === true &&
    state.accountCreation.thirdParty.pending !== true;
  state.accountCreation.thirdParty.awaitingConfirmation = false;
  state.accountCreation.thirdParty.confirmFingerprint = null;
  if (shouldResetFeedback) {
    state.accountCreation.thirdParty.feedback =
      ACCOUNT_CREATION_DEFAULT_FEEDBACK.thirdParty;
    state.accountCreation.thirdParty.tone = ACCOUNT_CREATION_TONES.neutral;
    renderAccountCreation();
  }
}

/**
 * 在首次 `/models` 探测失败后，记录一次“用户可再次点击保存继续”的确认态。
 *
 * @param {string} fingerprint 当前表单内容指纹。
 * @param {string} message 展示给用户的提醒文案。
 * @returns {void}
 */
function armThirdPartyValidationConfirmation(fingerprint, message) {
  state.accountCreation.thirdParty.awaitingConfirmation = true;
  state.accountCreation.thirdParty.confirmFingerprint = fingerprint;
  state.accountCreation.thirdParty.feedback = message;
  state.accountCreation.thirdParty.tone = "warning";
}

/**
 * 判断当前提交是否已经拿到用户对“跳过 /models 测试”的再次确认。
 *
 * @param {string} fingerprint 当前表单内容指纹。
 * @returns {boolean}
 */
function shouldSkipThirdPartyConnectivityCheck(fingerprint) {
  return (
    state.accountCreation.thirdParty.awaitingConfirmation === true &&
    state.accountCreation.thirdParty.confirmFingerprint === fingerprint
  );
}

/**
 * 为第三方表单生成一次稳定指纹，避免用户改了内容后仍沿用旧确认态。
 *
 * @param {any} payload 当前请求体。
 * @returns {string}
 */
function buildThirdPartyPayloadFingerprint(payload) {
  return JSON.stringify({
    mode: state.accountCreation.mode,
    targetAccountId: state.accountCreation.targetAccountId,
    name: payload.name ?? "",
    apiKey: payload.apiKey ?? "",
    apiBaseUrl: payload.apiBaseUrl ?? "",
    apiProtocol: payload.apiProtocol ?? "responses",
    defaultModel: payload.defaultModel ?? "",
    requiresResponsesWebSocket: payload.requiresResponsesWebSocket === true,
    billingRule: payload.billingRule ?? null,
  });
}

/**
 * 把表单中的可选数字输入转换为 number。
 *
 * @param {string | null | undefined} rawValue 原始字符串。
 * @returns {number | undefined}
 */
function readOptionalNumber(rawValue) {
  const trimmed = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!trimmed) {
    return undefined;
  }

  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * 判断某次提交失败是否属于“再次点击保存即可继续”的软确认场景。
 *
 * @param {unknown} error 请求异常。
 * @returns {boolean}
 */
function isThirdPartyValidationConfirmationError(error) {
  return (
    error instanceof Error &&
    error.code === THIRD_PARTY_VALIDATION_CONFIRMATION_CODE
  );
}

/**
 * 处理弹窗背景点击，支持点击遮罩关闭。
 *
 * @param {MouseEvent} event 鼠标事件。
 * @returns {void}
 */
function handleAccountModalBackdropClick(event) {
  if (event.target !== elements.accountCreateModal) {
    return;
  }

  closeAccountCreationModal();
}

/**
 * 处理全局快捷键，目前仅支持 Esc 关闭弹窗。
 *
 * @param {KeyboardEvent} event 键盘事件。
 * @returns {void}
 */
function handleWindowKeydown(event) {
  if (event.key !== "Escape") {
    return;
  }

  if (state.codexRestart.isOpen === true) {
    closeCodexRestartModal();
    return;
  }

  if (state.accountSwitchConfirm.isOpen === true) {
    closeAccountSwitchConfirmModal();
    return;
  }

  if (state.accountCreation.isOpen === true) {
    closeAccountCreationModal();
  }
}

/**
 * 在弹窗打开后，把焦点放到当前面板里最合理的第一个输入框。
 *
 * @returns {void}
 */
function focusActiveAccountCreationField() {
  window.requestAnimationFrame(() => {
    const field =
      state.accountCreation.selectedKind === "official"
        ? elements.officialAccountNameInput
        : elements.thirdPartyAccountNameInput;
    field?.focus();
  });
}

/**
 * 判断当前是否有新增账号请求还在进行中。
 *
 * @returns {boolean}
 */
function isAnyAccountCreationPending() {
  return (
    state.accountCreation.official.pending === true ||
    state.accountCreation.thirdParty.pending === true
  );
}

/**
 * 请求立即重启 Codex。
 *
 * @returns {Promise<void>}
 */
async function handleCodexRestartConfirm() {
  if (state.codexRestart.canRestart === false) {
    state.codexRestart.feedback =
      state.status?.runtime?.restartHint ??
      "当前平台暂不支持自动重启 Codex，请手动重启。";
    state.codexRestart.tone = "error";
    renderCodexRestart();
    return;
  }

  let restartSucceeded = false;
  state.codexRestart.isRestarting = true;
  state.codexRestart.feedback = "正在请求关闭并重新拉起 Codex ...";
  state.codexRestart.tone = "warning";
  renderCodexRestart();

  try {
    const result = await restartCodexApp();
    state.codexRestart.feedback = result.message;
    state.codexRestart.tone = "success";
    await refreshAll();
    state.codexProxyFeedback = result.message;
    state.codexProxyFeedbackTone = "success";
    restartSucceeded = true;
  } catch (error) {
    state.codexRestart.feedback =
      error instanceof Error ? error.message : String(error);
    state.codexRestart.tone = "error";
    renderCodexRestart();
  } finally {
    state.codexRestart.isRestarting = false;
    if (restartSucceeded) {
      closeCodexRestartModal();
      return;
    }
    renderCodexRestart();
  }
}

/**
 * 在切换前确认弹窗里继续执行账号切换。
 *
 * @returns {Promise<void>}
 */
async function handleAccountSwitchConfirmContinue() {
  const targetAccountId = state.accountSwitchConfirm.targetAccountId;
  if (!targetAccountId) {
    return;
  }

  let switchSucceeded = false;
  state.accountSwitchConfirm.isSubmitting = true;
  state.accountSwitchConfirm.feedback = "正在切换账号，并同步写入 ~/.codex/config.toml ...";
  state.accountSwitchConfirm.tone = "warning";
  renderAccountSwitchConfirm();

  try {
    await performAccountActivation(targetAccountId);
    switchSucceeded = true;
  } catch (error) {
    state.accountSwitchConfirm.feedback =
      error instanceof Error ? error.message : String(error);
    state.accountSwitchConfirm.tone = "error";
    renderAccountSwitchConfirm();
  } finally {
    state.accountSwitchConfirm.isSubmitting = false;
    if (switchSucceeded) {
      closeAccountSwitchConfirmModal();
      return;
    }
    renderAccountSwitchConfirm();
  }
}

/**
 * 真正执行一次账号切换，并在需要时继续弹出“请重启 Codex”提示。
 *
 * @param {string} accountId 目标账号 ID。
 * @returns {Promise<void>}
 */
async function performAccountActivation(accountId) {
  const result = await activateAccount(accountId);
  await refreshAll();
  if (result.codexConfig?.restartRequired) {
    openCodexRestartModal(result.codexConfig.restartReason);
  }
}

/**
 * 根据当前是否存在任意打开的弹窗，统一切换 body 的滚动锁定。
 */
function syncBodyModalState() {
  document.body.dataset.modalOpen = String(
    state.accountCreation.isOpen === true ||
      state.accountSwitchConfirm.isOpen === true ||
      state.codexRestart.isOpen === true,
  );
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
