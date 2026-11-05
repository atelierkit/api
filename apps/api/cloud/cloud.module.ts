// 外部依赖
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Client } from 'ssh2';
// 内部依赖
import { SharedModule } from '@shared';
import { DockerController } from './docker/docker.controller.js';
import { DockerEntity, DockerLogEntity } from './docker/docker.entity.js';
import { DockerService } from './docker/docker.service.js';
import { DockerObjectController } from './docker/object/object.controller.js';
import { DockerObjectService } from './docker/object/object.service.js';
import { DockerLogGateway } from './docker/object/logs.gateway.js';
import { DockerLogsService } from './docker/object/logs.service.js';
import { KeyController } from './key/key.controller.js';
import { KeyEntity, KeyLogEntity } from './key/key.entity.js';
import { KeyService } from './key/key.service.js';
import { KongController } from './kong/kong.controller.js';
import { KongEntity, KongLogEntity } from './kong/kong.entity.js';
import { KongService } from './kong/kong.service.js';
import { KongObjectController } from './kong/object/object.controller.js';
import { ObjectService } from './kong/object/object.service.js';
import { KubernetesController } from './kubernetes/kubernetes.controller.js';
import {
  KubernetesEntity,
  KubernetesLogEntity,
} from './kubernetes/kubernetes.entity.js';
import { KubernetesService } from './kubernetes/kubernetes.service.js';
import { KubernetesObjectController } from './kubernetes/object/object.controller.js';
import { KubernetesObjectService } from './kubernetes/object/object.service.js';
import { RemoteController } from './remote/remote.controller.js';
import { RemoteEntity, RemoteLogEntity } from './remote/remote.entity.js';
import { RemoteGateway } from './remote/remote.gateway.js';
import { RemoteService } from './remote/remote.service.js';
import { RemoteSessionService } from './remote/remote.session.js';
import { SSH_CLIENT, RemoteSshService } from './remote/remote.ssh.js';
import type { SshClientLike } from './remote/remote.ssh.js';

/**
 * 云服务模块
 *
 * 注：访问密钥与四类站点（KONG / Docker / Kubernetes / 远程连接）在页面上同属「云服务」一个导航区，
 * 故收在同一个模块里；全部接口用 `@Allow('admin')` 声明所需角色，鉴权由全局 `TokenGuard` 完成。
 * 四类站点是同一套组织方式：站点连接配置与 `_logs` 表落库，站点下的远端资源不落库 ——
 * KONG 管路由 / 服务 / 用户 / 上游 / 证书 / 插件，Docker 管容器 / 镜像 / 数据卷 / 网络，
 * Kubernetes 管命名空间 / 节点 / Pod / 工作负载 / Service，远程连接管 SSH 主机。
 * `remote` 是全仓库第一处 WebSocket 业务网关（数据面走 `/remote` 命名空间，握手令牌自行校验，见 `RemoteGateway`）。
 */
@Module({
  imports: [
    SharedModule,
    TypeOrmModule.forFeature([
      KeyEntity,
      KeyLogEntity,
      KongEntity,
      KongLogEntity,
      DockerEntity,
      DockerLogEntity,
      KubernetesEntity,
      KubernetesLogEntity,
      RemoteEntity,
      RemoteLogEntity,
    ]),
  ],
  providers: [
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
    // 注：`ssh2` 的客户端通过工厂注入，让会话层与网关的测试能塞一个 EventEmitter 替身
    // （ssh2 的连接行为无法在 ESM 下打桩，而会话生命周期恰恰最需要单测）
    {
      provide: SSH_CLIENT,
      useValue: () => new Client() as unknown as SshClientLike,
    },
  ],
  controllers: [
    KeyController,
    KongController,
    KongObjectController,
    DockerController,
    DockerObjectController,
    KubernetesController,
    KubernetesObjectController,
    RemoteController,
  ],
  exports: [
    KeyService,
    KongService,
    ObjectService,
    DockerService,
    DockerObjectService,
    KubernetesService,
    KubernetesObjectService,
    RemoteService,
  ],
})
export class CloudModule {}
