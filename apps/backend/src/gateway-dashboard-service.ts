import type {
  AccountCard,
  AccountBudgetSnapshot,
  ActivateAccountResponse,
  ActivateAccountPreviewResponse,
  CodexConfigMutationResult,
  CodexProxyStatus,
  DashboardStatus,
  HealthStatus,
  ProxyClientKind,
  RestartCodexAppResponse,
  ServerEvent,
} from "../../../packages/shared/src/index.ts";
import {
  CODEX_PROXY_RECENT_WINDOW_MINUTES,
  HOST,
  MANAGED_CODEX_PROVIDER_NAME,
  PORT,
} from "./config.ts";
import { buildGatewayRoutePaths } from "./gateway-metadata.ts";
import {
  buildCodexProxyStatus,
  buildManagedProviderBaseUrl,
  readCodexProxyConfigStatus,
  setCodexProxyEnabled as applyCodexProxyEnabledChange,
  syncManagedCodexProvider,
} from "./codex-proxy-control-service.ts";
import {
  accountAllowsResponsesWebSocket,
  loadGatewayAccounts,
  pickActiveGatewayAccountId,
  type GatewayRuntimeAccount,
} from "./gateway-account-store.ts";
import {
  loadGatewayState,
  saveGatewayState,
  type GatewayPersistedState,
} from "./gateway-state-store.ts";
import {
  deriveOfficialHealth,
  loadOfficialUsageSnapshot,
} from "./official-account-usage-provider.ts";
import {
  inspectCodexRuntime,
  startCodexApp,
  stopCodexApp,
} from "./codex-runtime-inspector.ts";
import { createIdleSwitchJob } from "./state-store.ts";
import {
  aggregateUsageTotals,
  createEmptyUsageTotals,
} from "./usage-dashboard-provider.ts";
import { loadUsageEvents } from "./usage-event-store.ts";
import { buildThirdPartyBudgetSnapshot } from "./third-party-budget-usage.ts";
import {
  describeThirdPartyBillingRule,
  hasCustomThirdPartyPricing,
} from "./third-party-billing-rules.ts";
import { formatError } from "./utils.ts";

type EventListener = (event: ServerEvent<unknown>) => void;

/**
 * 本文件负责维护账号看板的内存态。
 * 它把账号配置、官方额度、累计用量和本地代理状态收敛成服务端可直接返回的缓存。
 */
export class GatewayDashboardService {
  private readonly gatewayRoutes = buildGatewayRoutePaths();

  private readonly listeners = new Set<EventListener>();

  private accounts: AccountCard[] = [];

  private gatewayState: GatewayPersistedState = {
    activeAccountId: null,
    lastRequestAt: null,
    lastRequestModel: null,
    lastRequestResult: null,
    lastRequestClientKind: null,
    lastRequestClientLabel: null,
    lastCodexRequestAt: null,
    codexConfigRestartPending: false,
    codexConfigRestartReason: null,
    codexConfigLastUpdatedAt: null,
  };

  private codexProxyStatus: CodexProxyStatus = {
    config: {
      configPath: "",
      providerName: MANAGED_CODEX_PROVIDER_NAME,
      currentModelProvider: null,
      currentProviderBaseUrl: null,
      configuredBaseUrl: null,
      expectedBaseUrl: buildManagedProviderBaseUrl(),
      configuredSupportsWebsockets: null,
      expectedSupportsWebsockets: false,
      isEnabled: false,
      diagnostics: ["等待首次配置检查。"],
    },
    recentWindowMinutes: CODEX_PROXY_RECENT_WINDOW_MINUTES,
    lastProxyRequestAt: null,
    lastCodexRequestAt: null,
    isCodexTrafficRecent: false,
    lastProxyClient: null,
    restartRequired: false,
    restartReason: null,
    restartRequestedAt: null,
  };

