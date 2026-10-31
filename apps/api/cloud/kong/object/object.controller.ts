// 外部依赖
import { Body, Controller, Post } from '@nestjs/common';
// 内部依赖
import { Allow } from '@shared';
import {
  KongObjectCreateDto,
  KongObjectIndexDto,
  KongObjectShowDto,
  KongObjectUpdateDto,
} from './object.dto.js';
import { ObjectService } from './object.service.js';
import type { KongObject } from './object.types.js';

/**
 * KONG 站点下的对象控制器
 *
 * 注 1：前缀与站点控制器同属 `cloud/kong`，对象类接口收在 `cloud/kong/object/` 下
 * 注 2：全部用 POST + Body —— 对象类型、对象ID 都要随请求走，且 `value` 是任意 JSON，
 * 塞进 URL 或 query 都不合适；这一点与旧私有项目一致，前端也按 POST 调用
 * 注 3：控制器只管转发与取 siteId，地址解析（站点不存在 → 404）由 `KongService.url` 负责
 */
@Controller('cloud/kong/object')
@Allow('admin')
export class KongObjectController {
  /**
   * 构造函数
   *
   * @param objectSrv 对象服务
   */
  constructor(private readonly objectSrv: ObjectService) {}

  /**
   * 获取对象清单
   *
   * @param body 站点ID与对象类型
   * @returns 对象清单
   */
  @Post('index')
  index(@Body() body: KongObjectIndexDto): Promise<KongObject[]> {
    return this.objectSrv.index(body.kongId, body.type);
  }

  /**
   * 获取对象详情
   *
   * @param body 站点ID、对象类型与对象ID
   * @returns 对象详情
   */
  @Post('show')
  show(@Body() body: KongObjectShowDto): Promise<KongObject> {
    return this.objectSrv.show(body.kongId, body.type, body.id);
  }

  /**
   * 创建对象
   *
   * @param body 站点ID、对象类型与对象数据
   * @returns 创建结果
   */
  @Post('create')
  create(@Body() body: KongObjectCreateDto): Promise<KongObject> {
    return this.objectSrv.create(body.kongId, body.type, body.value);
  }

  /**
   * 更新对象
   *
   * @param body 站点ID、对象类型、对象ID与对象数据
   * @returns 更新结果
   */
  @Post('update')
  update(@Body() body: KongObjectUpdateDto): Promise<KongObject> {
    return this.objectSrv.update(
      body.kongId,
      body.type,
      body.id,
      body.value,
    );
  }

  /**
   * 删除对象
   *
   * 注：入参与详情完全一致，复用 `KongObjectShowDto`
   *
   * @param body 站点ID、对象类型与对象ID
   */
  @Post('destroy')
  destroy(@Body() body: KongObjectShowDto): Promise<void> {
    return this.objectSrv.destroy(body.kongId, body.type, body.id);
  }
}
