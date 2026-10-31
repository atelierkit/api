// 外部依赖
import { Body, Controller, Param, ParseIntPipe, Post } from '@nestjs/common';
// 内部依赖
import { Allow } from '@shared';
import { ApiService } from '../api/api.service.js';
import {
  DomainDetailDto,
  DomainListDto,
  DomainRemarkDto,
} from './domain.dto.js';

/** 域名控制器 */
@Controller('tencent/domain')
@Allow('admin')
export class DomainController {
  /**
   * 构造函数
   *
   * @param apiSrv 腾讯云接口服务
   */
  constructor(private readonly apiSrv: ApiService) {}

  /**
   * 获取域名列表
   *
   * @param id 密钥ID
   * @param body 查询参数
   * @returns 域名列表
   */
  @Post('list/:id')
  list(@Param('id', ParseIntPipe) id: number, @Body() body: DomainListDto) {
    return this.apiSrv.dnspod(id, 'DescribeDomainList', body);
  }

  /**
   * 修改域名备注
   *
   * @param id 密钥ID
   * @param body 修改参数
   * @returns 修改结果
   */
  @Post('remark/:id')
  remark(@Param('id', ParseIntPipe) id: number, @Body() body: DomainRemarkDto) {
    return this.apiSrv.dnspod(id, 'ModifyDomainRemark', body);
  }

  /**
   * 获取域名详情
   *
   * @param id 密钥ID
   * @param body 查询参数
   * @returns 域名详情
   */
  @Post('detail/:id')
  detail(@Param('id', ParseIntPipe) id: number, @Body() body: DomainDetailDto) {
    return this.apiSrv.dnspod(id, 'DescribeDomain', body);
  }
}
