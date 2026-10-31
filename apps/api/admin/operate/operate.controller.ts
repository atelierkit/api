// 外部依赖
import { Controller, Get, Body, Param, ParseIntPipe, Post } from '@nestjs/common';
// 内部依赖
import { Allow, OperateIndexDto, OperateService } from '@shared';

/**
 * 操作日志控制器（管理端）
 *
 * 注：操作日志由各业务服务在写操作时自动追加，管理端只读（清单 / 字典 / 详情），
 * 不提供改与删 —— 审计记录能改就等于没有审计
 */
@Controller('admin/operate')
@Allow('admin')
export class AdminOperateController {
  /**
   * 构造函数
   *
   * @param operateSrv 操作日志服务
   */
  constructor(private readonly operateSrv: OperateService) {}

  /**
   * 分页获取操作日志清单
   *
   * @param value 查询条件
   * @returns 操作日志清单与总条数
   */
  @Post('index')
  index(@Body() value: OperateIndexDto) {
    return this.operateSrv.index(value);
  }

  /**
   * 获取操作日志字典（操作用户 / 操作对象 / 操作类型）
   *
   * @returns 查询表单的下拉字典
   */
  @Get('options')
  options() {
    return this.operateSrv.options();
  }

  /**
   * 获取操作日志详情
   *
   * @param id 操作序号ID
   * @returns 操作日志详情
   */
  @Get('show/:id')
  show(@Param('id', ParseIntPipe) id: number) {
    return this.operateSrv.show(id);
  }
}
