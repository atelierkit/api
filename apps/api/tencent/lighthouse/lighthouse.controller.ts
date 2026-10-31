// 外部依赖
import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
// 内部依赖
import { Allow } from '@shared';
import { ApiService } from '../api/api.service.js';
import {
  CreateInstanceDto,
  DeleteInstanceDto,
  DescribeInstancesDto,
  RebootInstanceDto,
  ResetInstancePasswordDto,
  StartInstanceDto,
  StopInstanceDto,
} from './lighthouse.dto.js';

/** 轻量应用服务器控制器 */
@Controller('tencent/lighthouse')
@Allow('admin')
export class LighthouseController {
  /**
   * 构造函数
   *
   * @param apiSrv 腾讯云接口服务
   */
  constructor(private readonly apiSrv: ApiService) {}

  /**
   * 查询地域列表
   *
   * 注：该接口本身不需要地域，故服务名的 region 传空串（`X-TC-Region` 也不会带上）
   *
   * @param id 密钥ID
   * @returns 地域列表
   */
  @Get('regions/:id')
  regions(@Param('id', ParseIntPipe) id: number) {
    return this.apiSrv.lighthouse(id, '', 'DescribeRegions', {});
  }

  /**
   * 查询实例列表
   *
   * @param id 密钥ID
   * @param region 地域
   * @param body 查询参数
   * @returns 实例列表
   */
  @Post('list/:id/:region')
  list(
    @Param('id', ParseIntPipe) id: number,
    @Param('region') region: string,
    @Body() body: DescribeInstancesDto,
  ) {
    return this.apiSrv.lighthouse(id, region, 'DescribeInstances', body);
  }

  /**
   * 查询实例套餐
   *
   * @param id 密钥ID
   * @param region 地域
   * @returns 套餐列表
   */
  @Post('bundles/:id/:region')
  bundles(
    @Param('id', ParseIntPipe) id: number,
    @Param('region') region: string,
  ) {
    return this.apiSrv.lighthouse(id, region, 'DescribeBundles', {});
  }

  /**
   * 启动实例
   *
   * @param id 密钥ID
   * @param region 地域
   * @param body 启动参数
   * @returns 操作结果
   */
  @Post('start/:id/:region')
  start(
    @Param('id', ParseIntPipe) id: number,
    @Param('region') region: string,
    @Body() body: StartInstanceDto,
  ) {
    return this.apiSrv.lighthouse(id, region, 'StartInstance', body);
  }

  /**
   * 停止实例
   *
   * @param id 密钥ID
   * @param region 地域
   * @param body 停止参数
   * @returns 操作结果
   */
  @Post('stop/:id/:region')
  stop(
    @Param('id', ParseIntPipe) id: number,
    @Param('region') region: string,
    @Body() body: StopInstanceDto,
  ) {
    return this.apiSrv.lighthouse(id, region, 'StopInstance', body);
  }

  /**
   * 重启实例
   *
   * @param id 密钥ID
   * @param region 地域
   * @param body 重启参数
   * @returns 操作结果
   */
  @Post('reboot/:id/:region')
  reboot(
    @Param('id', ParseIntPipe) id: number,
    @Param('region') region: string,
    @Body() body: RebootInstanceDto,
  ) {
    return this.apiSrv.lighthouse(id, region, 'RebootInstance', body);
  }

  /**
   * 重置实例密码
   *
   * @param id 密钥ID
   * @param region 地域
   * @param body 重置参数
   * @returns 操作结果
   */
  @Post('reset-password/:id/:region')
  resetPassword(
    @Param('id', ParseIntPipe) id: number,
    @Param('region') region: string,
    @Body() body: ResetInstancePasswordDto,
  ) {
    return this.apiSrv.lighthouse(
      id,
      region,
      'ResetInstancePassword',
      body,
    );
  }

  /**
   * 删除实例
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
    @Body() body: DeleteInstanceDto,
  ) {
    return this.apiSrv.lighthouse(id, region, 'DeleteInstance', body);
  }

  /**
   * 创建实例
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
    @Body() body: CreateInstanceDto,
  ) {
    return this.apiSrv.lighthouse(id, region, 'CreateInstance', body);
  }
}
