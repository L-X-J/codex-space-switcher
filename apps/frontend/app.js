const state = {
  spaces: [],
  status: null,
  tokenUsage: null,
};

const elements = {
  refreshButton: document.querySelector("#refreshButton"),
  connectionBadge: document.querySelector("#connectionBadge"),
  activeSpaceLabel: document.querySelector("#activeSpaceLabel"),
  statusActiveName: document.querySelector("#statusActiveName"),
  statusLastSwitch: document.querySelector("#statusLastSwitch"),
  statusRuntime: document.querySelector("#statusRuntime"),
  statusRuntimeDetail: document.querySelector("#statusRuntimeDetail"),
  statusSwitchStage: document.querySelector("#statusSwitchStage"),
  statusSwitchMessage: document.querySelector("#statusSwitchMessage"),
  tokenTodayTotal: document.querySelector("#tokenTodayTotal"),
  tokenTodayDetail: document.querySelector("#tokenTodayDetail"),
  tokenWeekTotal: document.querySelector("#tokenWeekTotal"),
  tokenWeekDetail: document.querySelector("#tokenWeekDetail"),
  tokenActiveTotal: document.querySelector("#tokenActiveTotal"),
  tokenActiveDetail: document.querySelector("#tokenActiveDetail"),
  tokenLatestMeta: document.querySelector("#tokenLatestMeta"),
  tokenBreakdown: document.querySelector("#tokenBreakdown"),
  spacesGrid: document.querySelector("#spacesGrid"),
  spaceCardTemplate: document.querySelector("#spaceCardTemplate"),
};

/**
 * 初始化页面。
 *
 * @returns {Promise<void>}
 */
async function main() {
  elements.refreshButton?.addEventListener("click", refreshAll);
  await refreshAll();
  connectEvents();
}

/**
 * 刷新全部状态。
 *
 * @returns {Promise<void>}
 */
async function refreshAll() {
  const [spaces, status, tokenUsage] = await Promise.all([
    fetchJson("/api/spaces"),
    fetchJson("/api/status"),
    fetchJson("/api/token-usage"),
  ]);

  state.spaces = spaces;
  state.status = status;
  state.tokenUsage = tokenUsage;
  render();
}

/**
 * 建立 SSE 事件流。
 */
function connectEvents() {
  const events = new EventSource("/api/events");
  elements.connectionBadge.textContent = "实时连接中";

  events.addEventListener("spaces.updated", (event) => {
    state.spaces = JSON.parse(event.data);
    renderSpaces();
    renderTokenUsage();
  });

  events.addEventListener("codex.status_changed", (event) => {
    state.status = JSON.parse(event.data);
    renderStatus();
  });

  events.addEventListener("token_usage.updated", (event) => {
    state.tokenUsage = JSON.parse(event.data);
    renderTokenUsage();
  });

  for (const type of [
    "switch.queued",
    "switch.started",
    "switch.restart_started",
    "switch.verified",
    "switch.failed",
  ]) {
    events.addEventListener(type, async () => {
      await refreshAll();
    });
  }

  events.onerror = () => {
    elements.connectionBadge.textContent = "连接中断";
  };
}

/**
 * 获取 JSON 数据。
 *
 * @param {string} url 请求地址。
 * @param {RequestInit=} init 请求配置。
 * @returns {Promise<any>}
 */
async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`请求失败：${response.status}`);
  }

  return response.json();
}

/**
 * 渲染整个页面。
 */
function render() {
  renderStatus();
  renderTokenUsage();
  renderSpaces();
}

/**
 * 渲染顶部状态。
 */
function renderStatus() {
  const status = state.status;
  if (!status) {
    return;
  }

  elements.activeSpaceLabel.textContent = status.activeSpaceName ?? "未识别空间";
  elements.statusActiveName.textContent = status.activeSpaceName ?? "未识别空间";
  elements.statusLastSwitch.textContent =
    status.lastSwitchResult ?? "尚无切换记录";
  elements.statusRuntime.textContent = translateRuntimeState(status.runtime.state);
  elements.statusRuntimeDetail.textContent = status.runtime.detail;
  elements.statusSwitchStage.textContent = translateSwitchStage(status.switchJob.stage);
  elements.statusSwitchMessage.textContent = status.switchJob.message;
}

/**
 * 渲染 token 用量总览。
 */
