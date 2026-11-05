// 外部依赖
import type { ValidationPipeOptions } from '@nestjs/common';

/**
 * 全局校验管道的统一配置（`app.module.ts` 的 `APP_PIPE` 用它，`app.pipe.spec.ts` 断言它）
 *
 * ⚠️ **`transform: true` 不是「顺手打开」**：`@Query()` 里的值全是字符串
 * （`?page=1` 到 DTO 里是 `'1'`），而 class-validator 的 `@IsInt()` 只认 number，
 * 于是「前端带 `page` / `size` 的请求恒 400，报 `page must be an integer number`」。
 * 所有 `@Query()` 的数值参数都依赖这一条，改回只开 `whitelist` 会让查询类接口整片变红。
 *
 * ⚠️ 刻意**不**开 `enableImplicitConversion`：它按反射类型隐式转换，`Boolean('false')`
 * 得到 `true` —— 所有 `@IsBoolean()` 字段（`status` / `allowInsecure` / `verify` 等）
 * 提交 `"false"` 会被静默改成开启。故数值字段一律在 DTO 上用 `@Transform` 显式转
 * （见 `data/query.dto.ts` 的 `toNumberOrUndefined`），别改回隐式转换。
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  transform: true,
};
