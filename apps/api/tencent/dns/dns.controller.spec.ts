// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { ApiService } from '../api/api.service.js';
import { DnsController } from './dns.controller.js';

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 腾讯云接口服务替身 */
  const apiSrv = { dnspod: vi.fn(async (..._args: unknown[]) => ({}) as unknown) };
  return {
    controller: new DnsController(apiSrv as unknown as ApiService),
    apiSrv,
  };
}

describe('DnsController', () => {
  it('整个控制器由 admin 角色独占', () => {
    expect(Reflect.getMetadata('role', DnsController)).toEqual(['admin']);
  });

  it('六个接口都按 DNSPod 的接口名转发', async () => {
    /** 被测控制器与替身 */
    const { controller, apiSrv } = controllerOf();
    /** 创建入参 */
    const create = {
      Domain: 'example.com',
      RecordType: 'A',
      RecordLine: '默认',
      Value: '1.2.3.4',
      SubDomain: 'www',
      Status: 'ENABLE',
    };

    await controller.list(3, { Domain: 'example.com', Offset: 0, Limit: 20 });
    expect(apiSrv.dnspod).toHaveBeenLastCalledWith(3, 'DescribeRecordList', {
      Domain: 'example.com',
      Offset: 0,
      Limit: 20,
    });

    await controller.create(3, create);
    expect(apiSrv.dnspod).toHaveBeenLastCalledWith(3, 'CreateRecord', create);

    await controller.modify(3, { ...create, RecordId: 8 });
    expect(apiSrv.dnspod).toHaveBeenLastCalledWith(3, 'ModifyRecord', {
      ...create,
      RecordId: 8,
    });

    await controller.delete(3, { Domain: 'example.com', RecordId: 8 });
    expect(apiSrv.dnspod).toHaveBeenLastCalledWith(3, 'DeleteRecord', {
      Domain: 'example.com',
      RecordId: 8,
    });

    await controller.type(3, { DomainGrade: 'D_FREE' });
    expect(apiSrv.dnspod).toHaveBeenLastCalledWith(3, 'DescribeRecordType', {
      DomainGrade: 'D_FREE',
    });

    await controller.line(3, { Domain: 'example.com' });
    expect(apiSrv.dnspod).toHaveBeenLastCalledWith(
      3,
      'DescribeRecordLineList',
      { Domain: 'example.com' },
    );
  });

  it('取单条记录走 DescribeRecord（旧项目错用了 DescribeRecordList）', async () => {
    /** 被测控制器与替身 */
    const { controller, apiSrv } = controllerOf();
    await controller.record(3, { Domain: 'example.com', RecordId: 8 });
    expect(apiSrv.dnspod).toHaveBeenLastCalledWith(3, 'DescribeRecord', {
      Domain: 'example.com',
      RecordId: 8,
    });
  });
});
