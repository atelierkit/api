// 外部依赖
import { IsBoolean, IsInt, IsNotEmpty } from 'class-validator';

/** 角色修改DTO */
export class RoleUpdateDto {
  /** id */
  @IsNotEmpty({ message: 'id不能为空！' })
  id!: string;

  /** 名称 */
  @IsNotEmpty({ message: '名称不能为空！' })
  name!: string;

  /** 描述 */
  @IsNotEmpty({ message: '描述不能为空！' })
  description!: string;

  /**
   * 启用状态，true表示启用，false表示禁用
   *
   * 注：不能用 `@IsNotEmpty()` —— 它对 `false` 判空，禁用角色会被误拒
   */
  @IsBoolean({ message: '状态格式不正确！' })
  status!: boolean;
}

/** 角色排序DTO */
export class RoleSortDto {
  /** id */
  @IsNotEmpty({ message: 'id不能为空！' })
  id!: string;

  /** 排序号，注：0 是合法取值（表默认值），故用 `@IsInt()` 而不是 `@IsNotEmpty()` */
  @IsInt({ message: '排序号必须为整数！' })
  sort!: number;
}
