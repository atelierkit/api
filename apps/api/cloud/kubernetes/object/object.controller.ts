// 外部依赖
import { Body, Controller, Post } from '@nestjs/common';
// 内部依赖
import { Allow } from '@shared';
import {
  KubernetesObjectActionDto,
  KubernetesObjectIndexDto,
  KubernetesObjectShowDto,
} from './object.dto.js';
import { KubernetesObjectService } from './object.service.js';

/**
 * Kubernetes 集群下的资源控制器
 *
 * 注 1：前缀与集群控制器同属 `cloud/kubernetes`，资源类接口收在 `cloud/kubernetes/object/` 下
 * 注 2：全部用 POST + Body —— 资源类型、命名空间、资源名都要随请求走，且动作参数是结构化的，
 * 塞进 URL 或 query 都不合适；这一点与 KONG / Docker 的对象控制器保持一致
 * 注 3：控制器只转发，连接参数解析（集群不存在 → 404）与动作白名单校验都在服务层
 */
@Controller('cloud/kubernetes/object')
@Allow('admin')
export class KubernetesObjectController {
  /**
   * 构造函数
   *
   * @param objectSrv 资源服务
   */
  constructor(private readonly objectSrv: KubernetesObjectService) {}

  /**
   * 获取资源清单
   *
   * @param body 集群ID、资源类型与命名空间
   * @returns 资源清单
   */
  @Post('index')
  index(@Body() body: KubernetesObjectIndexDto) {
    return this.objectSrv.index(body.kubernetesId, body.type, body.namespace);
  }

  /**
   * 获取资源详情
   *
   * @param body 集群ID、资源类型、命名空间与资源名
   * @returns 资源详情
   */
  @Post('show')
  show(@Body() body: KubernetesObjectShowDto) {
    return this.objectSrv.show(
      body.kubernetesId,
      body.type,
      body.id,
      body.namespace,
    );
  }

  /**
   * 执行资源动作（删除 / 扩缩容 / 重启 / 节点封锁）
   *
   * @param body 集群ID、资源类型、命名空间、资源名、动作与动作参数
   */
  @Post('action')
  action(@Body() body: KubernetesObjectActionDto) {
    return this.objectSrv.action(
      body.kubernetesId,
      body.type,
      body.action,
      body.id,
      { replicas: body.replicas, gracePeriod: body.gracePeriod },
      body.namespace,
    );
  }
}
