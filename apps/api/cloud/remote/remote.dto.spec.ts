// 外部依赖
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  RemoteCreateDto,
  RemoteKeyInspectDto,
  RemoteTicketDto,
  RemoteTrustDto,
  RemoteUpdateDto,
} from './remote.dto.js';

/**
 * 校验入参
 *
 * @param cls DTO 类型
 * @param value 原始入参
 * @returns 出错的字段名清单
 */
async function fieldsOf(
  cls: new () => object,
  value: Record<string, unknown>,
): Promise<string[]> {
  /** DTO 实例 */
  const dto = plainToInstance(cls, value);
  /** 校验结果 */
  const errors = await validate(dto, { whitelist: true });
  return errors.map((error) => error.property);
}

/** 一段「看起来像私钥」的文本，注：DTO 只查非空，形态由 `remote.key.ts` 校验 */
const PLAIN_KEY_TEXT =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';

/** 合法的创建入参 */
const REMOTE = {
  name: '工控机',
  description: '局域网内的 Ubuntu',
  host: '192.168.1.3',
  port: 22,
  authType: 'password',
  username: 'atelier',
  password: 'p@ssw0rd',
  status: true,
};

describe('remote.dto', () => {
  describe('RemoteCreateDto', () => {
    it('基础字段都必填', async () => {
      expect(await fieldsOf(RemoteCreateDto, {})).toEqual(
        expect.arrayContaining([
          'name',
          'description',
          'host',
          'port',
          'authType',
          'username',
          'status',
        ]),
      );
    });

    it('字段齐备时通过校验', async () => {
      expect(await fieldsOf(RemoteCreateDto, REMOTE)).toEqual([]);
    });

    it('密码鉴权必须有密码，私钥可以不填', async () => {
      expect(
        await fieldsOf(RemoteCreateDto, { ...REMOTE, password: undefined }),
      ).toContain('password');
      expect(
        await fieldsOf(RemoteCreateDto, { ...REMOTE, privateKey: PLAIN_KEY_TEXT }),
      ).toEqual([]);
    });

    it('私钥鉴权必须有私钥，密码可以不填', async () => {
      expect(
        await fieldsOf(RemoteCreateDto, {
          ...REMOTE,
          authType: 'key',
          password: undefined,
        }),
      ).toContain('privateKey');
      expect(
        await fieldsOf(RemoteCreateDto, {
          ...REMOTE,
          authType: 'key',
          password: undefined,
          privateKey: PLAIN_KEY_TEXT,
        }),
      ).toEqual([]);
    });

    it('主机地址拒绝短横开头（挡掉参数注入形状的输入）', async () => {
      expect(
        await fieldsOf(RemoteCreateDto, { ...REMOTE, host: '-oProxyCommand=x' }),
      ).toContain('host');
    });

    it('主机地址接受域名与 IPv4', async () => {
      expect(
        await fieldsOf(RemoteCreateDto, { ...REMOTE, host: 'home-server.lan' }),
      ).toEqual([]);
      expect(
        await fieldsOf(RemoteCreateDto, { ...REMOTE, host: '192.168.1.3' }),
      ).toEqual([]);
    });

    it('端口越界被拒', async () => {
      expect(await fieldsOf(RemoteCreateDto, { ...REMOTE, port: 0 })).toContain(
        'port',
      );
      expect(
        await fieldsOf(RemoteCreateDto, { ...REMOTE, port: 70000 }),
      ).toContain('port');
      expect(
        await fieldsOf(RemoteCreateDto, { ...REMOTE, port: '22' }),
      ).toContain('port');
    });

    it('鉴权方式与字符集走白名单', async () => {
      expect(
        await fieldsOf(RemoteCreateDto, { ...REMOTE, authType: 'agent' }),
      ).toContain('authType');
      // 注：白名单外的字符集会让浏览器 `TextDecoder` 抛 RangeError
      expect(
        await fieldsOf(RemoteCreateDto, { ...REMOTE, charset: 'latin1' }),
      ).toContain('charset');
      expect(
        await fieldsOf(RemoteCreateDto, { ...REMOTE, charset: 'gb18030' }),
      ).toEqual([]);
    });

    it('status 为 false 时同样通过（不能被判成「空」）', async () => {
      expect(await fieldsOf(RemoteCreateDto, { ...REMOTE, status: false })).toEqual(
        [],
      );
    });
  });

  describe('RemoteUpdateDto', () => {
    it('空对象通过（全可选）', async () => {
      expect(await fieldsOf(RemoteUpdateDto, {})).toEqual([]);
    });

    it('提交非法值同样被拦', async () => {
      expect(
        await fieldsOf(RemoteUpdateDto, { host: 'has space', port: -1 }),
      ).toEqual(expect.arrayContaining(['host', 'port']));
    });
  });

  describe('RemoteTicketDto', () => {
    it('尺寸必须在上下限内', async () => {
      expect(
        await fieldsOf(RemoteTicketDto, { id: 1, cols: 10, rows: 2 }),
      ).toEqual(expect.arrayContaining(['cols', 'rows']));
      expect(
        await fieldsOf(RemoteTicketDto, { id: 1, cols: 120, rows: 40 }),
      ).toEqual([]);
    });
  });

  describe('RemoteKeyInspectDto', () => {
    it('私钥内容必填，口令可空', async () => {
      expect(await fieldsOf(RemoteKeyInspectDto, {})).toContain('content');
      expect(await fieldsOf(RemoteKeyInspectDto, { content: PLAIN_KEY_TEXT })).toEqual(
        [],
      );
    });

    it('内容上限 16 KB（与 remote.key.ts 的 MAX_KEY_CHARS 同一数值）', async () => {
      expect(
        await fieldsOf(RemoteKeyInspectDto, { content: 'a'.repeat(16385) }),
      ).toContain('content');
      expect(
        await fieldsOf(RemoteKeyInspectDto, { content: 'a'.repeat(16384) }),
      ).toEqual([]);
    });
  });

  describe('RemoteTrustDto', () => {
    it('指纹必须是 SHA256: 开头的 base64 摘要', async () => {
      expect(
        await fieldsOf(RemoteTrustDto, { id: 1, fingerprint: 'md5:abc' }),
      ).toContain('fingerprint');
      expect(
        await fieldsOf(RemoteTrustDto, {
          id: 1,
          fingerprint: 'SHA256:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0',
        }),
      ).toEqual([]);
    });
  });
});
