// 外部依赖
import { Body, Controller, Param, ParseIntPipe, Post } from '@nestjs/common';
// 内部依赖
import { Allow } from '@shared';
import { ApiService } from '../api/api.service.js';
import { CdnListDto, CdnOperateDto, CdnRemarkDto } from './cdn.dto.js';

/** CDN 控制器 */
@Controller('tencent/cdn')
@Allow('admin')
export class CdnController {
  /**
   * 构造函数
   *
   * @param apiSrv 腾讯云接口服务
   */
  constructor(private readonly apiSrv: ApiService) {}

  /**
   * 获取 CDN 域名列表
   *
   * @param id 密钥ID
   * @param body 查询参数
   * @returns CDN 域名列表
   */
  @Post('list/:id')
  list(@Param('id', ParseIntPipe) id: number, @Body() body: CdnListDto) {
    return this.apiSrv.cdn(id, 'DescribeDomains', body);
  }

  /**
   * 获取 CDN 域名配置详情
   *
   * @param id 密钥ID
   * @param body 含域名的查询参数
   * @returns CDN 域名配置详情
   */
  @Post('detail/:id')
  detail(@Param('id', ParseIntPipe) id: number, @Body() body: CdnOperateDto) {
    return this.apiSrv.cdn(id, 'DescribeDomainsConfig', {
      Domains: [body.Domain],
    });
  }

  /**
   * 修改 CDN 域名配置（含备注）
   *
   * @param id 密钥ID
   * @param body 修改参数
   * @returns 修改结果
   */
  @Post('remark/:id')
  remark(@Param('id', ParseIntPipe) id: number, @Body() body: CdnRemarkDto) {
    return this.apiSrv.cdn(id, 'ModifyDomainConfig', body);
  }

  /**
   * 启用 CDN 域名
   *
   * @param id 密钥ID
   * @param body 操作参数
   * @returns 操作结果
   */
  @Post('enable/:id')
  enable(@Param('id', ParseIntPipe) id: number, @Body() body: CdnOperateDto) {
    return this.apiSrv.cdn(id, 'StartCdnDomain', body);
  }

  /**
   * 停用 CDN 域名
   *
   * @param id 密钥ID
   * @param body 操作参数
   * @returns 操作结果
   */
  @Post('disable/:id')
  disable(@Param('id', ParseIntPipe) id: number, @Body() body: CdnOperateDto) {
    return this.apiSrv.cdn(id, 'StopCdnDomain', body);
  }

  /**
   * 删除 CDN 域名
   *
   * @param id 密钥ID
   * @param body 删除参数
   * @returns 删除结果
   */
  @Post('delete/:id')
  delete(@Param('id', ParseIntPipe) id: number, @Body() body: CdnOperateDto) {
    return this.apiSrv.cdn(id, 'DeleteCdnDomain', body);
  }
}