function renderTokenUsage() {
  const tokenUsage = state.tokenUsage;
  if (!tokenUsage) {
    return;
  }

  const activeKind = getActiveSpaceKind();
  const activeToday =
    tokenUsage.today.byKind.find((item) => item.kind === activeKind) ?? null;
  const latestSession = tokenUsage.latestSession;

  elements.tokenTodayTotal.textContent = formatTokenCount(
    tokenUsage.today.totals.totalTokens,
  );
  elements.tokenTodayDetail.textContent = formatTokenWindowDetail(
    tokenUsage.today,
    activeToday,
  );

  elements.tokenWeekTotal.textContent = formatTokenCount(
    tokenUsage.last7Days.totals.totalTokens,
  );
  elements.tokenWeekDetail.textContent = formatTokenWindowDetail(
    tokenUsage.last7Days,
    tokenUsage.last7Days.byKind.find((item) => item.kind === activeKind) ?? null,
  );

  elements.tokenActiveTotal.textContent = activeToday
    ? formatTokenCount(activeToday.totals.totalTokens)
    : "暂无";
  elements.tokenActiveDetail.textContent = activeToday
    ? `${formatKindLabel(activeToday.kind)} 今日 ${activeToday.sessions} 场 rollout`
    : "当前空间今天还没有识别到 token 记录";

  elements.tokenLatestMeta.textContent = latestSession
    ? `${formatKindLabel(latestSession.kind)} · ${new Date(latestSession.capturedAt).toLocaleString()}`
    : "还没有读取到最近 rollout";
  elements.tokenBreakdown.textContent = latestSession
    ? formatBreakdown(latestSession.totals)
    : "等待本地 token_count 事件";
}

/**
 * 渲染空间卡片。
 */
function renderSpaces() {
  elements.spacesGrid.innerHTML = "";

  for (const space of state.spaces) {
    const fragment = elements.spaceCardTemplate.content.cloneNode(true);
    const root = fragment.querySelector(".space-card");
    const button = fragment.querySelector(".switch-button");

    fragment.querySelector(".space-kind").textContent = space.kind;
    fragment.querySelector(".space-name").textContent = space.name;

    const health = fragment.querySelector(".space-health");
    health.textContent = translateHealth(space.health);
    health.dataset.health = space.health;

    fragment.querySelector(".metric-usage").textContent = formatUsage(space);
    fragment.querySelector(".metric-remaining").textContent = formatRemaining(space);
    fragment.querySelector(".space-checked-at").textContent = new Date(
      space.lastCheckedAt,
    ).toLocaleString();
    fragment.querySelector(".space-diagnostics").textContent =
      space.rawDiagnostics[0] ?? "当前未返回额外诊断。";

    button.disabled = Boolean(space.isActive);
    button.textContent = space.isActive ? "当前已激活" : "切换到此空间";
    button.addEventListener("click", () => switchSpace(space.id));

    if (space.isActive) {
      root.style.borderColor = "rgba(105, 210, 162, 0.42)";
    }

    elements.spacesGrid.appendChild(fragment);
  }
}

/**
 * 执行切换请求。
 *
 * @param {string} targetSpaceId 目标空间 ID。
 * @returns {Promise<void>}
 */
async function switchSpace(targetSpaceId) {
  await fetchJson("/api/switch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      targetSpaceId,
    }),
  });

  await refreshAll();
}

/**
 * 格式化用量展示。
 *
 * @param {any} space 空间对象。
 * @returns {string}
 */
function formatUsage(space) {
  if (!space.usageSummary) {
    if (space.quotaSummary?.label) {
      return prettifyPlanLabel(space.quotaSummary.label);
    }

    return "无数字额度";
  }

  const used = space.usageSummary.used ?? "--";
  const limit = space.usageSummary.limit ?? "--";
  const unitSuffix = space.usageSummary.unit === "%" ? "%" : "";
  return `${used}${unitSuffix} / ${limit}${unitSuffix}`;
}

/**
 * 格式化剩余额度展示。
 *
 * @param {any} space 空间对象。
 * @returns {string}
 */
function formatRemaining(space) {
  if (space.quotaSummary?.remaining !== null && space.quotaSummary?.remaining !== undefined) {
    return formatMetricValue(space.quotaSummary.remaining, "%");
  }

  if (space.usageSummary?.remaining !== null && space.usageSummary?.remaining !== undefined) {
    return formatMetricValue(space.usageSummary.remaining, space.usageSummary.unit);
  }

  if (space.quotaSummary?.periodEndsAt) {
    const countdown = formatCountdown(space.quotaSummary.periodEndsAt);
    return countdown ?? new Date(space.quotaSummary.periodEndsAt).toLocaleDateString();
  }

  return "暂无额度字段";
}

