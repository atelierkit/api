// 外部依赖
import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
// 内部依赖
import { Allow, CommonController } from '@shared';
import { DockerCreateDto, DockerUpdateDto } from './docker.dto.js';
import { DockerService } from './docker.service.js';

/**
 * Docker 宿主机控制器
 *
 * 注 1：宿主机的增删改查由 `CommonController` 基类提供，这里额外补两个只读探测接口
 * （概览与连通性诊断）；宿主机下的资源管理见 `DockerObjectController`
 * 注 2：全部接口都要 `admin` 角色 —— 拿到 daemon 地址与证书就等于拿到宿主机 root
 */
@Controller('cloud/docker')
@Allow('admin')
export class DockerController extends CommonController<
  DockerService,
  DockerCreateDto,
  DockerUpdateDto
> {
  /**
   * 构造函数
   *
   * @param dockerSrv 宿主机服务
   */
  constructor(protected readonly dockerSrv: DockerService) {
    super(dockerSrv);
  }

  /**
   * 获取宿主机概览（版本 / 容器数 / 镜像数 / CPU / 内存）
   *
   * @param id 宿主机ID
   * @returns 概览
   */
  @Get('summary/:id')
  summary(@Param('id', ParseIntPipe) id: number) {
    return this.dockerSrv.summary(id);
  }

  /**
   * 获取宿主机连通性诊断（ping 延迟 / 版本 / 风险项）
   *
   * @param id 宿主机ID
   * @returns 诊断结果
   */
  @Get('diagnose/:id')
  diagnose(@Param('id', ParseIntPipe) id: number) {
    return this.dockerSrv.diagnose(id);
  }
}
