// 外部依赖
import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
// 内部依赖
import { SettingService } from './setting.service.js';

/** 配置控制器 */
@Controller('setting')
export class SettingController {
  /**
   * 构造函数
   *
   * @param settingSrv 配置服务服务
   */
  constructor(private readonly settingSrv: SettingService) {}

  /**
   * 获取配置
   *
   * @param code 请求上下文
   * @returns 用户信息
   */
  @Get(':code')
  async get(@Param('code') code: string): Promise<unknown> {
    const result = await this.settingSrv.show(code);
    if (result) {
      return result.value;
    }
    throw new NotFoundException(`参数${code}未配置！`);
  }
}