  private status: DashboardStatus = {
    activeSpaceId: null,
    activeSpaceName: null,
    activeAccountId: null,
    activeAccountName: null,
    runtime: {
      state: "unknown",
      isBusy: false,
      lastObservedAt: new Date().toISOString(),
      detail: "等待首次运行态探测。",
    },
    switchJob: createIdleSwitchJob(),
    lastSwitchResult: null,
    gateway: {
      listenBaseUrl: `http://${HOST}:${PORT}`,
      responsesPath: this.gatewayRoutes.providerResponsesPath,
      modelsPath: this.gatewayRoutes.providerModelsPath,
      activeAccountId: null,
      activeAccountName: null,
      lastRequestAt: null,
      lastRequestModel: null,
      lastRequestResult: null,
      lastRequestClientKind: null,
      lastRequestClientLabel: null,
      lastCodexRequestAt: null,
    },
    codexProxy: undefined,
  };

  /**
   * 初始化服务内存态。
   *
   * @returns 无返回值。
   */
  async initialize(): Promise<void> {
    this.gatewayState = await loadGatewayState();
    await this.refreshRuntime();
    await this.refreshAccounts();
    await this.refreshCodexProxyStatus();
  }

  /**
   * 订阅服务端事件。
   *
   * @param listener 事件监听器。
   * @returns 取消订阅函数。
   */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 返回当前账号卡片缓存。
   *
   * @returns 账号卡片数组。
   */
  getAccounts(): AccountCard[] {
    return this.accounts;
  }

  /**
   * 返回当前状态缓存。
   *
   * @returns 顶部状态对象。
   */
  getStatus(): DashboardStatus {
    return this.status;
  }

  /**
   * 刷新 Codex Desktop 当前运行态。
   *
   * @returns 无返回值。
   */
  async refreshRuntime(): Promise<void> {
    this.status = {
      ...this.status,
      runtime: await inspectCodexRuntime(),
      codexProxy: this.codexProxyStatus,
    };

    this.emit({
      type: "codex.status_changed",
      payload: this.status,
    });
  }

