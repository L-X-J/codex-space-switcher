import type { CapturedUsage } from "./response-usage-capture.ts";
import { extractUsageFromPayload } from "./response-usage-capture.ts";

/**
 * 本文件负责从服务端发回的 WebSocket 数据帧中提取 `/responses` usage。
 * 代理本身不改写帧内容，只在旁路解析文本消息，供会话结束后落 usage 事件。
 */

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/**
 * 增量解析 WebSocket 文本帧，并提取其中的 usage 消息。
 */
export class WebSocketUsageCollector {
  private buffer = Buffer.alloc(0);

  private fragmentedOpcode: number | null = null;

  private fragmentedChunks: Buffer[] = [];

  private best: CapturedUsage | null = null;

  private readonly emittedResponseKeys = new Set<string>();

  private hasEmittedFinalMessage = false;

  /**
   * 喂入一段来自上游服务端的原始 WebSocket 字节。
   *
   * @param chunk 原始 TCP 数据块。
   * @returns 当前数据块中识别到的 usage 消息。
   */
  pushChunk(chunk: Buffer): WebSocketUsageMessage[] {
    const messages: WebSocketUsageMessage[] = [];
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.consumeFrames(messages);
    return messages;
  }

  /**
   * 返回当前会话里尚未发出的残余 usage。
   *
   * @returns 若连接关闭前只看到累计 token_count 而没有 completed 事件，则返回一条兜底消息。
   */
  finish(): WebSocketUsageMessage[] {
    if (!this.best) {
      return [];
    }

    if (this.hasEmittedFinalMessage) {
      return [];
    }

    if (this.emittedResponseKeys.has(FALLBACK_MESSAGE_KEY)) {
      return [];
    }

    this.emittedResponseKeys.add(FALLBACK_MESSAGE_KEY);
    return [
      {
        usage: this.best,
        responseId: null,
        model: null,
        type: "usage.fallback",
        isFinal: true,
      },
    ];
  }

  /**
   * 从当前缓冲区中尽可能消费完整帧。
   *
   * @param messages 当前批次累计出的 usage 消息。
   * @returns 无返回值。
   */
  private consumeFrames(messages: WebSocketUsageMessage[]): void {
    while (true) {
      const parsed = tryParseFrame(this.buffer);
      if (!parsed) {
        return;
      }

      this.buffer = this.buffer.subarray(parsed.frameLength);
      this.consumeFrame(parsed, messages);
    }
  }

  /**
   * 消费单个已解码的 WebSocket 帧。
   *
   * @param frame 已解析帧。
   * @param messages 当前批次累计出的 usage 消息。
   * @returns 无返回值。
   */
  private consumeFrame(
    frame: ParsedWebSocketFrame,
    messages: WebSocketUsageMessage[],
  ): void {
    if (
      frame.opcode === OPCODE_CLOSE ||
      frame.opcode === OPCODE_PING ||
      frame.opcode === OPCODE_PONG
    ) {
      return;
    }

    if (frame.opcode === OPCODE_BINARY) {
      this.fragmentedOpcode = frame.fin ? null : OPCODE_BINARY;
      this.fragmentedChunks = frame.fin ? [] : [frame.payload];
      return;
    }

    if (frame.opcode === OPCODE_TEXT) {
      if (frame.fin) {
        this.consumeTextPayload(frame.payload, messages);
        return;
      }

      this.fragmentedOpcode = OPCODE_TEXT;
      this.fragmentedChunks = [frame.payload];
      return;
    }

    if (frame.opcode !== OPCODE_CONTINUATION || this.fragmentedOpcode === null) {
      return;
    }

    this.fragmentedChunks.push(frame.payload);
    if (!frame.fin) {
      return;
    }

    if (this.fragmentedOpcode === OPCODE_TEXT) {
      this.consumeTextPayload(Buffer.concat(this.fragmentedChunks), messages);
    }

    this.fragmentedOpcode = null;
    this.fragmentedChunks = [];
  }

