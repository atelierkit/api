// 外部依赖
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  DockerLogsDto,
  DockerObjectActionDto,
  DockerObjectIndexDto,
  DockerObjectShowDto,
} from './object.dto.js';

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

/** 合法的清单入参 */
const INDEX = { dockerId: 1, type: 'containers' };

describe('docker object.dto', () => {
  describe('DockerObjectIndexDto', () => {
    it('类型必须是四种资源之一（路径模板按它选，不能由前端随意指定）', async () => {
      expect(await fieldsOf(DockerObjectIndexDto, INDEX)).toEqual([]);
      for (const type of ['images', 'volumes', 'networks']) {
        expect(await fieldsOf(DockerObjectIndexDto, { ...INDEX, type })).toEqual(
          [],
        );
      }
      expect(
        await fieldsOf(DockerObjectIndexDto, { ...INDEX, type: 'exec' }),
      ).toContain('type');
    });

    it('宿主机ID必须是正整数', async () => {
      expect(
        await fieldsOf(DockerObjectIndexDto, { ...INDEX, dockerId: 0 }),
      ).toContain('dockerId');
      expect(
        await fieldsOf(DockerObjectIndexDto, { ...INDEX, dockerId: 1.5 }),
      ).toContain('dockerId');
    });
  });

  describe('DockerObjectShowDto', () => {
    it('资源ID允许短 ID、镜像 tag 与 digest', async () => {
      for (const id of ['a1b2c3d4e5f6', 'nginx:latest', 'sha256abc@sha256:ff']) {
        expect(
          await fieldsOf(DockerObjectShowDto, { ...INDEX, id }),
        ).toEqual([]);
      }
    });

    it('资源ID不许带斜杠（镜像名要用列表里的 ID，不能提交带 registry 前缀的名字）', async () => {
      expect(
        await fieldsOf(DockerObjectShowDto, {
          ...INDEX,
          id: 'registry.lan:5000/foo',
        }),
      ).toContain('id');
    });

    it('资源ID不许以点或横线开头，挡住 .. 之类的路径改写', async () => {
      for (const id of ['..', '.hidden', '-x', '/etc']) {
        expect(
          await fieldsOf(DockerObjectShowDto, { ...INDEX, id }),
        ).toContain('id');
      }
    });
  });

  describe('DockerObjectActionDto', () => {
    it('动作必须在白名单内', async () => {
      expect(
        await fieldsOf(DockerObjectActionDto, {
          ...INDEX,
          id: 'abc',
          action: 'start',
        }),
      ).toEqual([]);
      expect(
        await fieldsOf(DockerObjectActionDto, {
          ...INDEX,
          id: 'abc',
          action: 'exec',
        }),
      ).toContain('action');
    });

    it('等待时间限定在 0~600 秒', async () => {
      for (const timeout of [-1, 601]) {
        expect(
          await fieldsOf(DockerObjectActionDto, {
            ...INDEX,
            id: 'abc',
            action: 'stop',
            timeout,
          }),
        ).toContain('timeout');
      }
      expect(
        await fieldsOf(DockerObjectActionDto, {
          ...INDEX,
          id: 'abc',
          action: 'stop',
          timeout: 30,
        }),
      ).toEqual([]);
    });

    it('强制删除开关必须是布尔（默认 false 由服务层兜底）', async () => {
      expect(
        await fieldsOf(DockerObjectActionDto, {
          ...INDEX,
          id: 'abc',
          action: 'remove',
          force: 'yes',
        }),
      ).toContain('force');
      expect(
        await fieldsOf(DockerObjectActionDto, {
          ...INDEX,
          id: 'abc',
          action: 'remove',
          force: true,
        }),
      ).toEqual([]);
    });
  });

  describe('DockerLogsDto', () => {
    /** 合法的日志入参，注：**没有 type** —— 日志只对容器有意义 */
    const LOG = { dockerId: 1, id: 'abc' };

    it('只需要 dockerId 与 id（不需要 type，继承 show 会让前端漏传时直接 400）', async () => {
      expect(await fieldsOf(DockerLogsDto, LOG)).toEqual([]);
      expect(await fieldsOf(DockerLogsDto, { ...LOG, type: 'containers' })).toEqual(
        [],
      );
    });

    it('tail 允许 0，越界与非整数被拒', async () => {
      expect(await fieldsOf(DockerLogsDto, { ...LOG, tail: 0 })).toEqual([]);
      expect(await fieldsOf(DockerLogsDto, { ...LOG, tail: 5000 })).toEqual([]);
      expect(await fieldsOf(DockerLogsDto, { ...LOG, tail: 5001 })).toContain('tail');
      expect(await fieldsOf(DockerLogsDto, { ...LOG, tail: -1 })).toContain('tail');
      expect(await fieldsOf(DockerLogsDto, { ...LOG, tail: 1.5 })).toContain('tail');
    });

    it('since 接受 RFC3339 与 Unix 秒，空串合法（未指定时前端会带空串）', async () => {
      expect(
        await fieldsOf(DockerLogsDto, { ...LOG, since: '2026-11-04T01:12:01.338Z' }),
      ).toEqual([]);
      expect(await fieldsOf(DockerLogsDto, { ...LOG, since: '1762214400' })).toEqual(
        [],
      );
      expect(await fieldsOf(DockerLogsDto, { ...LOG, since: '' })).toEqual([]);
    });

    it('since 里带空格或分号被拒（它会被拼进查询串）', async () => {
      expect(
        await fieldsOf(DockerLogsDto, { ...LOG, since: '2026-11-04 01:12:01' }),
      ).toContain('since');
      expect(await fieldsOf(DockerLogsDto, { ...LOG, since: '1;DROP' })).toContain(
        'since',
      );
    });

    it('timestamps 必须是布尔', async () => {
      expect(await fieldsOf(DockerLogsDto, { ...LOG, timestamps: false })).toEqual([]);
      expect(await fieldsOf(DockerLogsDto, { ...LOG, timestamps: 'yes' })).toContain(
        'timestamps',
      );
    });
  });
});