/**
 * 读取当前激活空间的类型。
 *
 * @returns {string | null}
 */
function getActiveSpaceKind() {
  const active = state.spaces.find((space) => space.isActive);
  return active?.kind ?? null;
}

/**
 * 格式化 token 数量，避免大数字难读。
 *
 * @param {number} value token 数量。
 * @returns {string}
 */
function formatTokenCount(value) {
  return new Intl.NumberFormat("zh-CN").format(value ?? 0);
}

/**
 * 格式化 token 统计卡片的辅助说明。
 *
 * @param {any} windowSummary 时间窗口摘要。
 * @param {any} activeKindSummary 当前空间类型对应的摘要。
 * @returns {string}
 */
function formatTokenWindowDetail(windowSummary, activeKindSummary) {
  const sessionText = `${windowSummary.sessions} 场 rollout`;
  const activeText = activeKindSummary
    ? `，${formatKindLabel(activeKindSummary.kind)} 占 ${formatTokenCount(activeKindSummary.totals.totalTokens)}`
    : "";
  return `${sessionText}${activeText}`;
}

/**
 * 把一组 token 明细格式化成可读文本。
 *
 * @param {any} totals token 明细。
 * @returns {string}
 */
function formatBreakdown(totals) {
  return [
    `输入 ${formatTokenCount(totals.inputTokens)}`,
    `缓存 ${formatTokenCount(totals.cachedInputTokens)}`,
    `输出 ${formatTokenCount(totals.outputTokens)}`,
    `推理 ${formatTokenCount(totals.reasoningOutputTokens)}`,
  ].join(" · ");
}

/**
 * 把空间类型转成中文短标签。
 *
 * @param {string | null} kind 空间类型。
 * @returns {string}
 */
function formatKindLabel(kind) {
  if (kind === "plus") {
    return "Plus";
  }

  if (kind === "team") {
    return "Team";
  }

  return "Unknown";
}

/**
 * 把运行态枚举翻译成中文。
 *
 * @param {string} state 运行态枚举。
 * @returns {string}
 */
function translateRuntimeState(state) {
  if (state === "running") {
    return "运行中";
  }

  if (state === "busy") {
    return "忙碌中";
  }

  if (state === "stopped") {
    return "未运行";
  }

  return "探测中";
}

/**
 * 把切换阶段翻译成中文。
 *
 * @param {string} stage 切换阶段枚举。
 * @returns {string}
 */
function translateSwitchStage(stage) {
  const labels = {
    idle: "空闲",
    queued: "已排队",
    preparing: "准备中",
    switching: "切换中",
    restart_started: "重启中",
    verifying: "校验中",
    completed: "已完成",
    failed: "失败",
  };

  return labels[stage] ?? stage;
}

/**
 * 把健康状态翻译成中文。
 *
 * @param {string} health 健康状态枚举。
 * @returns {string}
 */
function translateHealth(health) {
  const labels = {
    healthy: "正常",
    warning: "预警",
    exhausted: "耗尽",
    error: "错误",
  };

  return labels[health] ?? health;
}

/**
 * 按单位格式化数值，避免百分比被显示成裸数字。
 *
 * @param {number|string} value 原始数值。
 * @param {string|null|undefined} unit 单位。
 * @returns {string}
 */
function formatMetricValue(value, unit) {
  return unit === "%" ? `${value}%` : String(value);
}

/**
 * 把私有 plan id 转成更适合展示的短标签。
 *
 * @param {string} label 原始计划名。
 * @returns {string}
 */
function prettifyPlanLabel(label) {
  return label
    .replace(/^chatgpt/i, "")
    .replace(/plan$/i, "")
    .replace(/workspace/gi, "Workspace ")
    .replace(/team/gi, "Team ")
    .replace(/plus/gi, "Plus ")
    .replace(/\s+/g, " ")
    .trim() || label;
}

/**
 * 根据到期时间生成剩余天数文案。
 *
 * @param {string} isoString ISO 时间字符串。
 * @returns {string | null}
 */
function formatCountdown(isoString) {
  const target = new Date(isoString);
  if (Number.isNaN(target.getTime())) {
    return null;
  }

  const diff = target.getTime() - Date.now();
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  if (days >= 0) {
    return `${days} 天后续期`;
  }

  return `${Math.abs(days)} 天前到期`;
}

void main();
