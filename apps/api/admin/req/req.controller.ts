// 外部依赖
import { Controller, Get, Body, Param, ParseIntPipe, Post } from '@nestjs/common';
// 内部依赖
import { Allow, ReqId, ReqIndexDto, ReqService } from '@shared';

/**
 * 请求日志控制器（管理端）
 *
 * 注 1：查询条件里的用户 / 路径 / 控制器 / 方法名都有对应的字典接口，供前端渲染下拉
 * 注 2：`index` 带上当前请求ID —— 正在被写入的那条日志（即本次查询自己）不应出现在结果里
 */
@Controller('admin/req')
@Allow('admin')
export class AdminReqController {
  /**
   * 构造函数
   *
   * @param reqSrv 请求日志服务
   */
  constructor(private readonly reqSrv: ReqService) {}

  /**
   * 获取请求路径字典
   *
   * @returns 请求路径清单
   */
  @Get('url')
  url() {
    return this.reqSrv.url();
  }

  /**
   * 获取请求用户字典
   *
   * @returns 请求用户清单
   */
  @Get('user')
  user() {
    return this.reqSrv.user();
  }

  /**
   * 获取控制器字典
   *
   * @returns 控制器清单
   */
  @Get('controller')
  controller() {
    return this.reqSrv.controller();
  }

  /**
   * 获取指定控制器的方法名字典
   *
   * @param controller 控制器名
   * @returns 方法名清单
   */
  @Get('action/:controller')
  action(@Param('controller') controller: string) {
    return this.reqSrv.action(controller);
  }

  /**
   * 分页搜索请求日志
   *
   * @param value 查询条件
   * @param reqId 当前请求ID，注：用于把本次查询自身从结果里剔掉
   * @returns 请求日志清单与总条数
   */
  @Post('index')
  index(@Body() value: ReqIndexDto, @ReqId() reqId: number) {
    return this.reqSrv.index(value, reqId);
  }

  /**
   * 获取请求日志详情
   *
   * @param id 请求日志ID
   * @returns 请求日志详情
   */
  @Get('show/:id')
  show(@Param('id', ParseIntPipe) id: number) {
    return this.reqSrv.show(id);
  }
}
