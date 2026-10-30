// 外部依赖
import {
  NotFoundException,
  Get,
  Post,
  Query,
  Param,
  Body,
} from '@nestjs/common';
// 内部依赖
import type { OptionEntity, OptionEntityLog } from './option.service.js';
import { OperatePipe } from '../operate/operate.pipe.js';
import { OptionService } from './option.service.js';
import { ReqId } from '../req/req.decorator.js';
import { UserId } from '../user/user.decorator.js';

/**
 * 通用配置对象控制器
 *
 * @template Service - 配置对象服务类型
 * @template UpdateDto - 更新配置DTO类型
 */
export abstract class OptionController<
  Service extends OptionService<OptionEntity, OptionEntityLog>,
  UpdateDto extends Partial<OptionEntity>,
> {
  /**
   * 构造函数
   *
   * @param optionSrv 配置对象服务
   */
  constructor(private readonly optionSrv: Service) {}

  /**
   * 获取对象清单
   *
   * @param operateId 操作序号，用于获取增量数据
   * @returns 对象清单
   */
  @Get('index')
  index(@Query('operateId', OperatePipe) operateId: number) {
    return this.optionSrv.index(operateId);
  }

  /**
   * 获取对象详情
   *
   * @param key 对象键值
   * @returns 对象详情
   */
  @Get('show/:key')
  async show(@Param('key') key: string) {
    const option = await this.optionSrv.show(key);
    if (option === null) {
      throw new NotFoundException(`当前对象不存在！`);
    }
    return option;
  }

  /**
   * 获取对象变更日志
   *
   * @param key 对象键值
   * @returns 对象变更记录
   */
  @Get('log/:key')
  log(@Param('key') key: string) {
    return this.optionSrv.log(key);
  }

  /**
   * 创建对象
   *
   * @param value 提交消息体
   * @param userId 操作用户ID
   * @param reqId 日志请求ID
   * @returns 对象主键值
   */
  @Post('create')
  async create(
    @Body() value: UpdateDto,
    @UserId() userId: number,
    @ReqId() reqId: number,
  ) {
    return this.optionSrv.create(value, userId, reqId);
  }

  /**
   * 更新对象（含禁用）
   *
   * @param key 对象键值
   * @param value 提交消息体
   * @param userId 操作用户ID
   * @param reqId 日志请求ID
   * @returns 对象主键值
   */
  @Post('update/:key')
  async update(
    @Param('key') key: string,
    @Body() value: UpdateDto,
    @UserId() userId: number,
    @ReqId() reqId: number,
  ) {
    return this.optionSrv.update(key, value, userId, reqId);
  }
}
