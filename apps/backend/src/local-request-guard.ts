import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 本文件负责本地控制台与网关的请求来源校验。
 *
 * 本服务没有登录体系，只靠“监听 127.0.0.1”无法挡住浏览器发起的攻击：
 * - CSRF：任意网页都能向 127.0.0.1 发 `text/plain` 简单请求，绕过 CORS 预检；
 * - DNS rebinding：恶意域名解析到 127.0.0.1 后，网页就能以同源身份读取接口响应。
 *
 * 因此这里提供三层防护：
 * 1. Host 白名单：所有 HTTP / WebSocket 请求的 Host 必须是本机地址，挡住 DNS rebinding；
 * 2. Origin / Sec-Fetch-Site 校验：拒绝来自其他网页的跨站请求；
 * 3. 控制台 token：`/api/*` 必须携带每次启动随机生成的 token（自定义请求头会强制触发
 *    CORS 预检，而本服务不响应预检，因此跨站网页无法伪造）。
 */

export const CONTROL_TOKEN_HEADER = "x-switcher-token";
export const CONTROL_TOKEN_QUERY_PARAM = "token";
export const ALLOWED_HOSTS_ENV = "CODEX_SPACE_SWITCHER_ALLOWED_HOSTS";

export interface GuardRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

export type GuardResult =
  | { ok: true }
  | { ok: false; statusCode: number; reason: string };

/**
 * 生成本次进程使用的控制台 token。
 *
 * @returns 32 字节随机数的十六进制字符串。
 */
export function generateControlToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * 计算允许的 Host 头集合。
 *
 * @param host 服务监听地址。
 * @param port 服务端口。
 * @param extraHosts 额外允许的 host（逗号分隔，通常来自环境变量）。
 * @returns 小写的 `host:port` 集合。
 */
export function buildAllowedHosts(
  host: string,
  port: number,
  extraHosts: string | undefined = process.env[ALLOWED_HOSTS_ENV],
): Set<string> {
  const hosts = new Set<string>([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);

  const normalizedHost = host.trim().toLowerCase();
  if (
    normalizedHost &&
    normalizedHost !== "0.0.0.0" &&
    normalizedHost !== "::"
  ) {
    hosts.add(
      normalizedHost.includes(":") && !normalizedHost.startsWith("[")
        ? `[${normalizedHost}]:${port}`
        : `${normalizedHost}:${port}`,
    );
  }

  for (const entry of (extraHosts ?? "").split(",")) {
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) {
      continue;
    }
    hosts.add(/:\d+$/.test(trimmed) ? trimmed : `${trimmed}:${port}`);
  }

  return hosts;
}

/**
 * 校验 Host 头是否属于本机白名单，用于防御 DNS rebinding。
 *
 * @param request 请求对象。
 * @param allowedHosts 允许的 Host 集合。
 * @returns 校验结果。
 */
export function checkHost(
  request: GuardRequest,
  allowedHosts: Set<string>,
): GuardResult {
  const host = readHeader(request, "host")?.trim().toLowerCase();
  if (!host || !allowedHosts.has(host)) {
    return {
      ok: false,
      statusCode: 421,
      reason: "Host 不在本机白名单内，请通过 http://127.0.0.1 访问控制台。",
    };
  }

  return { ok: true };
}

/**
 * 校验请求是否来自其他网页（跨站）。
 *
 * 只拒绝明确来自其他 http(s) 网页的请求；没有 Origin 的请求（Codex CLI、curl 等非浏览器客户端）
 * 以及 Electron 自定义协议来源保持放行，避免误伤 Codex App。
 *
 * @param request 请求对象。
 * @param allowedHosts 允许的 Host 集合。
 * @returns 校验结果。
 */
export function checkCrossSite(
  request: GuardRequest,
  allowedHosts: Set<string>,
): GuardResult {
  const fetchSite = readHeader(request, "sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite === "cross-site" || fetchSite === "same-site") {
    return {
      ok: false,
      statusCode: 403,
      reason: "拒绝来自其他网站的跨站请求。",
    };
  }

  const origin = readHeader(request, "origin")?.trim();
  if (!origin || origin === "null") {
    return origin === "null"
      ? { ok: false, statusCode: 403, reason: "拒绝来源为 null 的请求。" }
      : { ok: true };
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, statusCode: 403, reason: "Origin 格式不正确。" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: true };
  }

  if (!allowedHosts.has(parsed.host.toLowerCase())) {
    return {
      ok: false,
      statusCode: 403,
      reason: "拒绝来自其他网站的跨站请求。",
    };
  }

  return { ok: true };
}

/**
 * 校验控制台 token。
 *
 * @param request 请求对象。
 * @param url 已解析的请求 URL（用于 EventSource 这类无法设置请求头的场景）。
 * @param expectedToken 本次进程的 token。
 * @param allowQueryToken 是否允许从查询参数读取 token。
 * @returns 校验结果。
 */
export function checkControlToken(
  request: GuardRequest,
  url: URL,
  expectedToken: string,
  allowQueryToken = false,
): GuardResult {
  const provided =
    readHeader(request, CONTROL_TOKEN_HEADER) ??
    (allowQueryToken ? url.searchParams.get(CONTROL_TOKEN_QUERY_PARAM) : null);

  if (!provided || !safeEqual(provided, expectedToken)) {
    return {
      ok: false,
      statusCode: 401,
      reason: "缺少或无效的控制台 token，请刷新页面后重试。",
    };
  }

  return { ok: true };
}

/**
 * 把 token 注入到首页 HTML，供前端脚本读取。
 *
 * @param html 原始 index.html 内容。
 * @param token 本次进程的 token。
 * @returns 注入 `<meta name="switcher-token">` 后的 HTML。
 */
export function injectControlToken(html: string, token: string): string {
  const meta = `<meta name="switcher-token" content="${token}" />`;
  return html.includes("</head>")
    ? html.replace("</head>", `    ${meta}\n  </head>`)
    : `${meta}\n${html}`;
}

function readHeader(request: GuardRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