  /**
   * 刷新账号卡片与代理状态缓存。
   *
   * @returns 无返回值。
   */
  async refreshAccounts(): Promise<void> {
    const runtimeAccounts = await loadGatewayAccounts(
      this.gatewayState.activeAccountId,
    );

    const usageEvents = await loadUsageEvents();
    const draftAccounts = await Promise.all(
      runtimeAccounts.map(async (account) => {
        const rawDiagnostics = [...account.rawDiagnostics];
        let health: HealthStatus = account.isConfigured ? "healthy" : "error";
        let statusLabel = account.isConfigured ? "已就绪" : "配置缺失";
        let officialUsage = null;
        let lastCheckedAt: string | null = null;
        let thirdPartyBillingRule = null;
        let thirdPartyBudgetSnapshot = null;
        const accountEvents = usageEvents.filter((event) => event.accountId === account.id);

        if (account.kind === "official") {
          if (!account.isConfigured) {
            health = "error";
            statusLabel = "登录态不可用";
          } else {
            try {
              officialUsage = await loadOfficialUsageSnapshot(account);
              lastCheckedAt = new Date().toISOString();
              health = deriveOfficialHealth(officialUsage);
              statusLabel = formatOfficialStatusLabel(officialUsage.planType);
            } catch (error) {
              health = "error";
              statusLabel = "额度获取失败";
              rawDiagnostics.push(`官方额度刷新失败：${formatError(error)}`);
            }
          }
        } else if (!account.isConfigured) {
          health = "error";
          statusLabel = "缺少 API Key";
        } else {
          statusLabel = "第三方路由可用";
          rawDiagnostics.push(
            account.apiProtocol === "chat_completions"
              ? "上游协议：Chat Completions；本地代理会转换 Codex Responses SSE。"
              : "上游协议：Responses；本地代理将透明转发请求。",
          );
          thirdPartyBillingRule = account.billingRule ?? null;
          thirdPartyBudgetSnapshot = buildThirdPartyBudgetSnapshot(
            accountEvents,
            thirdPartyBillingRule,
          );
          const billingHint = describeThirdPartyBillingRule(thirdPartyBillingRule);
          if (billingHint) {
            rawDiagnostics.push(billingHint);
          } else {
            rawDiagnostics.push("未配置单独计费规则时，将按官方公开定价估算费用。");
          }
          if (thirdPartyBudgetSnapshot) {
            statusLabel = "第三方额度计量";
          }
          if (hasCustomThirdPartyPricing(thirdPartyBillingRule)) {
            statusLabel = "第三方自定义计费";
          }
          if (isBudgetExhausted(thirdPartyBudgetSnapshot)) {
            health = "exhausted";
            statusLabel = "第三方额度耗尽";
          } else if (isBudgetWarning(thirdPartyBudgetSnapshot)) {
            health = "warning";
            statusLabel = "第三方额度预警";
          }
        }

        return {
          id: account.id,
          name: account.name,
          kind: account.kind,
          isActive: false,
          health,
          statusLabel,
          lastCheckedAt,
          officialUsage,
          thirdPartyBillingRule,
          thirdPartyBudgetSnapshot,
          cumulativeUsage: aggregateUsageTotals(accountEvents, [
            {
              id: account.id,
              name: account.name,
              kind: account.kind,
              isActive: account.isActive,
              health,
              statusLabel,
              lastCheckedAt,
              officialUsage: null,
              thirdPartyBillingRule,
              thirdPartyBudgetSnapshot: null,
              cumulativeUsage: createEmptyUsageTotals(),
              rawDiagnostics: [],
            },
          ]),
          rawDiagnostics,
        } satisfies AccountCard;
      }),
    );

    const activeAccountId =
      pickHealthyActiveAccountId(
        draftAccounts,
        this.gatewayState.activeAccountId,
      ) ??
      pickActiveGatewayAccountId(
        runtimeAccounts,
        this.gatewayState.activeAccountId,
      );

    if (activeAccountId !== this.gatewayState.activeAccountId) {
      this.gatewayState = {
        ...this.gatewayState,
        activeAccountId,
      };
      await saveGatewayState(this.gatewayState);
    }

    this.accounts = draftAccounts.map((account) => ({
      ...account,
      isActive: account.id === activeAccountId,
    }));

    const activeAccount =
      this.accounts.find((account) => account.isActive) ?? null;

    this.status = {
      ...this.status,
      activeSpaceId: activeAccount?.id ?? null,
      activeSpaceName: activeAccount?.name ?? null,
      activeAccountId: activeAccount?.id ?? null,
      activeAccountName: activeAccount?.name ?? null,
      gateway: {
        listenBaseUrl: `http://${HOST}:${PORT}`,
        responsesPath: this.gatewayRoutes.providerResponsesPath,
        modelsPath: this.gatewayRoutes.providerModelsPath,
        activeAccountId: activeAccount?.id ?? null,
        activeAccountName: activeAccount?.name ?? null,
        lastRequestAt: this.gatewayState.lastRequestAt,
        lastRequestModel: this.gatewayState.lastRequestModel,
        lastRequestResult: this.gatewayState.lastRequestResult,
        lastRequestClientKind: this.gatewayState.lastRequestClientKind,
        lastRequestClientLabel: this.gatewayState.lastRequestClientLabel,
        lastCodexRequestAt: this.gatewayState.lastCodexRequestAt,
      },
      codexProxy: this.codexProxyStatus,
    };

    this.emit({
      type: "accounts.updated",
      payload: this.accounts,
    });
    this.emit({
      type: "codex.status_changed",
      payload: this.status,
    });
  }

  /**
   * 设置新的激活账号。
   *
   * @param targetAccountId 目标账号 ID。
   * @returns 切换结果；若当前代理已接管，还会附带 `config.toml` 改写结果。
   */
  async activateAccount(targetAccountId: string): Promise<ActivateAccountResponse> {
    const runtimeAccounts = await loadGatewayAccounts(
      this.gatewayState.activeAccountId,
    );
    const target = runtimeAccounts.find(
      (account) => account.id === targetAccountId && account.isConfigured,
    );

    if (!target) {
      return {
        ok: false,
        codexConfig: null,
      };
    }

    this.gatewayState = {
      ...this.gatewayState,
      activeAccountId: targetAccountId,
      lastRequestResult: `已将本地代理切换到 ${target.name}。`,
    };
    await saveGatewayState(this.gatewayState);
    await this.refreshAccounts();

    const codexConfig =
      this.codexProxyStatus.config.currentModelProvider ===
      this.codexProxyStatus.config.providerName
        ? await this.syncCodexProxyConfigForAccount(target)
        : null;

    return {
      ok: true,
      codexConfig,
    };
  }

