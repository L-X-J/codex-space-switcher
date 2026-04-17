/**
 * 本文件集中维护页面展示所需的文本格式化函数。
 * 看板里同一类数字在多个区域都会复用，统一格式能减少视觉噪声。
 */

/**
 * 格式化 token 数量。
 *
 * @param {number} value 原始 token 数量。
 * @returns {string}
 */
export function formatTokenCount(value) {
  return new Intl.NumberFormat("zh-CN").format(value ?? 0);
}

/**
 * 格式化美元金额。
 *
 * @param {number} value 原始金额。
 * @returns {string}
 */
export function formatCurrency(value) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 1 ? 2 : 4,
    maximumFractionDigits: value >= 1 ? 2 : 4,
  }).format(value ?? 0);
}

/**
 * 格式化百分比剩余额度。
 *
 * @param {number | null} value 原始百分比。
 * @returns {string}
 */
export function formatPercent(value) {
  return value === null || value === undefined ? "--" : `${Math.round(value)}%`;
}

/**
 * 格式化账号类型标签。
 *
 * @param {string} kind 账号类型。
 * @returns {string}
 */
export function formatAccountKind(kind) {
  return kind === "official" ? "官方" : "第三方";
}

/**
 * 格式化代理客户端类型标签。
 *
 * @param {string | null | undefined} kind 客户端类型。
 * @returns {string}
 */
export function formatProxyClientKind(kind) {
  const labels = {
    codex: "Codex",
    curl: "curl",
    browser: "浏览器",
    unknown: "未知客户端",
  };

  if (!kind) {
    return "--";
  }

  return labels[kind] ?? kind;
}

/**
 * 把健康状态翻译成中文。
 *
 * @param {string} health 健康状态。
 * @returns {string}
 */
export function translateHealth(health) {
  const labels = {
    healthy: "正常",
    warning: "预警",
    exhausted: "耗尽",
    error: "错误",
  };

  return labels[health] ?? health;
}

/**
 * 格式化时间戳。
 *
 * @param {string | null} value ISO 时间字符串。
 * @returns {string}
 */
export function formatDateTime(value) {
  if (!value) {
    return "--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return date.toLocaleString("zh-CN", { hour12: false });
}

/**
 * 生成“距离重置还有多久”的短文案。
 *
 * @param {string | null} value ISO 时间字符串。
 * @returns {string}
 */
export function formatResetCountdown(value) {
  if (!value) {
    return "--";
  }

  const target = new Date(value);
  if (Number.isNaN(target.getTime())) {
    return "--";
  }

  const diffMs = target.getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / (1000 * 60));

  if (diffMinutes <= 0) {
    return "已重置";
  }

  if (diffMinutes < 60) {
    return `${diffMinutes} 分钟后重置`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 48) {
    return `${diffHours} 小时后重置`;
  }

  const diffDays = Math.round(diffHours / 24);
  return `${diffDays} 天后重置`;
}

/**
 * 生成某个统计窗口底部的简短说明。
 *
 * @param {any} windowSummary 时间窗口数据。
 * @returns {string}
 */
export function formatWindowMeta(windowSummary) {
  const requests = windowSummary?.totals?.requests ?? 0;
  const start = formatDateTime(windowSummary?.windowStart ?? null);
  return `${requests} 次请求 · 起点 ${start}`;
}
