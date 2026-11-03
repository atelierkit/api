// 外部依赖
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { DockerCreateDto, DockerUpdateDto } from './docker.dto.js';

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

/** 合法的建宿主机入参 */
const DOCKER = {
  name: '家用宿主机',
  description: '局域网内的 Docker',
  endpoint: 'tcp://192.168.1.3:2376',
  tls: true,
  ca: 'CA-PEM',
  cert: 'CERT-PEM',
  key: 'KEY-PEM',
  verify: true,
  status: true,
};

describe('docker.dto', () => {
  describe('DockerCreateDto', () => {
    it('六个基础字段都必填', async () => {
      expect(await fieldsOf(DockerCreateDto, {})).toEqual(
        expect.arrayContaining([
          'name',
          'description',
          'endpoint',
          'tls',
          'verify',
          'status',
        ]),
      );
    });

    it('字段齐备时通过校验', async () => {
      expect(await fieldsOf(DockerCreateDto, DOCKER)).toEqual([]);
    });

    it('tls / status 为 false 时同样通过（不能被判成「空」）', async () => {
      expect(
        await fieldsOf(DockerCreateDto, {
          ...DOCKER,
          tls: false,
          status: false,
          cert: undefined,
          key: undefined,
        }),
      ).toEqual([]);
    });

    it('启用 TLS 时客户端证书与私钥必填', async () => {
      expect(
        await fieldsOf(DockerCreateDto, { ...DOCKER, cert: '', key: '' }),
      ).toEqual(expect.arrayContaining(['cert', 'key']));
    });

    it('地址只认 tcp / http / https 三种前缀（unix:// 刻意不支持）', async () => {
      expect(
        await fieldsOf(DockerCreateDto, {
          ...DOCKER,
          endpoint: 'unix:///var/run/docker.sock',
        }),
      ).toContain('endpoint');
      expect(
        await fieldsOf(DockerCreateDto, { ...DOCKER, endpoint: '192.168.1.3' }),
      ).toContain('endpoint');
    });

    it('地址可省略端口（缺省由 TLS 开关决定）', async () => {
      expect(
        await fieldsOf(DockerCreateDto, {
          ...DOCKER,
          endpoint: 'tcp://docker.lan',
        }),
      ).toEqual([]);
    });

    it('API 版本必须是 1.47 这样的形式', async () => {
      expect(
        await fieldsOf(DockerCreateDto, { ...DOCKER, apiVersion: '1.47' }),
      ).toEqual([]);
      expect(
        await fieldsOf(DockerCreateDto, { ...DOCKER, apiVersion: '1' }),
      ).toContain('apiVersion');
    });

    it('明文确认开关是布尔（不落库，只为显式确认服务）', async () => {
      expect(
        await fieldsOf(DockerCreateDto, {
          ...DOCKER,
          tls: false,
          allowInsecure: 'yes',
        }),
      ).toContain('allowInsecure');
    });
  });

  describe('DockerUpdateDto', () => {
    it('全部字段可选，空对象也能通过', async () => {
      expect(await fieldsOf(DockerUpdateDto, {})).toEqual([]);
    });

    it('只改说明时不需要重填证书（编辑表单的常态）', async () => {
      expect(
        await fieldsOf(DockerUpdateDto, { description: '换个说明' }),
      ).toEqual([]);
    });

    it('更新时的地址仍要过格式校验', async () => {
      expect(
        await fieldsOf(DockerUpdateDto, { endpoint: 'http://host/path' }),
      ).toContain('endpoint');
    });
  });
});
