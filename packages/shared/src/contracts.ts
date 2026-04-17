/**
 * 本文件定义前后端共享的数据契约。
 * 这些类型会约束 REST 与 SSE 负载，避免前后端各自猜测字段形态。
 */

export type SpaceKind = "plus" | "team" | "unknown";

export type HealthStatus = "healthy" | "warning" | "exhausted" | "error";

export type AccountKind = "official" | "third_party";

export type ProxyClientKind = "codex" | "curl" | "browser" | "unknown";

export type SwitchJobStage =
  | "idle"
  | "queued"
  | "preparing"
  | "switching"
  | "restart_started"
  | "verifying"
  | "completed"
  | "failed";

export type CodexRuntimeState = "running" | "stopped" | "busy" | "unknown";

export type UsageFilterKind = "all" | "account_kind" | "account";

/**
 * 描述一次用量快照，尽量兼容分钟、日或账期级别的私有接口返回。
 */
export interface UsageSnapshot {
  unit: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  percentUsed: number | null;
  windowLabel: string | null;
}

/**
 * 描述额度或订阅级别的摘要信息。
 */
export interface QuotaSnapshot {
  label: string | null;
  hardLimit: number | null;
  softLimit: number | null;
  remaining: number | null;
  periodEndsAt: string | null;
}

/**
 * 描述一个空间卡片在 UI 中所需的完整信息。
 */
export interface SpaceCard {
  id: string;
  name: string;
  kind: SpaceKind;
  isActive: boolean;
  usageSummary: UsageSnapshot | null;
  quotaSummary: QuotaSnapshot | null;
  health: HealthStatus;
  lastCheckedAt: string;
  rawDiagnostics: string[];
}

/**
 * 描述官方账号返回的 5 小时或 1 周额度窗口。
 */
export interface OfficialUsageWindow {
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
}

/**
 * 描述官方账号的实时额度状态。
 */
export interface OfficialUsageSnapshot {
  planType: string | null;
  allowed: boolean | null;
  limitReached: boolean | null;
  balance: number | null;
  primary: OfficialUsageWindow | null;
  secondary: OfficialUsageWindow | null;
}

/**
 * 描述一次聚合后的 token 与费用统计。
 */
export interface AccountUsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  requests: number;
}

/**
 * 描述单个账号卡片在 UI 中所需的完整信息。
 */
export interface AccountCard {
  id: string;
  name: string;
  kind: AccountKind;
  isActive: boolean;
  health: HealthStatus;
  statusLabel: string;
  lastCheckedAt: string | null;
  officialUsage: OfficialUsageSnapshot | null;
  cumulativeUsage: AccountUsageTotals;
  rawDiagnostics: string[];
}

/**
 * 描述切换动作的请求体。
 */
export interface SwitchRequestBody {
  targetSpaceId: string;
}

/**
 * 描述当前切换任务的状态。
 */
export interface SwitchJob {
  id: string;
  targetSpaceId: string | null;
  targetSpaceName: string | null;
  stage: SwitchJobStage;
  message: string;
  createdAt: string | null;
  updatedAt: string | null;
  error: string | null;
}

/**
 * 描述 Codex Desktop 当前的运行态。
 */
export interface CodexRuntimeStatus {
  state: CodexRuntimeState;
  isBusy: boolean;
  lastObservedAt: string;
  detail: string;
}

/**
 * 描述状态面板顶部所需的整体摘要。
 */
export interface DashboardStatus {
  activeSpaceId: string | null;
  activeSpaceName: string | null;
  activeAccountId?: string | null;
  activeAccountName?: string | null;
  runtime: CodexRuntimeStatus;
  switchJob: SwitchJob;
  lastSwitchResult: string | null;
  gateway?: GatewayStatus;
  codexProxy?: CodexProxyStatus;
}

/**
 * 描述本地代理网关的当前状态。
 */
export interface GatewayStatus {
  listenBaseUrl: string;
  responsesPath: string;
  modelsPath: string;
  activeAccountId: string | null;
  activeAccountName: string | null;
  lastRequestAt: string | null;
  lastRequestModel: string | null;
  lastRequestResult: string | null;
  lastRequestClientKind?: ProxyClientKind | null;
  lastRequestClientLabel?: string | null;
  lastCodexRequestAt?: string | null;
}

