// 外部依赖
import { Allow, IsNotEmpty } from 'class-validator';

/**
 * 系统配置DTO
 *
 * 注 1：全局 `ValidationPipe` 开启了 `whitelist`，本DTO一旦有字段带校验装饰器，
 * 其余未装饰的字段就会被剥离，因此所有字段都必须保留装饰器，参数无需校验时使用 `@Allow()`
 * 注 2：`code` 是主键，创建与更新都要带上 —— 更新时 `OptionService.update` 会拿它判断是否需要改主键
 */
export class SettingDto {
  /** 配置编码 */
  @IsNotEmpty({ message: '配置编码不能为空' })
  code!: string;

  /** 启用状态，true表示启用，false表示禁用 */
  @Allow()
  status?: boolean;

  /** 配置值 */
  @Allow()
  value?: any;
}
