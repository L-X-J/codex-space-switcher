import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 读取 JSON 文件并在文件不存在时返回空值。
 *
 * @param filePath 文件绝对路径。
 * @returns 解析后的 JSON 对象；不存在时返回 `null`。
 * @throws 当文件存在但 JSON 非法时抛出异常，避免把损坏配置误当成空状态。
 */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  const { readFile } = await import("node:fs/promises");

  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

/**
 * 原子化写入 JSON 文件。
 *
 * @param filePath 文件绝对路径。
 * @param data 需要持久化的数据对象。
 * @returns 无返回值。
 * @throws 当目录不可写或序列化失败时抛出异常。
 */
export async function writeJsonFile(
  filePath: string,
  data: unknown,
): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

/**
 * 执行一个本地命令并返回标准输出。
 *
 * @param command 可执行程序路径。
 * @param args 命令参数列表。
 * @returns 命令输出与退出码。
 * @throws 当命令无法启动时直接抛出异常。
 */
export async function runCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * 执行 SQLite 查询并返回原始文本结果。
 *
 * @param sqlitePath SQLite 数据库文件路径。
 * @param sql SQL 查询语句。
 * @returns `sqlite3` 返回的原始文本内容。
 * @throws 当 sqlite3 不存在、数据库损坏或 SQL 非法时抛出异常。
 */
export async function runSql(sqlitePath: string, sql: string): Promise<string> {
  const { stdout } = await runCommand("sqlite3", [sqlitePath, sql]);
  return stdout.trim();
}

/**
 * 睡眠指定毫秒数。
 *
 * @param milliseconds 等待时长，单位毫秒。
 * @returns 在计时结束后完成。
 */
export async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * 生成一个简短的任务标识符，便于在本地状态与 SSE 事件中追踪切换任务。
 *
 * @returns 短格式任务 ID。
 */
export function createId(): string {
  return `job_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * 安全解码 JWT 负载。
 *
 * @param token JWT 原文。
 * @returns 负载对象；若 token 非法则返回 `null`。
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");

  if (segments.length < 2) {
    return null;
  }

  try {
    const raw = Buffer.from(segments[1]!, "base64url").toString("utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 判断一个错误是否具备 Node.js 风格的 `code` 字段。
 *
 * @param error 任意异常对象。
 * @returns 当异常满足 Node 错误结构时返回 `true`。
 */
export function isNodeError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

/**
 * 将任意异常格式化为可展示的文本。
 *
 * @param error 任意异常对象。
 * @returns 适合记录在诊断面板中的字符串。
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "未知错误";
  }
}

/**
 * 尝试从任意对象中读取第一个字符串字段。
 *
 * @param source 来源对象。
 * @param keys 按优先级排列的候选字段名。
 * @returns 命中的字符串；若都不存在则返回 `null`。
 */
export function pickString(
  source: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

/**
 * 尝试从任意对象中读取第一个数字字段。
 *
 * @param source 来源对象。
 * @param keys 按优先级排列的候选字段名。
 * @returns 命中的数字；若都不存在则返回 `null`。
 */
export function pickNumber(
  source: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

/**
 * 判断一段文本中是否包含可能表示“团队”空间的关键词。
 *
 * @param value 输入文本。
 * @returns 命中 Team 语义时返回 `true`。
 */
export function looksLikeTeam(value: string): boolean {
  return /team|workspace|org|organization/i.test(value);
}

/**
 * 判断一段文本中是否包含可能表示“个人 Plus”空间的关键词。
 *
 * @param value 输入文本。
 * @returns 命中个人订阅语义时返回 `true`。
 */
export function looksLikePlus(value: string): boolean {
  return /plus|personal|individual|pro/i.test(value);
}
