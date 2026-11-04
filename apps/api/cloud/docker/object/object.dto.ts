// 外部依赖
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';
// 内部依赖
import { DOCKER_LOG_TAIL_MAX } from './object.logs.js';
import {
  DOCKER_ACTION_NAMES,
  DOCKER_OBJECT_TYPES,
  type DockerAction,
  type DockerObjectType,
} from './object.types.js';

/**
 * 资源ID的合法字符
 *
 * 注 1：`id` 会拼进接口路径（`/containers/{id}/start`），必须挡住 `/`、空白与 `..`；
 * 首字符限定字母或数字，同时也就排除了 `..`
 * 注 2：**刻意不允许 `/`** —— 镜像名可以带 registry 前缀（`registry.lan:5000/foo`），
 * 前端一律提交列表里的短 ID（Docker 支持前缀匹配），不要提交名字
 * 注 3：允许 `:`（镜像 tag）与 `@`（digest），它们不改变路径层级
 */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/** 资源清单入参 */
export class DockerObjectIndexDto {
  /** 宿主机ID */
  @IsInt({ message: '实例ID必须是整数！' })
  @Min(1, { message: '实例ID必须大于 0！' })
  dockerId!: number;

  /** 资源类型，注：白名单校验，值会决定路径模板与列表接口 */
  @IsIn(DOCKER_OBJECT_TYPES, { message: '资源类型不正确！' })
  type!: DockerObjectType;
}

/** 资源详情入参 */
export class DockerObjectShowDto extends DockerObjectIndexDto {
  /** 资源ID */
  @Matches(ID_PATTERN, { message: '资源ID格式不正确！' })
  id!: string;
}

/**
 * 资源动作入参
 *
 * 注 1：`force` / `timeout` 平铺成字段而不是 `Record<string, unknown>` —— 后者等于把参数
 * 透传给 daemon，本模块刻意不提供这种能力
 * 注 2：`action` 只校验并集，具体类型是否支持由服务层按 `DOCKER_OBJECT_ACTIONS` 判定
 */
export class DockerObjectActionDto extends DockerObjectShowDto {
  /** 动作 */
  @IsIn(DOCKER_ACTION_NAMES, { message: '不支持的操作！' })
  action!: DockerAction;

  /** 删除时是否强制，注：默认 false，前端必须显式确认 */
  @IsOptional()
  @IsBoolean({ message: '强制删除开关格式不正确！' })
  force?: boolean;

  /** 停止 / 重启前的等待秒数 */
  @IsOptional()
  @IsInt({ message: '等待时间必须是整数！' })
  @Min(0, { message: '等待时间不能小于 0！' })
  @Max(600, { message: '等待时间不能超过 600 秒！' })
  timeout?: number;
}

/**
 * `since` 的合法格式
 *
 * 注 1：Docker 接受 Unix 时间戳（秒）与 RFC3339 两种写法；这里必须校验 ——
 * 它会被拼进查询串，放任任意字符等于开了个注入点（虽然只到 daemon 的查询解析）
 * 注 2：**空串合法** —— 前端未指定起始时刻时会带空串，`@IsOptional` 只跳过
 * `undefined` / `null`，空串仍会走本规则
 */
const SINCE_PATTERN =
  /^(?:\d{1,19}|\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?$/;

/**
 * 日志查询入参
 *
 * 注 1：**刻意不继承 `DockerObjectShowDto`** —— 后者带了 `type`（资源类型）且是必填，
 * 而日志只对容器有意义；继承会让前端漏传 `type` 时直接 400
 * 注 2：`tail` 上限 5000 —— daemon 接受 `all`，但那等于把日志文件整份读进 api 内存
 * 注 3：`tail=0` 合法（跟随新日志时表示不要历史）
 * 注 4：`timestamps` 缺省为真：前端要靠行首时间戳做 `since` 去重，关掉会让重连重复补行
 */
export class DockerLogsDto {
  /** 宿主机ID */
  @IsInt({ message: '实例ID必须是整数！' })
  @Min(1, { message: '实例ID必须大于 0！' })
  dockerId!: number;

  /** 容器ID */
  @Matches(ID_PATTERN, { message: '资源ID格式不正确！' })
  id!: string;

  /** 拉取的历史行数 */
  @IsOptional()
  @IsInt({ message: '日志行数必须是整数！' })
  @Min(0, { message: '日志行数不能小于 0！' })
  @Max(DOCKER_LOG_TAIL_MAX, {
    message: `日志行数不能超过 ${DOCKER_LOG_TAIL_MAX}！`,
  })
  tail?: number;

  /** 起始时刻（RFC3339 或 Unix 秒） */
  @IsOptional()
  @Matches(SINCE_PATTERN, { message: '起始时间格式不正确！' })
  since?: string;

  /** 行首是否带时间戳 */
  @IsOptional()
  @IsBoolean({ message: '时间戳开关格式不正确！' })
  timestamps?: boolean;
}
