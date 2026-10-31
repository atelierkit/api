// 外部依赖
import { Body, Controller, Param, ParseIntPipe, Post } from '@nestjs/common';
// 内部依赖
import { Allow } from '@shared';
import { ApiService } from '../api/api.service.js';
import {
  DnsCreateDto,
  DnsDeleteDto,
  DnsLineDto,
  DnsListDto,
  DnsModifyDto,
  DnsRecordDetailDto,
  DnsTypeDto,
} from './dns.dto.js';

/**
 * DNSPod 解析记录控制器
 *
 * 注：取单条记录走 `DescribeRecord`（`Domain` + `RecordId` → `RecordInfo`）。
 * 旧私有项目这里错用了 `DescribeRecordList` —— 它既不按 `RecordId` 过滤、也不返回 `RecordInfo`，
 * 于是编辑弹窗永远只能退回默认表单
 */
@Controller('tencent/dns')
@Allow('admin')
export class DnsController {
  /**
   * 构造函数
   *
   * @param apiSrv 腾讯云接口服务
   */
  constructor(private readonly apiSrv: ApiService) {}

  /**
   * 获取解析记录列表
   *
   * @param id 密钥ID
   * @param body 查询参数
   * @returns 解析记录列表
   */
  @Post('list/:id')
  list(@Param('id', ParseIntPipe) id: number, @Body() body: DnsListDto) {
    return this.apiSrv.dnspod(id, 'DescribeRecordList', body);
  }

  /**
   * 创建解析记录
   *
   * @param id 密钥ID
   * @param body 创建参数
   * @returns 创建结果
   */
  @Post('create/:id')
  create(@Param('id', ParseIntPipe) id: number, @Body() body: DnsCreateDto) {
    return this.apiSrv.dnspod(id, 'CreateRecord', body);
  }

  /**
   * 修改解析记录
   *
   * @param id 密钥ID
   * @param body 修改参数
   * @returns 修改结果
   */
  @Post('modify/:id')
  modify(@Param('id', ParseIntPipe) id: number, @Body() body: DnsModifyDto) {
    return this.apiSrv.dnspod(id, 'ModifyRecord', body);
  }

  /**
   * 删除解析记录
   *
   * @param id 密钥ID
   * @param body 删除参数
   * @returns 删除结果
   */
  @Post('delete/:id')
  delete(@Param('id', ParseIntPipe) id: number, @Body() body: DnsDeleteDto) {
    return this.apiSrv.dnspod(id, 'DeleteRecord', body);
  }

  /**
   * 获取单条解析记录
   *
   * @param id 密钥ID
   * @param body 查询参数
   * @returns 记录详情（`RecordInfo`）
   */
  @Post('record/:id')
  record(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: DnsRecordDetailDto,
  ) {
    return this.apiSrv.dnspod(id, 'DescribeRecord', body);
  }

  /**
   * 获取记录类型清单
   *
   * @param id 密钥ID
   * @param body 查询参数
   * @returns 记录类型清单
   */
  @Post('type/:id')
  type(@Param('id', ParseIntPipe) id: number, @Body() body: DnsTypeDto) {
    return this.apiSrv.dnspod(id, 'DescribeRecordType', body);
  }

  /**
   * 获取记录线路清单
   *
   * @param id 密钥ID
   * @param body 查询参数
   * @returns 线路清单
   */
  @Post('line/:id')
  line(@Param('id', ParseIntPipe) id: number, @Body() body: DnsLineDto) {
    return this.apiSrv.dnspod(id, 'DescribeRecordLineList', body);
  }
}
