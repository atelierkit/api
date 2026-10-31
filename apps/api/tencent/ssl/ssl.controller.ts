// 外部依赖
import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
// 内部依赖
import { Allow } from '@shared';
import { KongService } from '../../cloud/kong/kong.service.js';
import { ObjectService } from '../../cloud/kong/object/object.service.js';
import { ApiService } from '../api/api.service.js';
import {
  SslAliasDto,
  SslApplyDto,
  SslDeployDto,
  SslDetailDto,
  SslListDto,
  SslOperateDto,
} from './ssl.dto.js';

/** 证书控制器 */
@Controller('tencent/ssl')
@Allow('admin')
export class SslController {
  /** 日志记录器 */
  private readonly logger = new Logger(SslController.name);

  /**
   * 构造函数
   *
   * @param apiSrv 腾讯云接口服务
   * @param kongSrv KONG 站点服务
   * @param objectSrv KONG 对象服务
   */
  constructor(
    private readonly apiSrv: ApiService,
    private readonly kongSrv: KongService,
    private readonly objectSrv: ObjectService,
  ) {}

  /**
   * 获取证书列表
   *
   * @param id 密钥ID
   * @param body 查询参数
   * @returns 证书列表
   */
  @Post('list/:id')
  list(@Param('id', ParseIntPipe) id: number, @Body() body: SslListDto) {
    return this.apiSrv.ssl(id, 'DescribeCertificates', body);
  }

  /**
   * 获取证书详情
   *
   * @param id 密钥ID
   * @param body 查询参数
   * @returns 证书详情（含公钥与私钥）
   */
  @Post('detail/:id')
  detail(@Param('id', ParseIntPipe) id: number, @Body() body: SslDetailDto) {
    return this.apiSrv.ssl(id, 'DescribeCertificateDetail', body);
  }

  /**
   * 申请免费证书
   *
   * @param id 密钥ID
   * @param body 申请参数
   * @returns 申请结果
   */
  @Post('apply/:id')
  apply(@Param('id', ParseIntPipe) id: number, @Body() body: SslApplyDto) {
    return this.apiSrv.ssl(id, 'ApplyCertificate', body);
  }

  /**
   * 修改证书备注别名
   *
   * @param id 密钥ID
   * @param body 修改参数
   * @returns 修改结果
   */
  @Post('alias/:id')
  alias(@Param('id', ParseIntPipe) id: number, @Body() body: SslAliasDto) {
    return this.apiSrv.ssl(id, 'ModifyCertificateAlias', body);
  }

  /**
   * 吊销证书
   *
   * @param id 密钥ID
   * @param body 操作参数
   * @returns 吊销结果
   */
  @Post('revoke/:id')
  revoke(@Param('id', ParseIntPipe) id: number, @Body() body: SslOperateDto) {
    return this.apiSrv.ssl(id, 'RevokeCertificate', body);
  }

  /**
   * 删除证书
   *
   * @param id 密钥ID
   * @param body 操作参数
   * @returns 删除结果
   */
  @Post('delete/:id')
  delete(@Param('id', ParseIntPipe) id: number, @Body() body: SslOperateDto) {
    return this.apiSrv.ssl(id, 'DeleteCertificate', body);
  }

  /**
   * 把腾讯云的证书部署到 KONG 站点
   *
   * 注 1：证书的公私钥由腾讯云接口现取，不经过浏览器 —— 前端只提交证书ID与站点ID
   * 注 2：旧私有项目把整份证书详情（**含私钥**）打进 debug 日志，这里不再打印
   * 注 3：旧项目只判 `CertificatePublicKey` 为空就报 400，证书不存在时用户看到的是
   * 「证书内容或私钥为空」；这里先看 `Response.Error`，把腾讯云的原始错误码透出去
   *
   * @param id 密钥ID
   * @param body 部署参数
   * @returns 部署结果，含动作（created / updated）与 KONG 证书ID
   */
  @Post('deploy/:id')
  async deploy(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: SslDeployDto,
  ) {
    // 1. 取证书详情
    /** 证书详情 */
    const cert = await this.apiSrv.ssl(id, 'DescribeCertificateDetail', {
      CertificateId: body.CertificateId,
    });
    if (cert.Error) {
      throw new BadRequestException(
        cert.Error.Message ?? '获取证书详情失败',
      );
    }
    /** 证书公钥 */
    const publicKey = cert.CertificatePublicKey;
    /** 证书私钥 */
    const privateKey = cert.CertificatePrivateKey;
    if (
      typeof publicKey !== 'string' ||
      typeof privateKey !== 'string' ||
      publicKey === '' ||
      privateKey === ''
    ) {
      throw new BadRequestException('证书内容或私钥为空');
    }
    /** 需提交到 KONG 的证书数据 */
    const certData = { cert: publicKey, key: privateKey, snis: body.domain };

    // 2. 校验 KONG 站点
    /** KONG 站点 */
    const kong = await this.kongSrv.show(body.KongId);
    if (kong === null) {
      throw new NotFoundException('KONG 站点不存在');
    }

    // 3. 更新模式：覆盖站点上已有的证书
    if (body.update === 1) {
      if (!body.id) {
        throw new BadRequestException('更新模式下必须选择待更新的证书');
      }
      /** 目标证书ID */
      const targetId = body.id;
      await this.objectSrv.update(
        body.KongId,
        'certificates',
        targetId,
        certData,
      );
      this.logger.debug(
        `证书 ${body.CertificateId} 已更新到站点 ${body.KongId} 的 ${targetId}`,
      );
      return { message: '证书更新成功', updated: true, certId: targetId };
    }

    // 4. 新建模式
    /** 创建结果 */
    const created = await this.objectSrv.create(
      body.KongId,
      'certificates',
      certData,
    );
    /** 新证书ID */
    const certId = String(created['id'] ?? '');
    this.logger.debug(
      `证书 ${body.CertificateId} 已部署到站点 ${body.KongId} 的 ${certId}`,
    );
    return { message: '证书部署成功', created: true, certId };
  }
}
