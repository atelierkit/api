// 外部依赖
import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
// 内部依赖
import { Allow, CommonController } from '@shared';
import { KubernetesCreateDto, KubernetesUpdateDto } from './kubernetes.dto.js';
import { KubernetesService } from './kubernetes.service.js';

/**
 * Kubernetes 集群控制器
 *
 * 注 1：集群的增删改查由 `CommonController` 基类提供，这里额外补两个只读探测接口
 * （概览与连通性诊断）；集群下的资源管理见 `KubernetesObjectController`
 * 注 2：全部接口都要 `admin` 角色 —— 拿到 Token 或客户端证书就等于拿到集群里的相应权限
 */
@Controller('cloud/kubernetes')
@Allow('admin')
export class KubernetesController extends CommonController<
  KubernetesService,
  KubernetesCreateDto,
  KubernetesUpdateDto
> {
  /**
   * 构造函数
   *
   * @param kubernetesSrv 集群服务
   */
  constructor(protected readonly kubernetesSrv: KubernetesService) {
    super(kubernetesSrv);
  }

  /**
   * 获取集群概览（版本 / 节点 / Pod / 工作负载 / Service / 容量）
   *
   * @param id 集群ID
   * @returns 概览
   */
  @Get('summary/:id')
  summary(@Param('id', ParseIntPipe) id: number) {
    return this.kubernetesSrv.summary(id);
  }

  /**
   * 获取集群连通性诊断（healthz 延迟 / 版本 / 鉴权方式 / 风险项）
   *
   * @param id 集群ID
   * @returns 诊断结果
   */
  @Get('diagnose/:id')
  diagnose(@Param('id', ParseIntPipe) id: number) {
    return this.kubernetesSrv.diagnose(id);
  }
}