  /**
   * 预览切到某个账号时，是否会顺带改写 `~/.codex/config.toml`。
   *
   * @param targetAccountId 目标账号 ID。
   * @returns 预览结果；若当前不会触碰配置文件，则无需额外确认。
   */
  async previewActivateAccount(
    targetAccountId: string,
  ): Promise<ActivateAccountPreviewResponse> {
    const runtimeAccounts = await loadGatewayAccounts(
      this.gatewayState.activeAccountId,
    );
    const target = runtimeAccounts.find(
      (account) => account.id === targetAccountId && account.isConfigured,
    );

    if (!target) {
      return {
        ok: false,
        requiresConfigRewrite: false,
        message: null,
      };
    }

    if (
      this.codexProxyStatus.config.currentModelProvider !==
      this.codexProxyStatus.config.providerName
    ) {
      return {
        ok: true,
        requiresConfigRewrite: false,
        message: null,
      };
    }

    const previewConfig = await readCodexProxyConfigStatus({
      supportsWebsockets:
        target.kind === "third_party"
          ? accountAllowsResponsesWebSocket(target)
          : false,
    });
    const requiresConfigRewrite = previewConfig.isEnabled !== true;

    return {
      ok: true,
      requiresConfigRewrite,
      message: requiresConfigRewrite
        ? `切换到 ${target.name} 会先改写 ~/.codex/config.toml，随后需要重启 Codex Desktop 才能生效。是否继续？`
        : null,
    };
  }

  /**
   * 记录最近一次代理请求结果。
   *
   * @param result 最近一次请求的结果摘要。
   * @returns 无返回值。
   */
  async recordGatewayRequest(result: {
    requestAt: string;
    model: string | null;
    statusText: string;
    clientKind: ProxyClientKind;
    clientLabel: string;
    isLikelyCodex: boolean;
  }): Promise<void> {
    this.gatewayState = {
      ...this.gatewayState,
      lastRequestAt: result.requestAt,
      lastRequestModel: result.model,
      lastRequestResult: result.statusText,
      lastRequestClientKind: result.clientKind,
      lastRequestClientLabel: result.clientLabel,
      lastCodexRequestAt: result.isLikelyCodex
        ? result.requestAt
        : this.gatewayState.lastCodexRequestAt,
    };
    await saveGatewayState(this.gatewayState);
    this.codexProxyStatus = buildCodexProxyStatus(
      this.codexProxyStatus.config,
      this.gatewayState,
    );

    this.status = {
      ...this.status,
      gateway: {
        ...this.status.gateway!,
        lastRequestAt: result.requestAt,
        lastRequestModel: result.model,
        lastRequestResult: result.statusText,
        lastRequestClientKind: result.clientKind,
        lastRequestClientLabel: result.clientLabel,
        lastCodexRequestAt: this.gatewayState.lastCodexRequestAt,
      },
      codexProxy: this.codexProxyStatus,
    };

    this.emit({
      type: "codex.status_changed",
      payload: this.status,
    });
  }

  /**
   * 广播“用量看板需要刷新”事件。
   *
   * @returns 无返回值。
   */
  notifyUsageUpdated(): void {
    this.emit({
      type: "usage_dashboard.updated",
      payload: {
        updatedAt: new Date().toISOString(),
      },
    });
  }

  /**
   * 读取当前激活账号的完整运行时定义。
   *
   * @returns 激活账号对象；若当前没有可用账号则返回 `null`。
   */
  async getActiveRuntimeAccount(): Promise<GatewayRuntimeAccount | null> {
    const runtimeAccounts = await loadGatewayAccounts(
      this.gatewayState.activeAccountId,
    );
    const activeAccountId =
      this.accounts.find((account) => account.isActive)?.id ??
      pickActiveGatewayAccountId(
        runtimeAccounts,
        this.gatewayState.activeAccountId,
      );
    return (
      runtimeAccounts.find((account) => account.id === activeAccountId) ?? null
    );
  }

