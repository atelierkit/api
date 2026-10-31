// 外部依赖
import { inflateSync } from 'node:zlib';
// 内部依赖
import {
  CLIENT_VERSION,
  COMPRESSED_RESPONSE_TYPES,
  MESSAGE_END_MARK,
  MESSAGE_HEADER_LENGTH,
  MESSAGE_SPLIT,
} from './baostock.schema.js';

/**
 * baostock 帧编解码（纯函数，无 IO，可独立测试）
 *
 * 协议格式（`\x01` 为字段分隔符）：
 * ```
 * 请求： {版本}\x01{消息类型}\x01{10 位消息体长度}{消息体}\x01{CRC32}\n
 * 响应： 同上
 * ```
 */
export const BaostockProtocol = {
  /**
   * 按协议组帧一条请求消息
   *
   * 长度字段是「字符」数而不是字节数 —— baostock 的消息体只含 ASCII，两者恰好相同。
   * CRC32 按「头 + 体」的 UTF-8 字节计算，末尾附加一个 `\n`。
   */
  buildMessage(messageType: string, bodyFields: readonly string[]): string {
    const body = bodyFields.join(MESSAGE_SPLIT);
    const headAndBody = `${CLIENT_VERSION}${MESSAGE_SPLIT}${messageType}${MESSAGE_SPLIT}${pad10(
      body.length,
    )}${body}`;
    const crc = crc32(Buffer.from(headAndBody, 'utf8'));
    return `${headAndBody}${MESSAGE_SPLIT}${crc}\n`;
  },

  /**
   * 拆解一条完整响应
   *
   * 过程：取前 21 字节得到「版本 / 类型 / 长度」→ 若是压缩响应则解压消息体拼回 → 去掉头部 →
   * 仅在确实存在时去掉末尾的 `\n` → 按 `\x01` 切分。
   *
   * ⚠ 解压路径的末尾没有 `\n`（真机实测）：服务端的压缩体只包住正文，`\x01校验\n` 与结束标记
   * 都在压缩体之外。判据必须是「末尾究竟有没有 `\n`」，不能按路径分别硬编码。
   */
  splitResponse(raw: Buffer): string[] {
    if (raw.length < MESSAGE_HEADER_LENGTH) {
      throw new Error(
        `响应长度 ${raw.length} 字节，不足消息头长度 ${MESSAGE_HEADER_LENGTH} —— ` +
          '通常意味着对端在消息未发完时关闭了连接。',
      );
    }

    const header = raw.subarray(0, MESSAGE_HEADER_LENGTH).toString('utf8');
    const headerParts = header.split(MESSAGE_SPLIT);
    const responseMessageType = headerParts[1] ?? '';

    let responseText: string;
    if (COMPRESSED_RESPONSE_TYPES.has(responseMessageType)) {
      const bodyLength = Number.parseInt(headerParts[2] ?? '', 10);
      if (Number.isNaN(bodyLength)) {
        throw new Error(`压缩响应的长度字段无法解析：${header}。`);
      }
      if (MESSAGE_HEADER_LENGTH + bodyLength > raw.length) {
        throw new Error(
          `压缩响应声明消息体 ${bodyLength} 字节，实际只有 ${raw.length - MESSAGE_HEADER_LENGTH} 字节。`,
        );
      }
      const compressed = raw.subarray(
        MESSAGE_HEADER_LENGTH,
        MESSAGE_HEADER_LENGTH + bodyLength,
      );
      responseText = header + inflateSync(compressed).toString('utf8');
    } else {
      responseText = raw.toString('utf8');
    }

    let payloadLength = responseText.length - MESSAGE_HEADER_LENGTH;
    if (payloadLength > 0 && responseText[payloadLength - 1] === '\n') {
      payloadLength--;
    }

    return responseText
      .substring(MESSAGE_HEADER_LENGTH, MESSAGE_HEADER_LENGTH + payloadLength)
      .split(MESSAGE_SPLIT);
  },

  /** 解析响应头里的消息类型；报文头不足时返回空串 */
  responseMessageType(raw: Buffer): string {
    if (raw.length < MESSAGE_HEADER_LENGTH) {
      return '';
    }
    const header = raw.subarray(0, MESSAGE_HEADER_LENGTH).toString('utf8');
    const parts = header.split(MESSAGE_SPLIT);
    return parts[1] ?? '';
  },

  /** 判断字节序列是否以响应结束标记结尾（TCP 流式，只能靠它判断消息边界） */
  endsWithEndMark(buffer: Buffer): boolean {
    const mark = Buffer.from(MESSAGE_END_MARK, 'utf8');
    if (buffer.length < mark.length) {
      return false;
    }
    return buffer.subarray(buffer.length - mark.length).equals(mark);
  },
};

/** 把数字渲染成 10 位定长文本 */
function pad10(value: number): string {
  return value.toString().padStart(10, '0');
}

/**
 * CRC32 校验（IEEE 802.3 多项式，反射形式 `0xEDB88320`）
 *
 * 协议要求消息尾部附一个 CRC32，服务端据此校验报文完整性。算法与参照实现（`crc-32` 库）
 * 逐位一致 —— 换多项式或改变初始值 / 终值异或都会导致服务端直接拒绝，且报错不会指出是校验问题。
 * 输出为「无符号」十进制文本（JS 的 `>>> 0`）。
 */
export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 256 项查表（惰性构建一次） */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    table[index] = crc >>> 0;
  }
  return table;
})();
