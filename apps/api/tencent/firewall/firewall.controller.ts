// 外部依赖
import { Body, Controller, Param, ParseIntPipe, Post } from '@nestjs/common';
// 内部依赖
import { Allow } from '@shared';
import { ApiService } from '../api/api.service.js';
import {
  CreateFirewallRulesDto,
  DeleteFirewallRulesDto,
  DescribeFirewallRulesDto,
  ModifyFirewallRulesDto,
} from './firewall.dto.js';

/** 防火墙规则控制器，注：轻量服务器的防火墙按地域 + 实例操作 */
@Controller('tencent/firewall')
@Allow('admin')
export class FirewallController {
  /**
   * 构造函数
   *
   * @param apiSrv 腾讯云接口服务
   */
  constructor(private readonly apiSrv: ApiService) {}

  /**
   * 查询防火墙规则
   *
   * @param id 密钥ID
   * @param region 地域
   * @param body 查询参数
   * @returns 防火墙规则列表
   */
  @Post('list/:id/:region')
  list(
    @Param('id', ParseIntPipe) id: number,
    @Param('region') region: string,
    @Body() body: DescribeFirewallRulesDto,
  ) {
    return this.apiSrv.lighthouse(
      id,
      region,
      'DescribeFirewallRules',
      body,
    );
  }

  /**
   * 创建防火墙规则
   *
   * @param id 密钥ID
   * @param region 地域
   * @param body 创建参数
   * @returns 操作结果
   */
  @Post('create/:id/:region')
  create(
    @Param('id', ParseIntPipe) id: number,
    @Param('region') region: string,
    @Body() body: CreateFirewallRulesDto,
  ) {
    return this.apiSrv.lighthouse(id, region, 'CreateFirewallRules', body);
  }

  /**
   * 删除防火墙规则
   *
   * @param id 密钥ID
   * @param region 地域
   * @param body 删除参数
   * @returns 操作结果
   */
  @Post('delete/:id/:region')
  delete(
    @Param('id', ParseIntPipe) id: number,
    @Param('region') region: string,
    @Body() body: DeleteFirewallRulesDto,
  ) {
    return this.apiSrv.lighthouse(id, region, 'DeleteFirewallRules', body);
  }

  /**
   * 修改防火墙规则
   *
   * @param id 密钥ID
   * @param region 地域
   * @param body 修改参数
   * @returns 操作结果
   */
  @Post('modify/:id/:region')
  modify(
    @Param('id', ParseIntPipe) id: number,
    @Param('region') region: string,
    @Body() body: ModifyFirewallRulesDto,
  ) {
    return this.apiSrv.lighthouse(id, region, 'ModifyFirewallRules', body);
  }
}
