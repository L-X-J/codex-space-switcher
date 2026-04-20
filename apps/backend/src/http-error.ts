/**
 * 本文件定义服务端路由会用到的轻量 HTTP 错误类型。
 * 这样业务模块可以抛出明确状态码，而不是全部退化成 500。
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string | null;

  /**
   * 构造一个带状态码的错误对象。
   *
   * @param statusCode HTTP 状态码。
   * @param message 需要返回给前端的错误文案。
   * @param options 可选的错误编码，用于前端区分“需要确认后继续”等交互场景。
   */
  constructor(
    statusCode: number,
    message: string,
    options: { code?: string } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = typeof options.code === "string" ? options.code : null;
  }
}
