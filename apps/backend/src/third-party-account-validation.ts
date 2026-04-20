import { joinUrl } from "./gateway-proxy-service.ts";
import { HttpError } from "./http-error.ts";

/**
 * 本文件集中处理第三方账号的保存前连通性测试。
 * 某些中转站只实现 `/responses`，不会暴露 `/models`，因此这里把“首次失败先提示、二次确认可跳过”
 * 的交互语义沉淀成一个可复用模块，避免新增与编辑流程各写一套分支。
 */

export const THIRD_PARTY_VALIDATION_CONFIRMATION_CODE =
  "third_party_validation_confirmation_required";

/**
 * 描述一次第三方保存前校验的输入参数。
 */
export interface ValidateThirdPartyAccountOptions {
  apiBaseUrl: string;
  apiKey: string;
  skipConnectivityCheck?: boolean;
}

/**
 * 保存前探测第三方接口是否可访问。
 *
 * @param options 校验选项。
 * @returns 无返回值。
 */
export async function validateThirdPartyAccount({
  apiBaseUrl,
  apiKey,
  skipConnectivityCheck = false,
}: ValidateThirdPartyAccountOptions): Promise<void> {
  if (skipConnectivityCheck) {
    return;
  }

  let response: Response;

  try {
    response = await fetch(joinUrl(apiBaseUrl, "/models"), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
  } catch (error) {
    throw buildConfirmationRequiredError(
      `第三方账号连通性测试失败：${formatUnknownError(error)}`,
    );
  }

  if (response.ok) {
    return;
  }

  const payload = await safeReadResponseText(response);
  if (response.status === 401) {
    throw buildConfirmationRequiredError(
      `第三方账号校验失败：API Key 被上游拒绝（401）。${payload}`,
    );
  }

  throw buildConfirmationRequiredError(
    `第三方账号校验失败：GET /models 返回 ${response.status}。${payload}`,
  );
}

/**
 * 根据“首次失败可重试确认”的约定，构造统一错误。
 *
 * @param reason 首次探测得到的具体失败原因。
 * @returns 带错误码的 HTTP 错误。
 */
function buildConfirmationRequiredError(reason: string): HttpError {
  return new HttpError(
    409,
    `${reason} 某些第三方中转站不会开放 /models。若你确认这个地址后续主要用于 /responses，请再次点击保存以跳过这一步校验。`,
    {
      code: THIRD_PARTY_VALIDATION_CONFIRMATION_CODE,
    },
  );
}

/**
 * 把未知异常格式化成稳定的用户可读文本。
 *
 * @param error 原始异常。
 * @returns 文本化后的错误原因。
 */
function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 读取上游响应文本，但只保留适合在表单提示中展示的简短摘要。
 *
 * @param response 上游 HTTP 响应。
 * @returns 截断后的文本摘要。
 */
async function safeReadResponseText(response: Response): Promise<string> {
  try {
    const rawText = await response.text();
    const diagnostic = rawText.trim().slice(0, 200);
    return diagnostic;
  } catch (error) {
    return `无法读取响应体：${formatUnknownError(error)}`;
  }
}