  /**
   * 刷新 `~/.codex/config.toml` 的接管状态。
   *
   * @returns 无返回值。
   */
  async refreshCodexProxyStatus(): Promise<void> {
    const config = await readCodexProxyConfigStatus({
      supportsWebsockets: await this.getExpectedCodexProxySupportsWebsockets(),
    });
    this.codexProxyStatus = buildCodexProxyStatus(config, this.gatewayState);
    this.status = {
      ...this.status,
      codexProxy: this.codexProxyStatus,
    };

    this.emit({
      type: "codex.status_changed",
      payload: this.status,
    });
  }

  /**
   * 打开或关闭“Codex 接管到本地代理”的开关。
   *
   * @param enabled 是否启用接管。
   * @returns 配置改写结果；当内容实际变化时需要提示用户重启 Codex。
   */
  async setCodexProxyEnabled(enabled: boolean): Promise<CodexConfigMutationResult> {
    const mutation = await applyCodexProxyEnabledChange(enabled, {
      supportsWebsockets: await this.getExpectedCodexProxySupportsWebsockets(),
    });
    await this.applyCodexConfigMutation(mutation);
    return mutation;
  }

  /**
   * 重启本机 Codex Desktop，并在成功后清空“等待重启生效”标记。
   *
   * @returns 重启结果摘要。
   */
  async restartCodexApp(): Promise<RestartCodexAppResponse> {
    await stopCodexApp();
    await startCodexApp();

    this.gatewayState = {
      ...this.gatewayState,
      codexConfigRestartPending: false,
      codexConfigRestartReason: null,
      codexConfigLastUpdatedAt: new Date().toISOString(),
    };
    await saveGatewayState(this.gatewayState);
    await this.refreshRuntime();
    await this.refreshCodexProxyStatus();

    return {
      ok: true,
      message: "已触发 Codex Desktop 重启。",
    };
  }

  /**
   * 根据当前激活账号，推导受管 provider block 里应该写入的 ws 开关。
   *
   * @returns 当前路由账号期望的 `supports_websockets`。
   */
  private async getExpectedCodexProxySupportsWebsockets(): Promise<boolean> {
    const activeAccount = await this.getActiveRuntimeAccount();
    return activeAccount?.kind === "third_party"
      ? accountAllowsResponsesWebSocket(activeAccount)
      : false;
  }

  /**
   * 当代理已接管时，按目标账号同步 `config.toml` 里的动态 provider 字段。
   *
   * @param account 当前激活账号。
   * @returns 若发生了配置改写，则返回对应结果；否则返回 `null`。
   */
  private async syncCodexProxyConfigForAccount(
    account: GatewayRuntimeAccount,
  ): Promise<CodexConfigMutationResult | null> {
    const mutation = await syncManagedCodexProvider({
      supportsWebsockets:
        account.kind === "third_party"
          ? accountAllowsResponsesWebSocket(account)
          : false,
    });
    await this.applyCodexConfigMutation(mutation);
    return mutation;
  }

  /**
   * 当某个账号定义被更新后，若它正承接本地代理且 Codex 已接管，则同步受管 provider 配置。
   *
   * @param accountId 被编辑的账号 ID。
   * @returns 若触发了 `config.toml` 改写，则返回对应结果；否则返回 `null`。
   */
  async handleAccountDefinitionUpdated(
    accountId: string,
  ): Promise<CodexConfigMutationResult | null> {
    await this.refreshAccounts();
    const activeAccount = await this.getActiveRuntimeAccount();
    if (
      !activeAccount ||
      activeAccount.id !== accountId ||
      this.codexProxyStatus.config.currentModelProvider !==
        this.codexProxyStatus.config.providerName
    ) {
      return null;
    }

    return this.syncCodexProxyConfigForAccount(activeAccount);
  }