/**
 * 描述最近一次代理请求的客户端身份摘要。
 */
export interface ProxyClientSnapshot {
  kind: ProxyClientKind;
  label: string;
  lastSeenAt: string | null;
}

/**
 * 描述 `~/.codex/config.toml` 当前的接管状态。
 */
export interface CodexProxyConfigStatus {
  configPath: string;
  providerName: string;
  currentModelProvider: string | null;
  currentProviderBaseUrl: string | null;
  configuredBaseUrl: string | null;
  expectedBaseUrl: string;
  isEnabled: boolean;
  diagnostics: string[];
}

/**
 * 描述控制台里“Codex 是否正在走本地代理”的监控状态。
 */
export interface CodexProxyStatus {
  config: CodexProxyConfigStatus;
  recentWindowMinutes: number;
  lastProxyRequestAt: string | null;
  lastCodexRequestAt: string | null;
  isCodexTrafficRecent: boolean;
  lastProxyClient: ProxyClientSnapshot | null;
}

/**
 * 描述一组 token 用量明细。
 */
export interface TokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

/**
 * 描述某个空间类型下的 token 聚合结果。
 */
export interface TokenUsageByKind {
  kind: SpaceKind;
  totals: TokenTotals;
  sessions: number;
}

/**
 * 描述一个时间窗口内的 token 聚合结果。
 */
export interface TokenUsageWindow {
  label: string;
  windowStart: string | null;
  windowEnd: string | null;
  totals: TokenTotals;
  sessions: number;
  byKind: TokenUsageByKind[];
}

/**
 * 描述最近一次可识别 rollout 的 token 摘要。
 */
export interface LatestTokenUsageSnapshot {
  capturedAt: string;
  kind: SpaceKind;
  totals: TokenTotals;
  sourceFile: string;
}

/**
 * 描述控制台顶部使用的 token 用量总览。
 */
export interface TokenUsageSummary {
  generatedAt: string;
  today: TokenUsageWindow;
  last7Days: TokenUsageWindow;
  latestSession: LatestTokenUsageSnapshot | null;
}

/**
 * 描述前端可用的统计筛选项。
 */
export interface UsageFilterOption {
  id: string;
  label: string;
  kind: UsageFilterKind;
  accountId: string | null;
  accountKind: AccountKind | null;
}

/**
 * 描述某个统计时间窗口的聚合结果。
 */
export interface UsageDashboardWindow {
  label: string;
  windowStart: string | null;
  windowEnd: string | null;
  totals: AccountUsageTotals;
}

/**
 * 描述筛选后的统计面板摘要。
 */
export interface UsageDashboardSummary {
  generatedAt: string;
  selectedFilterId: string;
  filters: UsageFilterOption[];
  cumulative: UsageDashboardWindow;
  last5Hours: UsageDashboardWindow;
  last7Days: UsageDashboardWindow;
}

/**
 * 描述一次由本地代理捕获到的 token 用量事件。
 */
export interface UsageEventRecord {
  id: string;
  accountId: string;
  accountName: string;
  accountKind: AccountKind;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  status: string;
  latencyMs: number;
  createdAt: string;
}

/**
 * 描述切换本地代理激活账号的请求体。
 */
export interface ActivateAccountRequestBody {
  targetAccountId: string;
}

/**
 * 描述前端开关“是否接管 Codex 配置”的请求体。
 */
export interface SetCodexProxyEnabledRequestBody {
  enabled: boolean;
}

/**
 * 统一描述 SSE 推送事件，便于前端做分发与日志展示。
 */
export interface ServerEvent<TPayload> {
  type:
    | "accounts.updated"
    | "spaces.updated"
    | "switch.queued"
    | "switch.started"
    | "switch.restart_started"
    | "switch.verified"
    | "switch.failed"
    | "codex.status_changed"
    | "token_usage.updated"
    | "usage_dashboard.updated";
  payload: TPayload;
}

/**
 * 描述手工提供的切换提示。首版依赖私有接口，允许用手工配置兜底。
 */
export interface SwitchHint {
  method: "POST" | "PUT";
  path: string;
  body: Record<string, unknown>;
}

/**
 * 描述用户手工提供的空间信息。
 */
export interface ManualSpaceDefinition {
  id: string;
  name: string;
  kind: SpaceKind;
  switchHints?: SwitchHint[];
}
