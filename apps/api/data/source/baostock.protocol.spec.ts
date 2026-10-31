// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { BaostockProtocol, crc32 } from './baostock.protocol.js';
import { RecordParser } from './baostock.record.js';
import { BaostockQueries } from './baostock.query.js';
import {
  CLIENT_VERSION,
  MESSAGE_HEADER_LENGTH,
  MESSAGE_SPLIT,
  MESSAGE_TYPE,
  RECORD_INDEX,
  FIELD_INDEX,
} from './baostock.schema.js';

describe('baostock.protocol', () => {
  it('CRC32 与 crc-32 库标准向量一致', () => {
    // crc-32 库对 "123456789" 的标准结果是 0xCBF43926
    expect(crc32(Buffer.from('123456789', 'utf8'))).toBe(0xcbf43926);
    // 空串的结果是 0
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('buildMessage 组出正确的帧结构（头 21 字节 + 体 + 分隔符 + CRC + 换行）', () => {
    const msg = BaostockProtocol.buildMessage(MESSAGE_TYPE.LOGIN_REQUEST, [
      'login',
      'anonymous',
      '123456',
      '0',
    ]);
    // 头部：版本 + 分隔符 + 类型 + 分隔符 + 10 位长度
    const body = ['login', 'anonymous', '123456', '0'].join(MESSAGE_SPLIT);
    const expectedHeader = `${CLIENT_VERSION}${MESSAGE_SPLIT}${MESSAGE_TYPE.LOGIN_REQUEST}${MESSAGE_SPLIT}${body.length
      .toString()
      .padStart(10, '0')}`;
    expect(msg.startsWith(expectedHeader)).toBe(true);
    // 以换行结尾
    expect(msg.endsWith('\n')).toBe(true);

    // 拆开校验 CRC 字段是一个无符号十进制数
    const withoutNewline = msg.slice(0, -1);
    const parts = withoutNewline.split(MESSAGE_SPLIT);
    // parts = [版本, 类型, 长度+体(合并), crc]
    const crcText = parts[parts.length - 1];
    expect(Number(crcText)).toBeGreaterThanOrEqual(0);
    expect(crcText).not.toContain('-');
  });

  it('记录位 / 列名位常量钉死', () => {
    // 「按证券」类：记录 6 / 列名 9
    expect(RECORD_INDEX.DEFAULT).toBe(6);
    expect(FIELD_INDEX.DEFAULT).toBe(9);
    // 「按交易日」类：记录 4 / 列名 5
    expect(RECORD_INDEX.BY_DATE).toBe(4);
    expect(FIELD_INDEX.BY_DATE).toBe(5);
  });

  it('splitResponse 解析明文响应（登录/登出，只关心前两个字段）', () => {
    // 真机明文帧 = {头}{体}\x01{校验}\n<![CDATA[]]>\n；
    // 明文路径只用于登录/登出（无业务记录），关键字段是第 0/1 位（错误码/错误信息）。
    const raw = buildRawResponse('01', ['0', 'success']);
    const parts = BaostockProtocol.splitResponse(raw);
    expect(parts[0]).toBe('0');
    expect(parts[1]).toBe('success');
  });

  it('splitResponse 解析压缩响应（末尾无 \\n，不丢最后字符）', () => {
    // 构造一个「末尾字段以 'T' 结尾、且没有换行」的压缩响应
    const { deflateSync } = require('node:zlib') as typeof import('node:zlib');
    const bodyText = ['0', 'success', 'a', 'b', 'c', 'date,code,isST'].join(
      MESSAGE_SPLIT,
    );
    const compressed = deflateSync(Buffer.from(bodyText, 'utf8'));
    const header = `${CLIENT_VERSION}${MESSAGE_SPLIT}${MESSAGE_TYPE.ADJUST_FACTOR_RESPONSE}${MESSAGE_SPLIT}${compressed.length
      .toString()
      .padStart(10, '0')}`;
    const raw = Buffer.concat([
      Buffer.from(header, 'utf8'),
      compressed,
      Buffer.from(`${MESSAGE_SPLIT}1234567890\n<![CDATA[]]>\n`, 'utf8'),
    ]);
    const parts = BaostockProtocol.splitResponse(raw);
    // 列名是最后一段，必须以完整 'isST' 结尾（若误切换行会把 'T' 切掉）
    expect(parts[5]).toBe('date,code,isST');
  });

  it('响应消息类型从头部解析', () => {
    const raw = buildRawResponse('99', [], false);
    expect(BaostockProtocol.responseMessageType(raw)).toBe('99');
  });

  it('报文头不足时 responseMessageType 返回空串', () => {
    expect(BaostockProtocol.responseMessageType(Buffer.from('short'))).toBe('');
  });

  it('endsWithEndMark 正确判断消息边界', () => {
    const complete = Buffer.from(`...${'<![CDATA[]]>\n'}`, 'utf8');
    expect(BaostockProtocol.endsWithEndMark(complete)).toBe(true);
    const incomplete = Buffer.from('...<![CDATA[]', 'utf8');
    expect(BaostockProtocol.endsWithEndMark(incomplete)).toBe(false);
  });

  it('splitResponse 报文头不足抛错', () => {
    expect(() => BaostockProtocol.splitResponse(Buffer.from('short'))).toThrow(
      /不足消息头长度/,
    );
  });

  it('splitResponse 压缩响应长度字段非法抛错', () => {
    // 压缩响应类型 99，长度字段非数字
    const header = `00.9.20\x0199\x01${'X'.padStart(10, 'X')}`;
    const raw = Buffer.from(`${header}...<![CDATA[]]>\n`, 'utf8');
    expect(() => BaostockProtocol.splitResponse(raw)).toThrow(/长度字段无法解析/);
  });

  it('splitResponse 压缩体截断抛错', () => {
    const { deflateSync } = require('node:zlib') as typeof import('node:zlib');
    const compressed = deflateSync(Buffer.from('some body content here', 'utf8'));
    const header = `00.9.20\x0199\x01${String(compressed.length + 100).padStart(10, '0')}`;
    const raw = Buffer.concat([
      Buffer.from(header, 'utf8'),
      compressed,
      Buffer.from('<![CDATA[]]>\n', 'utf8'),
    ]);
    expect(() => BaostockProtocol.splitResponse(raw)).toThrow(/实际只有/);
  });
});

describe('baostock.record', () => {
  it('parseRows 解析 record 数组，null 与数字统一成字符串', () => {
    const json = '{"record":[["2024-01-02","sh.600000",10.5,null]]}';
    expect(RecordParser.parseRows(json)).toEqual([
      ['2024-01-02', 'sh.600000', '10.5', ''],
    ]);
  });

  it('parseRows 解析失败或结构不符时返回空列表', () => {
    expect(RecordParser.parseRows('')).toEqual([]);
    expect(RecordParser.parseRows('not json')).toEqual([]);
    expect(RecordParser.parseRows('{"other":1}')).toEqual([]);
    expect(RecordParser.parseRows('{"record":"x"}')).toEqual([]);
  });

  it('parseRows 顶层非对象返回空（数字/数组）', () => {
    expect(RecordParser.parseRows('123')).toEqual([]);
    expect(RecordParser.parseRows('[1,2]')).toEqual([]);
  });

  it('parseRows record 数组里非数组的行被跳过', () => {
    expect(RecordParser.parseRows('{"record":[["a","b"],"not-array",[1]]}')).toEqual([
      ['a', 'b'],
      ['1'],
    ]);
  });

  it('parseFieldNames 去掉逗号后空格', () => {
    expect(RecordParser.parseFieldNames('date, code, open')).toEqual([
      'date',
      'code',
      'open',
    ]);
    expect(RecordParser.parseFieldNames('')).toEqual([]);
  });

  it('zip 行列对齐，短行缺失列取空串', () => {
    const rows = [
      ['a', 'b'],
      ['c'],
    ];
    const records = RecordParser.zip(rows, ['x', 'y']);
    expect(records[0].get('x')).toBe('a');
    expect(records[0].get('y')).toBe('b');
    expect(records[1].get('x')).toBe('c');
    expect(records[1].get('y')).toBe('');
  });
});

describe('baostock.query', () => {
  it('按交易日接口（98/9C）记录位 4 / 列名位 5', () => {
    const q = BaostockQueries.aStockDaily('anonymous', '2024-01-02');
    expect(q.messageType).toBe(MESSAGE_TYPE.A_STOCK_DAILY_REQUEST);
    expect(q.recordIndex).toBe(4);
    expect(q.fieldIndex).toBe(5);
    expect(q.bodyFields).toEqual([
      'query_daily_history_k_AStock',
      'anonymous',
      '2024-01-02',
    ]);

    const af = BaostockQueries.adjustFactor('anonymous', '2024-01-02');
    expect(af.messageType).toBe(MESSAGE_TYPE.ADJUST_FACTOR_REQUEST);
    expect(af.recordIndex).toBe(4);
    expect(af.fieldIndex).toBe(5);
    expect(af.bodyFields).toEqual([
      'query_daily_adjust_factor',
      'anonymous',
      '2024-01-02',
    ]);
  });

  it('按证券接口（33/45）记录位 6 / 列名位 9', () => {
    const td = BaostockQueries.tradeDates('anonymous', 1, 500, '2015-01-01', '2024-12-31');
    expect(td.recordIndex).toBe(6);
    expect(td.fieldIndex).toBe(9);

    const sb = BaostockQueries.stockBasic('anonymous', 1, 500, '');
    expect(sb.recordIndex).toBe(6);
    expect(sb.fieldIndex).toBe(9);
  });
});

/** 构造一条明文原始响应（用于 splitResponse 测试）：头 + 体 + 分隔符 + CRC + 换行 + 结束标记 */
function buildRawResponse(messageType: string, body: string[]): Buffer {
  const bodyText = body.join(MESSAGE_SPLIT);
  const headAndBody = `${CLIENT_VERSION}${MESSAGE_SPLIT}${messageType}${MESSAGE_SPLIT}${bodyText.length
    .toString()
    .padStart(10, '0')}${bodyText}`;
  const crc = crc32(Buffer.from(headAndBody, 'utf8'));
  const full = `${headAndBody}${MESSAGE_SPLIT}${crc}\n<![CDATA[]]>\n`;
  void MESSAGE_HEADER_LENGTH;
  return Buffer.from(full, 'utf8');
}
