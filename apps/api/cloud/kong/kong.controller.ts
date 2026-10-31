// 外部依赖
import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
// 内部依赖
import { Allow, CommonController } from '@shared';
import { KongCreateDto, KongUpdateDto } from './kong.dto.js';
import { KongService } from './kong.service.js';

/**
 * KONG 网关站点控制器
 *
 * 注：站点增删改查由 `CommonController` 基类提供，这里额外补两个只读探测接口；
 * 站点下的对象管理（services / routes / plugins 等）暂不迁移
 */
@Controller('cloud/kong')
@Allow('admin')
export class KongController extends CommonController<
  KongService,
  KongCreateDto,
  KongUpdateDto
> {
  /**
   * 构造函数
   *
   * @param kongSrv 站点服务
   */
  constructor(protected readonly kongSrv: KongService) {
    super(kongSrv);
  }

  /**
   * 获取网关许可报告
   *
   * @param id 站点ID
   * @returns 许可报告
   */
  @Get('report/:id')
  report(@Param('id', ParseIntPipe) id: number) {
    return this.kongSrv.report(id);
  }

  /**
   * 获取网关已启用的插件清单
   *
   * @param id 站点ID
   * @returns 插件清单
   */
  @Get('plugin/:id')
  plugin(@Param('id', ParseIntPipe) id: number) {
    return this.kongSrv.plugin(id);
  }
}
