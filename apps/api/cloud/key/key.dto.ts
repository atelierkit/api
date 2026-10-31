// 外部依赖
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  MaxLength,
} from 'class-validator';
// 内部依赖
import { KEY_PROVIDERS } from './key.constant.js';
// 注：`emitDecoratorMetadata` + `isolatedModules` 下，装饰器签名里用到的类型必须走 `import type`
import type { KeyProvider } from './key.constant.js';

/** 创建云服务密钥DTO */
export class KeyCreateDto {
  /** 密钥名称 */
  @IsNotEmpty({ message: '密钥名称不能为空！' })
  @MaxLength(50, { message: '密钥名称不能超过 50 个字符！' })
  name!: string;

  /** 密钥说明 */
  @IsNotEmpty({ message: '密钥说明不能为空！' })
  @MaxLength(200, { message: '密钥说明不能超过 200 个字符！' })
  description!: string;

  /** 云服务商 */
  @IsIn(KEY_PROVIDERS, { message: '云服务商只能是 aws / aliyun / tencent！' })
  provider!: KeyProvider;

  /** 访问密钥 ID */
  @IsNotEmpty({ message: 'key 不能为空！' })
  key!: string;

  /** 访问密钥 Secret */
  @IsNotEmpty({ message: 'secret 不能为空！' })
  secret!: string;

  /**
   * 启用状态
   *
   * 注：不能用 `@IsNotEmpty()` —— 它对 `false` 判空，新建一个禁用密钥会被误拒
   */
  @IsBoolean({ message: '状态格式不正确！' })
  status!: boolean;
}

/**
 * 更新云服务密钥DTO
 *
 * 注：字段全部可选，前端按需只提交改动项；`secret` 缺省表示「保持原值」——
 * 详情接口不下发 secret，编辑时不回填、留空即不改
 */
export class KeyUpdateDto {
  /** 密钥名称 */
  @IsOptional()
  @IsNotEmpty({ message: '密钥名称不能为空！' })
  @MaxLength(50, { message: '密钥名称不能超过 50 个字符！' })
  name?: string;

  /** 密钥说明 */
  @IsOptional()
  @IsNotEmpty({ message: '密钥说明不能为空！' })
  @MaxLength(200, { message: '密钥说明不能超过 200 个字符！' })
  description?: string;

  /** 云服务商 */
  @IsOptional()
  @IsIn(KEY_PROVIDERS, { message: '云服务商只能是 aws / aliyun / tencent！' })
  provider?: KeyProvider;

  /** 访问密钥 ID */
  @IsOptional()
  @IsNotEmpty({ message: 'key 不能为空！' })
  key?: string;

  /** 访问密钥 Secret，注：缺省表示保持原值 */
  @IsOptional()
  @IsNotEmpty({ message: 'secret 不能为空！' })
  secret?: string;

  /** 启用状态 */
  @IsOptional()
  @IsBoolean({ message: '状态格式不正确！' })
  status?: boolean;
}
