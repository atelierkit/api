// 外部依赖
import { Body, Controller, Post } from '@nestjs/common';
// 内部依赖
import { Allow } from '@shared';
import {
  DockerLogsDto,
  DockerObjectActionDto,
  DockerObjectIndexDto,
  DockerObjectShowDto,
} from './object.dto.js';
import { DockerObjectService } from './object.service.js';
import { DockerLogsService } from './logs.service.js';

/**
 * Docker 宿主机下的资源控制器
 *
 * 注 1：前缀与宿主机控制器同属 `cloud/docker`，资源类接口收在 `cloud/docker/object/` 下
 * 注 2：全部用 POST + Body —— 资源类型、资源ID 都要随请求走，且动作参数是结构化的，
 * 塞进 URL 或 query 都不合适；这一点与 KONG 的对象控制器保持一致
 * 注 3：控制器只转发，连接参数解析（宿主机不存在 → 404）与动作白名单校验都在服务层
 * 注 4：实时日志走 WebSocket（`DockerLogGateway` 的 `/docker-log` 命名空间），
 * 这里只给「一次性快照」—— 打开抽屉时先有内容，跟随再由通道接管
 */
@Controller('cloud/docker/object')
@Allow('admin')
export class DockerObjectController {
  /**
   * 构造函数
   *
   * @param objectSrv 资源服务
   * @param logsSrv 日志服务，注：快照与跟随共用同一套解析器
   */
  constructor(
    private readonly objectSrv: DockerObjectService,
    private readonly logsSrv: DockerLogsService,
  ) {}

  /**
   * 获取资源清单
   *
   * @param body 宿主机ID与资源类型
   * @returns 资源清单
   */
  @Post('index')
  index(@Body() body: DockerObjectIndexDto) {
    return this.objectSrv.index(body.dockerId, body.type);
  }

  /**
   * 获取资源详情
   *
   * @param body 宿主机ID、资源类型与资源ID
   * @returns 资源详情
   */
  @Post('show')
  show(@Body() body: DockerObjectShowDto) {
    return this.objectSrv.show(body.dockerId, body.type, body.id);
  }

  /**
   * 执行资源动作（启停 / 重启 / 删除）
   *
   * @param body 宿主机ID、资源类型、资源ID、动作与动作参数
   */
  @Post('action')
  action(@Body() body: DockerObjectActionDto) {
    return this.objectSrv.action(body.dockerId, body.type, body.action, body.id, {
      force: body.force,
      timeout: body.timeout,
    });
  }

  /**
   * 获取容器日志快照
   *
   * 注：只允许容器 —— 其它资源没有日志接口，`type` 不在 DTO 里（直接固定成容器），
   * 少一个可被误用的分支
   *
   * @param body 宿主机ID、容器ID与查询参数
   * @returns 日志快照
   */
  @Post('logs')
  logs(@Body() body: DockerLogsDto) {
    return this.logsSrv.snapshot(body.dockerId, body.id, {
      tail: body.tail,
      since: body.since,
      timestamps: body.timestamps,
    });
  }
}
