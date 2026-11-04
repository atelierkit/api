// 外部依赖
import 'reflect-metadata';
import { GATEWAY_OPTIONS } from '@nestjs/websockets/constants';
import type { GatewayMetadata } from '@nestjs/websockets';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { DockerLogGateway } from '../../cloud/docker/object/logs.gateway.js';
import { RemoteGateway } from '../../cloud/remote/remote.gateway.js';
import { DataGateway } from '../../data/data.gateway.js';
import { SOCKET_GATEWAY_OPTION } from './socket.constant.js';

describe('SOCKET_GATEWAY_OPTION', () => {
  it('所有网关都展开同一份选项（path 分叉会让 Nest 再建一个 Server，同一个 upgrade 被处理两次直接崩进程）', () => {
    /** 全部网关，注：新增网关必须加进这个列表，否则守卫形同虚设 */
    const gateways = [DataGateway, RemoteGateway, DockerLogGateway];

    for (const gateway of gateways) {
      /** 该网关的装饰器选项 */
      const options = Reflect.getMetadata(
        GATEWAY_OPTIONS,
        gateway,
      ) as GatewayMetadata | undefined;

      expect(options, `${gateway.name} 没有 @WebSocketGateway 元数据`).toBeDefined();
      // 注：Nest 只按 { port, path } 去重 Server，path 不一致 ⇒ 两个 Server 抢同一个 upgrade
      expect(options?.path, `${gateway.name} 的 path 与共享常量不一致`).toBe(
        SOCKET_GATEWAY_OPTION.path,
      );
      // 注：去重后只有第一个注册的网关的选项生效，这里断言其余选项也没有分叉
      expect(options?.cors, `${gateway.name} 的 cors 与共享常量不一致`).toEqual(
        SOCKET_GATEWAY_OPTION.cors,
      );
      expect(
        options?.maxHttpBufferSize,
        `${gateway.name} 的 maxHttpBufferSize 与共享常量不一致`,
      ).toBe(SOCKET_GATEWAY_OPTION.maxHttpBufferSize);
    }
  });
});