  /**
   * 把一次 `config.toml` 改写结果写回状态缓存，并广播给前端。
   *
   * @param mutation 配置改写结果。
   * @returns 无返回值。
   */
  private async applyCodexConfigMutation(
    mutation: CodexConfigMutationResult,
  ): Promise<void> {
    this.gatewayState = {
      ...this.gatewayState,
      codexConfigRestartPending: mutation.configChanged
        ? mutation.restartRequired
        : this.gatewayState.codexConfigRestartPending,
      codexConfigRestartReason: mutation.configChanged
        ? mutation.restartReason
        : this.gatewayState.codexConfigRestartReason,
      codexConfigLastUpdatedAt: mutation.configChanged
        ? new Date().toISOString()
        : this.gatewayState.codexConfigLastUpdatedAt,
    };
    await saveGatewayState(this.gatewayState);

    this.codexProxyStatus = buildCodexProxyStatus(
      mutation.config,
      this.gatewayState,
    );
    this.status = {
      ...this.status,
      codexProxy: this.codexProxyStatus,
    };

    this.emit({
      type: "codex.status_changed",
      payload: this.status,
    });
  }

  /**
   * 对外广播一个服务端事件。
   *
   * @param event 待广播事件。
   * @returns 无返回值。
   */
  private emit(event: ServerEvent<unknown>): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

/**
 * 把计划类型格式化成更短的状态标签。
 *
 * @param planType 原始计划名。
 * @returns 适合看板展示的短标签。
 */
function formatOfficialStatusLabel(planType: string | null): string {
  if (!planType) {
    return "官方账号";
  }

  if (/plus/i.test(planType)) {
    return "Official Plus";
  }

  if (/team/i.test(planType)) {
    return "Official Team";
  }

  return `Official ${planType}`;
}

/**
 * 优先挑选一个当前可路由且健康状态正常的账号。
 *
 * @param accounts 已经补充健康状态后的账号卡片。
 * @param preferredActiveAccountId 当前持久化的激活账号。
 * @returns 最适合接管路由的账号 ID；完全没有候选时返回 `null`。
 */
export function pickHealthyActiveAccountId(
  accounts: AccountCard[],
  preferredActiveAccountId: string | null,
): string | null {
  const preferred = accounts.find(
    (account) =>
      account.id === preferredActiveAccountId && account.health !== "error",
  );
  if (preferred) {
    return preferred.id;
  }

  const firstHealthy = accounts.find((account) => account.health !== "error");
  return firstHealthy?.id ?? accounts[0]?.id ?? null;
}

/**
 * 判断第三方预算是否已经耗尽。
 *
 * @param snapshot 当前预算摘要。
 * @returns 任一窗口耗尽时返回 `true`。
 */
function isBudgetExhausted(snapshot: AccountBudgetSnapshot | null): boolean {
  return collectBudgetRatios(snapshot).some((window) => window.remaining <= 0);
}

/**
 * 判断第三方预算是否进入预警状态。
 *
 * @param snapshot 当前预算摘要。
 * @returns 任一窗口剩余不足 15% 时返回 `true`。
 */
function isBudgetWarning(snapshot: AccountBudgetSnapshot | null): boolean {
  return collectBudgetRatios(snapshot).some(
    (window) => window.limit > 0 && window.remaining / window.limit <= 0.15,
  );
}

/**
 * 把美元额度与 token 额度收敛成统一比例，供健康状态判断复用。
 *
 * @param snapshot 当前预算摘要。
 * @returns 每个额度窗口的剩余量与上限。
 */
function collectBudgetRatios(
  snapshot: AccountBudgetSnapshot | null,
): Array<{ remaining: number; limit: number }> {
  if (!snapshot) {
    return [];
  }

  const ratios: Array<{ remaining: number; limit: number }> = [];
  for (const window of [
    snapshot.shortWindow,
    snapshot.weeklyWindow,
    snapshot.totalBudget,
  ]) {
    if (!window) {
      continue;
    }

    ratios.push({
      remaining: window.remainingUsd,
      limit: window.limitUsd,
    });
  }

  if (snapshot.tokenWindow) {
    ratios.push({
      remaining: snapshot.tokenWindow.remainingTokens,
      limit: snapshot.tokenWindow.limitTokens,
    });
  }

  return ratios;
}
