// 外部依赖
import {
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';
// 内部依赖
import {
  KUBERNETES_ACTION_NAMES,
  KUBERNETES_OBJECT_TYPES,
  type KubernetesAction,
  type KubernetesObjectType,
} from './object.types.js';

/**
 * 资源名的合法字符
 *
 * 注 1：`name` 会拼进接口路径（`/api/v1/namespaces/default/pods/{name}`），必须挡住 `/`、空白与 `..`；
 * 首字符限定小写字母或数字，同时也就排除了 `..` 与 `-x` 这类非法名
 * 注 2：按 Kubernetes 的 DNS 子域名规则放宽到小写字母、数字、`-` 与 `.`（节点名常带域名后缀），
 * 最长 253
 */
const NAME_PATTERN = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

/**
 * 命名空间的合法字符
 *
 * 注：DNS-1123 标签（最长 63），**允许空串** —— 列表页用它表示「全部命名空间」
 */
const NAMESPACE_PATTERN = /^$|^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** 资源清单入参 */
export class KubernetesObjectIndexDto {
  /** 集群ID */
  @IsInt({ message: '集群ID必须是整数！' })
  @Min(1, { message: '集群ID必须大于 0！' })
  kubernetesId!: number;

  /** 资源类型，注：白名单校验，值会决定路径模板与列表接口 */
  @IsIn(KUBERNETES_OBJECT_TYPES, { message: '资源类型不正确！' })
  type!: KubernetesObjectType;

  /** 命名空间，注：空串表示全部命名空间（仅列表有意义） */
  @IsOptional()
  @Matches(NAMESPACE_PATTERN, {
    message: '命名空间格式不正确，只能是小写字母、数字与连字符！',
  })
  namespace?: string;
}

/** 资源详情入参 */
export class KubernetesObjectShowDto extends KubernetesObjectIndexDto {
  /** 资源名 */
  @Matches(NAME_PATTERN, { message: '资源名格式不正确！' })
  id!: string;
}

/**
 * 资源动作入参
 *
 * 注 1：`replicas` / `gracePeriod` 平铺成字段而不是 `Record<string, unknown>` —— 后者等于把参数
 * 透传给 API Server，本模块刻意不提供这种能力
 * 注 2：`action` 只校验并集，具体类型是否支持由服务层按 `KUBERNETES_OBJECT_ACTIONS` 判定
 */
export class KubernetesObjectActionDto extends KubernetesObjectShowDto {
  /** 动作 */
  @IsIn(KUBERNETES_ACTION_NAMES, { message: '不支持的操作！' })
  action!: KubernetesAction;

  /** 扩缩容的目标副本数，注：scale 动作必填，由服务层判定 */
  @IsOptional()
  @IsInt({ message: '副本数必须是整数！' })
  @Min(0, { message: '副本数不能小于 0！' })
  @Max(1000, { message: '副本数不能超过 1000！' })
  replicas?: number;

  /** 删除前的优雅退出秒数 */
  @IsOptional()
  @IsInt({ message: '优雅退出时间必须是整数！' })
  @Min(0, { message: '优雅退出时间不能小于 0！' })
  @Max(600, { message: '优雅退出时间不能超过 600 秒！' })
  gracePeriod?: number;
}
