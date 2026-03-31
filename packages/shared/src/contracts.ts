/**
 * 本文件定义前后端共享的数据契约。
 * 这些类型会约束 REST 与 SSE 负载，避免前后端各自猜测字段形态。
 */

export type SpaceKind = "plus" | "team" | "unknown";

export type HealthStatus = "healthy" | "warning" | "exhausted" | "error";

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
  runtime: CodexRuntimeStatus;
  switchJob: SwitchJob;
  lastSwitchResult: string | null;
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
 * 统一描述 SSE 推送事件，便于前端做分发与日志展示。
 */
export interface ServerEvent<TPayload> {
  type:
    | "spaces.updated"
    | "switch.queued"
    | "switch.started"
    | "switch.restart_started"
    | "switch.verified"
    | "switch.failed"
    | "codex.status_changed"
    | "token_usage.updated";
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
