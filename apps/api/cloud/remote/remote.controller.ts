// 外部依赖
import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
// 内部依赖
import { Allow, CommonController, ReqId, UserId } from '@shared';
import { RemoteCreateDto, RemoteKeyInspectDto, RemoteTicketDto, RemoteTrustDto, RemoteUpdateDto } from './remote.dto.js';
import { RemoteService } from './remote.service.js';
import { RemoteSessionService } from './remote.session.js';

/**
 * 远程主机控制器
 *
 * 注 1：主机的增删改查由 `CommonController` 基类提供，这里额外补四个接口：
 * 概览、诊断、签发终端票据、信任新指纹；终端数据流走 `RemoteGateway`（命名空间 `/remote`）
 * 注 2：全部接口都要 `admin` 角色 —— 拿到主机与凭据就等于拿到目标机的 shell
 */
@Controller('cloud/remote')
@Allow('admin')
export class RemoteController extends CommonController<
  RemoteService,
  RemoteCreateDto,
  RemoteUpdateDto
> {
  /**
   * 构造函数
   *
   * @param remoteSrv 主机服务
   * @param sessionSrv 会话服务，注：票据由这里签发（HTTP 侧鉴权已由全局守卫完成）
   */
  constructor(
    protected readonly remoteSrv: RemoteService,
    private readonly sessionSrv: RemoteSessionService,
  ) {
    super(remoteSrv);
  }

  /**
   * 预检私钥文件内容
   *
   * 注：只回「识别结果」（格式 / 是否转换 / 是否加密 / 公钥指纹），**不回私钥明文**；
   * 真正的格式转换在保存时做，与这里走同一个 `normalizePrivateKey`
   *
   * @param value 私钥预检入参（文件内容 + 口令）
   * @returns 识别结果
   */
  @Post('key/inspect')
  inspectKey(@Body() value: RemoteKeyInspectDto) {
    return this.remoteSrv.inspectKey(value.content, value.passphrase ?? '');
  }

  /**
   * 获取主机概览（发行版 / 内核 / 负载 / 内存 / 磁盘）
   *
   * @param id 主机ID
   * @returns 概览
   */
  @Get('summary/:id')
  summary(@Param('id', ParseIntPipe) id: number) {
    return this.remoteSrv.summary(id);
  }

  /**
   * 获取主机连通性诊断（TCP / 握手 / 认证 / 命令执行 / 指纹）
   *
   * @param id 主机ID
   * @returns 诊断结果
   */
  @Get('diagnose/:id')
  diagnose(@Param('id', ParseIntPipe) id: number) {
    return this.remoteSrv.diagnose(id);
  }

  /**
   * 申请终端票据
   *
   * 注：WS 不受 `TokenGuard` 保护，故终端连接必须先拿到这张一次性票据 ——
   * 鉴权（令牌 + admin 角色）在 HTTP 侧完成，WS 只认票据
   *
   * @param value 票据申请入参（主机ID + 终端尺寸）
   * @param userId 操作用户ID
   * @returns 票据与失效时刻
   */
  @Post('ticket')
  ticket(@Body() value: RemoteTicketDto, @UserId() userId: number) {
    return this.sessionSrv.issue(userId, value.id, {
      cols: value.cols,
      rows: value.rows,
    });
  }

  /**
   * 信任主机的新指纹
   *
   * 注：只在用户看到「新旧指纹对比」并明确确认后调用；写入会照常进变更历史
   *
   * @param value 信任入参（主机ID + 新指纹）
   * @param userId 操作用户ID
   * @param reqId 请求日志ID
   * @returns 主机ID
   */
  @Post('trust')
  trust(
    @Body() value: RemoteTrustDto,
    @UserId() userId: number,
    @ReqId() reqId: number,
  ) {
    return this.remoteSrv.rememberFingerprint(
      value.id,
      value.fingerprint,
      userId,
      reqId,
    );
  }
}
