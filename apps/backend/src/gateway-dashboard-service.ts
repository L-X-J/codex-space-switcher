import type {
  AccountCard,
  CodexProxyStatus,
  DashboardStatus,
  HealthStatus,
  ProxyClientKind,
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
} from "./codex-proxy-control-service.ts";
import {
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
import { inspectCodexRuntime } from "./codex-runtime-inspector.ts";
import { createIdleSwitchJob } from "./state-store.ts";
import {
  aggregateUsageTotals,
  createEmptyUsageTotals,
} from "./usage-dashboard-provider.ts";
import { loadUsageEvents } from "./usage-event-store.ts";
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
  };

  private codexProxyStatus: CodexProxyStatus = {
    config: {
      configPath: "",
      providerName: MANAGED_CODEX_PROVIDER_NAME,
      currentModelProvider: null,
      currentProviderBaseUrl: null,
      configuredBaseUrl: null,
      expectedBaseUrl: buildManagedProviderBaseUrl(),
      isEnabled: false,
      diagnostics: ["等待首次配置检查。"],
    },
    recentWindowMinutes: CODEX_PROXY_RECENT_WINDOW_MINUTES,
    lastProxyRequestAt: null,
    lastCodexRequestAt: null,
    isCodexTrafficRecent: false,
    lastProxyClient: null,
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
    const totalsByAccountId = new Map<string, ReturnType<typeof createEmptyUsageTotals>>();
    for (const account of runtimeAccounts) {
      totalsByAccountId.set(
        account.id,
        aggregateUsageTotals(
          usageEvents.filter((event) => event.accountId === account.id),
        ),
      );
    }

    const draftAccounts = await Promise.all(
      runtimeAccounts.map(async (account) => {
        const rawDiagnostics = [...account.rawDiagnostics];
        let health: HealthStatus = account.isConfigured ? "healthy" : "error";
        let statusLabel = account.isConfigured ? "已就绪" : "配置缺失";
        let officialUsage = null;
        let lastCheckedAt: string | null = null;

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
          cumulativeUsage:
            totalsByAccountId.get(account.id) ?? createEmptyUsageTotals(),
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
   * @returns 命中可用账号时返回 `true`，否则返回 `false`。
   */
  async activateAccount(targetAccountId: string): Promise<boolean> {
    const runtimeAccounts = await loadGatewayAccounts(
      this.gatewayState.activeAccountId,
    );
    const target = runtimeAccounts.find(
      (account) => account.id === targetAccountId && account.isConfigured,
    );

    if (!target) {
      return false;
    }

    this.gatewayState = {
      ...this.gatewayState,
      activeAccountId: targetAccountId,
      lastRequestResult: `已将本地代理切换到 ${target.name}。`,
    };
    await saveGatewayState(this.gatewayState);
    await this.refreshAccounts();
    return true;
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
    const config = await readCodexProxyConfigStatus();
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
   * @returns 切换后的监控状态。
   */
  async setCodexProxyEnabled(enabled: boolean): Promise<CodexProxyStatus> {
    const config = await applyCodexProxyEnabledChange(enabled);
    this.codexProxyStatus = buildCodexProxyStatus(config, this.gatewayState);
    this.status = {
      ...this.status,
      codexProxy: this.codexProxyStatus,
    };

    this.emit({
      type: "codex.status_changed",
      payload: this.status,
    });

    return this.codexProxyStatus;
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
