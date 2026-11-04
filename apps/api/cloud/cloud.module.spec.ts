// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { CloudModule } from './cloud.module.js';
import { DockerController } from './docker/docker.controller.js';
import { DockerService } from './docker/docker.service.js';
import { DockerObjectController } from './docker/object/object.controller.js';
import { DockerObjectService } from './docker/object/object.service.js';
import { DockerLogGateway } from './docker/object/logs.gateway.js';
import { DockerLogsService } from './docker/object/logs.service.js';
import { KeyController } from './key/key.controller.js';
import { KeyService } from './key/key.service.js';
import { KongController } from './kong/kong.controller.js';
import { KongService } from './kong/kong.service.js';
import { KongObjectController } from './kong/object/object.controller.js';
import { ObjectService } from './kong/object/object.service.js';
import { KubernetesController } from './kubernetes/kubernetes.controller.js';
import { KubernetesService } from './kubernetes/kubernetes.service.js';
import { KubernetesObjectController } from './kubernetes/object/object.controller.js';
import { KubernetesObjectService } from './kubernetes/object/object.service.js';
import { RemoteController } from './remote/remote.controller.js';
import { RemoteGateway } from './remote/remote.gateway.js';
import { RemoteService } from './remote/remote.service.js';
import { RemoteSessionService } from './remote/remote.session.js';
import { SSH_CLIENT, RemoteSshService } from './remote/remote.ssh.js';

describe('CloudModule', () => {
  it('密钥 / KONG / Docker / Kubernetes / 远程连接五套控制器都在模块里注册（少登记一个就是整块接口 404）', () => {
    expect(Reflect.getMetadata('controllers', CloudModule)).toEqual([
      KeyController,
      KongController,
      KongObjectController,
      DockerController,
      DockerObjectController,
      KubernetesController,
      KubernetesObjectController,
      RemoteController,
    ]);
    expect(Reflect.getMetadata('providers', CloudModule)).toEqual(
      expect.arrayContaining([
        KeyService,
        KongService,
        ObjectService,
        DockerService,
        DockerObjectService,
        DockerLogsService,
        DockerLogGateway,
        KubernetesService,
        KubernetesObjectService,
        RemoteService,
        RemoteSshService,
        RemoteSessionService,
        RemoteGateway,
      ]),
    );
  });

  it('WebSocket 网关与 SSH 客户端工厂都注册在提供者里（漏了网关，终端握手会 404）', () => {
    /** 提供者清单 */
    const providers = Reflect.getMetadata('providers', CloudModule) as unknown[];
    expect(providers).toContain(RemoteGateway);
    // 注：日志网关同理 —— 漏登记时前端连 `/docker-log` 会静默超时，不是报错
    expect(providers).toContain(DockerLogGateway);
    expect(providers).toContain(DockerLogsService);
    expect(
      providers.some(
        (item) => (item as { provide?: unknown } | null)?.provide === SSH_CLIENT,
      ),
    ).toBe(true);
  });

  it('服务对外导出（后续按云厂商拆模块时可直接复用）', () => {
    expect(Reflect.getMetadata('exports', CloudModule)).toEqual([
      KeyService,
      KongService,
      ObjectService,
      DockerService,
      DockerObjectService,
      KubernetesService,
      KubernetesObjectService,
      RemoteService,
    ]);
  });
});
