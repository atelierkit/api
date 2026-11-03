// 外部依赖
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * daemon 地址的合法形态
 *
 * 注：只允许 `tcp://` / `http://` / `https://` 三种前缀，`unix://` 刻意不支持（见 `parseEndpoint`）；
 * 端口可省略，缺省按 TLS / 明文取 2376 / 2375
 */
const ENDPOINT_PATTERN = /^(tcp|http|https):\/\/[A-Za-z0-9._-]+(:\d{1,5})?$/;

/** API 版本形态，注：形如 `1.47`，会拼进请求路径的 `/v1.47` 前缀 */
const API_VERSION_PATTERN = /^\d+\.\d+$/;

/** 创建 Docker 宿主机DTO */
export class DockerCreateDto {
  /** 实例名称 */
  @IsNotEmpty({ message: '实例名称不能为空！' })
  @MaxLength(50, { message: '实例名称不能超过 50 个字符！' })
  name!: string;

  /** 实例说明 */
  @IsNotEmpty({ message: '实例说明不能为空！' })
  @MaxLength(200, { message: '实例说明不能超过 200 个字符！' })
  description!: string;

  /** daemon 地址 */
  @IsNotEmpty({ message: '接口地址不能为空！' })
  @MaxLength(200, { message: '接口地址不能超过 200 个字符！' })
  @Matches(ENDPOINT_PATTERN, {
    message: '接口地址格式不正确，应为 tcp://主机:端口 或 https://主机:端口！',
  })
  endpoint!: string;

  /**
   * 是否启用 TLS 客户端证书
   *
   * 注：不能用 `@IsNotEmpty()` —— 它对 `false` 判空
   */
  @IsBoolean({ message: 'TLS 开关格式不正确！' })
  tls!: boolean;

  /** CA 证书 PEM，注：空表示用系统根证书 */
  @IsOptional()
  ca?: string;

  /** 客户端证书 PEM，注：启用 TLS 时必填 */
  @ValidateIf((value: DockerCreateDto) => value.tls === true)
  @IsNotEmpty({ message: '启用 TLS 时客户端证书不能为空！' })
  cert?: string;

  /** 客户端私钥 PEM，注：启用 TLS 时必填，落库前加密 */
  @ValidateIf((value: DockerCreateDto) => value.tls === true)
  @IsNotEmpty({ message: '启用 TLS 时客户端私钥不能为空！' })
  key?: string;

  /** 是否校验证书链与主机名 */
  @IsBoolean({ message: '证书校验开关格式不正确！' })
  verify!: boolean;

  /** 手工指定的 API 版本，注：留空由后端探测 */
  @IsOptional()
  @Matches(API_VERSION_PATTERN, {
    message: 'API 版本格式不正确，应为 1.47 这样的形式！',
  })
  apiVersion?: string;

  /**
   * 是否允许明文连接
   *
   * 注：只为「显式确认」服务，**不落库**（服务层剥掉）。明文 daemon 没有鉴权，
   * 局域网内任何人都能控制宿主机，故必须由用户勾选后才放行
   */
  @IsOptional()
  @IsBoolean({ message: '明文连接开关格式不正确！' })
  allowInsecure?: boolean;

  /** 启用状态 */
  @IsBoolean({ message: '状态格式不正确！' })
  status!: boolean;
}

/** 更新 Docker 宿主机DTO，注：字段全部可选，前端按需只提交改动项 */
export class DockerUpdateDto {
  /** 实例名称 */
  @IsOptional()
  @IsNotEmpty({ message: '实例名称不能为空！' })
  @MaxLength(50, { message: '实例名称不能超过 50 个字符！' })
  name?: string;

  /** 实例说明 */
  @IsOptional()
  @IsNotEmpty({ message: '实例说明不能为空！' })
  @MaxLength(200, { message: '实例说明不能超过 200 个字符！' })
  description?: string;

  /** daemon 地址 */
  @IsOptional()
  @IsNotEmpty({ message: '接口地址不能为空！' })
  @MaxLength(200, { message: '接口地址不能超过 200 个字符！' })
  @Matches(ENDPOINT_PATTERN, {
    message: '接口地址格式不正确，应为 tcp://主机:端口 或 https://主机:端口！',
  })
  endpoint?: string;

  /** 是否启用 TLS 客户端证书 */
  @IsOptional()
  @IsBoolean({ message: 'TLS 开关格式不正确！' })
  tls?: boolean;

  /** CA 证书 PEM */
  @IsOptional()
  ca?: string;

  /** 客户端证书 PEM */
  @IsOptional()
  cert?: string;

  /**
   * 客户端私钥 PEM
   *
   * 注：详情接口不下发私钥，编辑时提交空串表示「不修改」，提交 `***` 与空串同义；
   * 要清空私钥请把 TLS 关掉（服务层会连带清空证书三件套）
   */
  @IsOptional()
  key?: string;

  /** 是否校验证书链与主机名 */
  @IsOptional()
  @IsBoolean({ message: '证书校验开关格式不正确！' })
  verify?: boolean;

  /** 手工指定的 API 版本 */
  @IsOptional()
  @Matches(API_VERSION_PATTERN, {
    message: 'API 版本格式不正确，应为 1.47 这样的形式！',
  })
  apiVersion?: string;

  /** 是否允许明文连接，注：不落库，见 `DockerCreateDto.allowInsecure` */
  @IsOptional()
  @IsBoolean({ message: '明文连接开关格式不正确！' })
  allowInsecure?: boolean;

  /** 启用状态 */
  @IsOptional()
  @IsBoolean({ message: '状态格式不正确！' })
  status?: boolean;
}
