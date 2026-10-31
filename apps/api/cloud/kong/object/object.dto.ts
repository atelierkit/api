// 外部依赖
import { IsIn, IsInt, IsObject, Matches, Min } from 'class-validator';
// 内部依赖
import type { KongObjectType } from './object.types.js';
import { KONG_OBJECT_TYPES } from './object.types.js';

/**
 * 对象ID / 名称的合法字符
 *
 * 注：`id` 会原样拼进 Admin API 的路径（`/{type}/{id}`），所以必须挡住 `/`、空白与 `..`
 * 这类能改变目标路径的字符；首字符限定字母或数字，同时也就排除了 `..`。
 * Kong 的 ID 是 UUID，按 name 操作时常见取值是字母数字加 `-` `_` `.` `~` `:`
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:-]{0,191}$/;

/** 对象清单入参 */
export class KongObjectIndexDto {
  /** 站点ID */
  @IsInt({ message: '实例ID必须是整数！' })
  @Min(1, { message: '实例ID必须大于 0！' })
  kongId!: number;

  /** 对象类型，注：白名单校验，值会拼进 Admin API 路径 */
  @IsIn(KONG_OBJECT_TYPES, { message: '对象类型不正确！' })
  type!: KongObjectType;
}

/**
 * 对象详情 / 删除入参
 *
 * 注：删除只需要站点、类型与对象ID，与详情完全一致，故复用同一个 DTO
 */
export class KongObjectShowDto extends KongObjectIndexDto {
  /** 对象ID（Kong 也接受 name） */
  @Matches(ID_PATTERN, { message: '对象ID格式不正确！' })
  id!: string;
}

/** 创建对象入参 */
export class KongObjectCreateDto extends KongObjectIndexDto {
  /** 对象数据，注：字段由 Kong 自行校验，后端只保证是个对象 */
  @IsObject({ message: '对象信息必须是对象！' })
  value!: Record<string, unknown>;
}

/** 更新对象入参 */
export class KongObjectUpdateDto extends KongObjectShowDto {
  /** 对象数据，注：Kong 用 PATCH，未提交的字段保持原值 */
  @IsObject({ message: '对象信息必须是对象！' })
  value!: Record<string, unknown>;
}
