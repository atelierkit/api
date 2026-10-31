// 外部依赖
import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
// 内部依赖
import { Allow, CommonController } from '@shared';
import { KongCreateDto, KongUpdateDto } from './kong.dto.js';
import { KongService } from './kong.service.js';

/**
 * KONG 网关站点控制器
 *
 * 注 1：站点增删改查由 `CommonController` 基类提供，这里额外补两个只读探测接口
 * （概览与插件清单）；站点下的对象管理见 `KongObjectController`
 * 注 2：全部接口都要 `admin` 角色 —— 拿到 Admin API 地址就等于拿到整台网关的控制权
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
   * 获取网关概览（版本 / 插件数 / 连接数 / 数据库可达性）
   *
   * 注：原「许可报告」接口（`/default/license/report`）只有企业版才有，
   * 社区版恒为 404，故改为社区版同样可用的 `/` 与 `/status` 汇总
   *
   * @param id 站点ID
   * @returns 概览
   */
  @Get('summary/:id')
  summary(@Param('id', ParseIntPipe) id: number) {
    return this.kongSrv.summary(id);
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
