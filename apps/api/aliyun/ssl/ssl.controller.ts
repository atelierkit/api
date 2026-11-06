// 外部依赖
import { Body, Controller, Param, ParseIntPipe, Post } from '@nestjs/common';
// 内部依赖
import { Allow } from '@shared';
import {
  SslAuditDto,
  SslCancelDto,
  SslDeleteDto,
  SslDeployDto,
  SslDetailDto,
  SslImportDto,
  SslListDto,
  SslStateDto,
  SslVerifyDto,
} from './ssl.dto.js';
import { SslService } from './ssl.service.js';

/**
 * 阿里云 SSL 证书控制器
 *
 * 注 1：全部 `@Allow('admin')`，鉴权由全局 `TokenGuard` 完成
 * 注 2：接口一律 POST + 请求体 —— 与 `tencent/ssl` 保持同一种调用风格，前端不必为不同方法写两套
 * 注 3：本控制器只做参数转交，字段归一化与错误翻译都在 `SslService` 里
 */
@Controller('aliyun/ssl')
@Allow('admin')
export class SslController {
  /**
   * 构造函数
   *
   * @param sslSrv 证书服务
   */
  constructor(private readonly sslSrv: SslService) {}

  /**
   * 获取证书列表
   *
   * @param id 密钥ID
   * @param body 查询条件
   * @returns 证书列表与总数
   */
  @Post('list/:id')
  list(@Param('id', ParseIntPipe) id: number, @Body() body: SslListDto) {
    return this.sslSrv.list(id, body);
  }

  /**
   * 获取证书详情（概览，不含私钥）
   *
   * @param id 密钥ID
   * @param body 查询条件
   * @returns 证书概览
   */
  @Post('show/:id')
  show(@Param('id', ParseIntPipe) id: number, @Body() body: SslDetailDto) {
    return this.sslSrv.show(id, body);
  }

  /**
   * 获取证书的公私钥
   *
   * 注：单独一条路由 —— 只在用户显式点「查看私钥」时才下发 PEM，避免每次打开详情页都过一遍私钥
   *
   * @param id 密钥ID
   * @param body 查询条件
   * @returns PEM 证书与私钥
   */
  @Post('pem/:id')
  pem(@Param('id', ParseIntPipe) id: number, @Body() body: SslDetailDto) {
    return this.sslSrv.pem(id, body);
  }

  /**
   * 上传证书
   *
   * @param id 密钥ID
   * @param body 上传参数
   * @returns 新证书ID
   */
  @Post('import/:id')
  import(@Param('id', ParseIntPipe) id: number, @Body() body: SslImportDto) {
    return this.sslSrv.import(id, body);
  }

  /**
   * 删除证书
   *
   * @param id 密钥ID
   * @param body 删除参数
   * @returns 删除结果
   */
  @Post('delete/:id')
  remove(@Param('id', ParseIntPipe) id: number, @Body() body: SslDeleteDto) {
    return this.sslSrv.remove(id, body);
  }

  /**
   * 获取订单列表
   *
   * @param id 密钥ID
   * @param body 查询条件
   * @returns 订单列表与总数
   */
  @Post('orders/:id')
  orders(@Param('id', ParseIntPipe) id: number, @Body() body: SslListDto) {
    return this.sslSrv.orders(id, body);
  }

  /**
   * 提交 DV 证书申请
   *
   * @param id 密钥ID
   * @param body 申请参数
   * @returns 提交结果
   */
  @Post('audit/:id')
  audit(@Param('id', ParseIntPipe) id: number, @Body() body: SslAuditDto) {
    return this.sslSrv.audit(id, body);
  }

  /**
   * 取消证书申请
   *
   * 注：取消后订单会彻底消失（不可恢复），前端必须二次确认
   *
   * @param id 密钥ID
   * @param body 取消参数
   * @returns 取消结果
   */
  @Post('cancel/:id')
  cancel(@Param('id', ParseIntPipe) id: number, @Body() body: SslCancelDto) {
    return this.sslSrv.cancel(id, body);
  }

  /**
   * 查询申请状态
   *
   * @param id 密钥ID
   * @param body 查询条件
   * @returns 状态与验证记录
   */
  @Post('state/:id')
  state(@Param('id', ParseIntPipe) id: number, @Body() body: SslStateDto) {
    return this.sslSrv.state(id, body);
  }

  /**
   * 探测 DNS 验证信息（只读）
   *
   * @param id 密钥ID
   * @param body 探测条件
   * @returns 记录要求、DNS 状态与域名 NS
   */
  @Post('verify/:id')
  verify(@Param('id', ParseIntPipe) id: number, @Body() body: SslVerifyDto) {
    return this.sslSrv.verify(id, body);
  }

  /**
   * 部署证书到 KONG 站点
   *
   * @param id 密钥ID
   * @param body 部署参数
   * @returns 部署结果
   */
  @Post('deploy/:id')
  deploy(@Param('id', ParseIntPipe) id: number, @Body() body: SslDeployDto) {
    return this.sslSrv.deploy(id, body);
  }
}
