// 外部依赖
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * API Server 地址的合法形态
 *
 * 注：只允许 `http://` / `https://`，`http://` 仅用于本机 `kubectl proxy`（服务层要求显式确认）；
 * 端口可省略，缺省按 6443
 */
const ENDPOINT_PATTERN = /^(http|https):\/\/[A-Za-z0-9._-]+(:\d{1,5})?$/;

/**
 * 命名空间形态
 *
 * 注：Kubernetes 的命名空间是 DNS-1123 标签（小写字母、数字、连字符，最长 63）；
 * **允许空串** —— 列表页用它表示「全部命名空间」
 */
const NAMESPACE_PATTERN = /^$|^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** 创建 Kubernetes 集群DTO */
export class KubernetesCreateDto {
  /** 集群名称 */
  @IsNotEmpty({ message: '集群名称不能为空！' })
  @MaxLength(50, { message: '集群名称不能超过 50 个字符！' })
  name!: string;

  /** 集群说明 */
  @IsNotEmpty({ message: '集群说明不能为空！' })
  @MaxLength(200, { message: '集群说明不能超过 200 个字符！' })
  description!: string;

  /** API Server 地址 */
  @IsNotEmpty({ message: '集群地址不能为空！' })
  @MaxLength(200, { message: '集群地址不能超过 200 个字符！' })
  @Matches(ENDPOINT_PATTERN, {
    message: '集群地址格式不正确，应为 https://主机:端口（如 https://192.168.1.3:6443）！',
  })
  endpoint!: string;

  /**
   * ServiceAccount Token
   *
   * 注：与客户端证书二选一（至少给一个），联动校验在服务层 —— 两个字段都可能为空，
   * DTO 的 `@ValidateIf` 表达不了「至少一个」，与其写成互相依赖的规则不如让服务层给可读提示
   */
  @IsOptional()
  token?: string;

  /** CA 证书 PEM，注：空表示用系统根证书 */
  @IsOptional()
  ca?: string;

  /** 客户端证书 PEM，注：与 token 二选一 */
  @IsOptional()
  cert?: string;

  /** 客户端私钥 PEM，注：配了客户端证书就必须配私钥，落库前加密 */
  @IsOptional()
  key?: string;

  /** 是否校验证书链与主机名 */
  @IsBoolean({ message: '证书校验开关格式不正确！' })
  verify!: boolean;

  /** 默认命名空间，注：留空按 `default` 处理 */
  @IsOptional()
  @Matches(NAMESPACE_PATTERN, {
    message: '命名空间格式不正确，只能是小写字母、数字与连字符！',
  })
  namespace?: string;

  /**
   * 是否允许明文连接
   *
   * 注：只为「显式确认」服务，**不落库**（服务层剥掉）。明文访问远端 API Server
   * 会让 token 与全部响应暴露在链路上
   */
  @IsOptional()
  @IsBoolean({ message: '明文连接开关格式不正确！' })
  allowInsecure?: boolean;

  /** 启用状态 */
  @IsBoolean({ message: '状态格式不正确！' })
  status!: boolean;
}

/** 更新 Kubernetes 集群DTO，注：字段全部可选，前端按需只提交改动项 */
export class KubernetesUpdateDto {
  /** 集群名称 */
  @IsOptional()
  @IsNotEmpty({ message: '集群名称不能为空！' })
  @MaxLength(50, { message: '集群名称不能超过 50 个字符！' })
  name?: string;

  /** 集群说明 */
  @IsOptional()
  @IsNotEmpty({ message: '集群说明不能为空！' })
  @MaxLength(200, { message: '集群说明不能超过 200 个字符！' })
  description?: string;

  /** API Server 地址 */
  @IsOptional()
  @IsNotEmpty({ message: '集群地址不能为空！' })
  @MaxLength(200, { message: '集群地址不能超过 200 个字符！' })
  @Matches(ENDPOINT_PATTERN, {
    message: '集群地址格式不正确，应为 https://主机:端口（如 https://192.168.1.3:6443）！',
  })
  endpoint?: string;

  /**
   * ServiceAccount Token
   *
   * 注：详情接口不下发 token，编辑时提交空串或 `***` 都表示「不修改」
   */
  @IsOptional()
  token?: string;

  /** CA 证书 PEM */
  @IsOptional()
  ca?: string;

  /** 客户端证书 PEM */
  @IsOptional()
  cert?: string;

  /** 客户端私钥 PEM，注：空串或 `***` 表示「不修改」 */
  @IsOptional()
  key?: string;

  /**
   * 清空 Token
   *
   * 注：详情接口不下发 Token，故「空串」只能表示「不修改」；要真正删掉得靠这个显式开关。
   * 从 Token 切到客户端证书时**必须**清掉旧 Token —— API Server 的鉴权是「先试 Token」，
   * 一个失效的 Bearer 头会直接 401，不会回退到客户端证书
   */
  @IsOptional()
  @IsBoolean({ message: '清空 Token 开关格式不正确！' })
  clearToken?: boolean;

  /** 清空客户端证书三件套（CA / 证书 / 私钥），注：与「Token 切证书」同一用途 */
  @IsOptional()
  @IsBoolean({ message: '清空客户端证书开关格式不正确！' })
  clearCert?: boolean;

  /** 是否校验证书链与主机名 */
  @IsOptional()
  @IsBoolean({ message: '证书校验开关格式不正确！' })
  verify?: boolean;

  /** 默认命名空间 */
  @IsOptional()
  @Matches(NAMESPACE_PATTERN, {
    message: '命名空间格式不正确，只能是小写字母、数字与连字符！',
  })
  namespace?: string;

  /** 是否允许明文连接，注：不落库，见 `KubernetesCreateDto.allowInsecure` */
  @IsOptional()
  @IsBoolean({ message: '明文连接开关格式不正确！' })
  allowInsecure?: boolean;

  /** 启用状态 */
  @IsOptional()
  @IsBoolean({ message: '状态格式不正确！' })
  status?: boolean;
}