  /**
   * 尝试把文本消息解析成 JSON usage。
   *
   * @param payload 文本帧负载。
   * @param messages 当前批次累计出的 usage 消息。
   * @returns 无返回值。
   */
  private consumeTextPayload(
    payload: Buffer,
    messages: WebSocketUsageMessage[],
  ): void {
    try {
      const text = payload.toString("utf8");
      const parsed = parseWebSocketUsageMessage(JSON.parse(text));
      const usage = parsed?.usage ?? null;
      if (usage && shouldReplaceUsage(this.best, usage)) {
        this.best = usage;
      }
      if (!parsed?.isFinal) {
        return;
      }

      const messageKey = parsed.responseId || `${FALLBACK_MESSAGE_KEY}:${usage.totalTokens}`;
      if (this.emittedResponseKeys.has(messageKey)) {
        return;
      }

      this.emittedResponseKeys.add(messageKey);
      this.hasEmittedFinalMessage = true;
      messages.push(parsed);
    } catch {
      // WebSocket 文本消息里可能只是增量片段或非 JSON 控制消息，这里直接忽略。
    }
  }
}

export interface WebSocketUsageMessage {
  usage: CapturedUsage;
  responseId: string | null;
  model: string | null;
  type: string;
  isFinal: boolean;
}

interface ParsedWebSocketFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  frameLength: number;
}

const FALLBACK_MESSAGE_KEY = "__fallback__";

/**
 * 判断新 usage 是否应覆盖当前缓存。
 *
 * @param current 当前最佳结果。
 * @param candidate 新候选结果。
 * @returns 应替换时返回 `true`。
 */
function shouldReplaceUsage(
  current: CapturedUsage | null,
  candidate: CapturedUsage,
): boolean {
  if (!current) {
    return true;
  }

  return candidate.totalTokens >= current.totalTokens;
}

/**
 * 从单条 WebSocket 文本消息中提取 usage 及其归属元数据。
 *
 * @param payload 已解析的 JSON 消息。
 * @returns 当消息携带可用 usage 时返回结构化结果，否则返回 `null`。
 */
function parseWebSocketUsageMessage(payload: unknown): WebSocketUsageMessage | null {
  const usage = extractUsageFromPayload(payload);
  if (!usage) {
    return null;
  }

  const record = asRecord(payload);
  const payloadType = typeof record?.["type"] === "string" ? record["type"] : "unknown";
  const response = asRecord(record?.["response"]);
  const responseId = typeof response?.["id"] === "string" ? response["id"] : null;
  const model = typeof response?.["model"] === "string" ? response["model"] : null;

  return {
    usage,
    responseId,
    model,
    type: payloadType,
    isFinal: payloadType === "response.completed",
  };
}

/**
 * 把未知值收敛成对象字典。
 *
 * @param value 任意值。
 * @returns 对象字典；非对象时返回 `null`。
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

/**
 * 尝试从缓冲区头部解析一个完整 WebSocket 帧。
 *
 * @param buffer 当前缓冲区。
 * @returns 完整帧；若数据还不够则返回 `null`。
 */
function tryParseFrame(buffer: Buffer): ParsedWebSocketFrame | null {
  if (buffer.length < 2) {
    return null;
  }

  const firstByte = buffer[0] ?? 0;
  const secondByte = buffer[1] ?? 0;
  const fin = (firstByte & 0x80) !== 0;
  const opcode = firstByte & 0x0f;
  const masked = (secondByte & 0x80) !== 0;

  let offset = 2;
  let payloadLength = secondByte & 0x7f;

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }

    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("WebSocket 帧过大，超出本地 usage 解析器支持范围。");
    }
    payloadLength = Number(bigLength);
    offset += 8;
  }

  const maskLength = masked ? 4 : 0;
  const frameLength = offset + maskLength + payloadLength;
  if (buffer.length < frameLength) {
    return null;
  }

  const maskOffset = offset;
  const payloadOffset = offset + maskLength;
  const rawPayload = buffer.subarray(payloadOffset, frameLength);
  const payload = masked
    ? unmaskPayload(rawPayload, buffer.subarray(maskOffset, payloadOffset))
    : rawPayload;

  return {
    fin,
    opcode,
    payload,
    frameLength,
  };
}

/**
 * 解除客户端或异常服务端发送的掩码负载。
 *
 * @param payload 原始负载。
 * @param mask 4 字节掩码。
 * @returns 解码后的负载副本。
 */
function unmaskPayload(payload: Buffer, mask: Buffer): Buffer {
  const output = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    output[index] = payload[index]! ^ mask[index % 4]!;
  }
  return output;
}
