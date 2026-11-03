// 外部依赖
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
// 内部依赖
import { REMOTE_AUTH_TYPES, REMOTE_CHARSETS } from './remote.types.js';

/**
 * 主机名 / IP 的合法形态
 *
 * 注 1：首字符必须是字母或数字 —— 挡掉 `-oProxyCommand=…` 这类以短横开头的注入尝试
 * （虽然连接走的是 ssh2 而非命令行，但地址最终会出现在日志与提示里，收窄一点没有坏处）
 * 注 2：不支持 IPv6 字面量（`[::1]`），家用场景用不到，需要时再补
 */
const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/;

/** 用户名的合法形态，注：`@` 供 `user@domain` 形式使用 */
const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

/** 创建远程主机DTO */
export class RemoteCreateDto {
  /** 主机名称 */
  @IsNotEmpty({ message: '主机名称不能为空！' })
  @MaxLength(50, { message: '主机名称不能超过 50 个字符！' })
  name!: string;

  /** 主机说明 */
  @IsNotEmpty({ message: '主机说明不能为空！' })
  @MaxLength(200, { message: '主机说明不能超过 200 个字符！' })
  description!: string;

  /** 主机名或 IP */
  @IsNotEmpty({ message: '主机地址不能为空！' })
  @Matches(HOST_PATTERN, {
    message: '主机地址格式不正确：只能是主机名或 IPv4，且不能以短横、点开头！',
  })
  host!: string;

  /** SSH 端口 */
  @IsInt({ message: '端口必须是整数！' })
  @Min(1, { message: '端口必须在 1 ~ 65535 之间！' })
  @Max(65535, { message: '端口必须在 1 ~ 65535 之间！' })
  port!: number;

  /** 鉴权方式 */
  @IsIn(REMOTE_AUTH_TYPES, { message: '鉴权方式只能是 password 或 key！' })
  authType!: string;

  /** 登录用户 */
  @IsNotEmpty({ message: '登录用户不能为空！' })
  @Matches(USERNAME_PATTERN, {
    message: '登录用户只能包含字母、数字、点、下划线、@ 与短横！',
  })
  username!: string;

  /** 登录密码，注：密码鉴权时必填，落库前加密 */
  @ValidateIf((value: RemoteCreateDto) => value.authType === 'password')
  @IsNotEmpty({ message: '密码鉴权时登录密码不能为空！' })
  password?: string;

  /** 客户端私钥，注：私钥鉴权时必填，落库前加密 */
  @ValidateIf((value: RemoteCreateDto) => value.authType === 'key')
  @IsNotEmpty({ message: '私钥鉴权时私钥不能为空！' })
  privateKey?: string;

  /** 私钥口令，注：可空（未加密的私钥） */
  @IsOptional()
  passphrase?: string;

  /** 终端字符集，注：缺省 utf-8 */
  @IsOptional()
  @IsIn(REMOTE_CHARSETS, { message: '终端字符集只能是 utf-8 或 gb18030！' })
  charset?: string;

  /** SFTP 起始目录，注：空串表示用户 home */
  @IsOptional()
  @MaxLength(200, { message: '起始目录不能超过 200 个字符！' })
  rootPath?: string;

  /** 启用状态 */
  @IsBoolean({ message: '状态格式不正确！' })
  status!: boolean;
}

/** 更新远程主机DTO，注：字段全部可选，前端按需只提交改动项 */
export class RemoteUpdateDto {
  /** 主机名称 */
  @IsOptional()
  @IsNotEmpty({ message: '主机名称不能为空！' })
  @MaxLength(50, { message: '主机名称不能超过 50 个字符！' })
  name?: string;

  /** 主机说明 */
  @IsOptional()
  @IsNotEmpty({ message: '主机说明不能为空！' })
  @MaxLength(200, { message: '主机说明不能超过 200 个字符！' })
  description?: string;

  /** 主机名或 IP */
  @IsOptional()
  @Matches(HOST_PATTERN, {
    message: '主机地址格式不正确：只能是主机名或 IPv4，且不能以短横、点开头！',
  })
  host?: string;

  /** SSH 端口 */
  @IsOptional()
  @IsInt({ message: '端口必须是整数！' })
  @Min(1, { message: '端口必须在 1 ~ 65535 之间！' })
  @Max(65535, { message: '端口必须在 1 ~ 65535 之间！' })
  port?: number;

  /** 鉴权方式 */
  @IsOptional()
  @IsIn(REMOTE_AUTH_TYPES, { message: '鉴权方式只能是 password 或 key！' })
  authType?: string;

  /** 登录用户 */
  @IsOptional()
  @Matches(USERNAME_PATTERN, {
    message: '登录用户只能包含字母、数字、点、下划线、@ 与短横！',
  })
  username?: string;

  /**
   * 登录密码
   *
   * 注：详情接口不下发密码，编辑时提交空串或 `***` 都表示「不修改」；
   * 要清空密码请把鉴权方式切到「私钥」（服务层会连带清空密码）
   */
  @IsOptional()
  password?: string;

  /** 客户端私钥，注：空串或 `***` 表示不修改 */
  @IsOptional()
  privateKey?: string;

  /** 私钥口令，注：空串或 `***` 表示不修改 */
  @IsOptional()
  passphrase?: string;

  /** 终端字符集 */
  @IsOptional()
  @IsIn(REMOTE_CHARSETS, { message: '终端字符集只能是 utf-8 或 gb18030！' })
  charset?: string;

  /** SFTP 起始目录 */
  @IsOptional()
  @MaxLength(200, { message: '起始目录不能超过 200 个字符！' })
  rootPath?: string;

  /**
   * 主机公钥指纹
   *
   * 注：只允许 `POST /trust` 改它，普通更新提交该字段会被服务层**忽略** ——
   * 否则前端一次普通保存就能把「指纹已变更」的告警静默抹掉
   */
  @IsOptional()
  fingerprint?: string;

  /** 启用状态 */
  @IsOptional()
  @IsBoolean({ message: '状态格式不正确！' })
  status?: boolean;
}

/** 申请终端票据DTO */
export class RemoteTicketDto {
  /** 主机ID */
  @IsInt({ message: '主机ID必须是整数！' })
  @Min(1, { message: '主机ID不正确！' })
  id!: number;

  /** 终端列数 */
  @IsInt({ message: '终端列数必须是整数！' })
  @Min(20, { message: '终端列数不能小于 20！' })
  @Max(500, { message: '终端列数不能大于 500！' })
  cols!: number;

  /** 终端行数 */
  @IsInt({ message: '终端行数必须是整数！' })
  @Min(5, { message: '终端行数不能小于 5！' })
  @Max(300, { message: '终端行数不能大于 300！' })
  rows!: number;
}

/** 信任新主机指纹DTO */
export class RemoteTrustDto {
  /** 主机ID */
  @IsInt({ message: '主机ID必须是整数！' })
  @Min(1, { message: '主机ID不正确！' })
  id!: number;

  /**
   * 新的主机指纹
   *
   * 注：必须由前端把「当前握手到的指纹」原样带回 —— 服务端不会自己重连去取，
   * 否则用户在弹窗里看到的指纹与最终写库的可能不是一个
   */
  @IsNotEmpty({ message: '主机指纹不能为空！' })
  @Matches(/^SHA256:[A-Za-z0-9+/]{40,50}$/, {
    message: '主机指纹格式不正确，应为 SHA256: 开头的 base64 摘要！',
  })
  fingerprint!: string;
}
