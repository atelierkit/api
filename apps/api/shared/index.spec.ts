// 外部依赖
import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
// 内部依赖
import * as shared from './index.js';

describe('shared/index', () => {
  it('桶文件可被整体导入，且不触发 ESM 循环依赖（TDZ 会直接抛错）', () => {
    expect(shared.SharedModule).toBeDefined();
    expect(shared.UserService).toBeDefined();
  });

  it('对外导出的关键符号齐全（模块外的代码只通过 @shared 引用）', () => {
    for (const key of [
      'SharedModule',
      'UserService',
      'TokenService',
      'TokenGuard',
      'SetupService',
      'SetupGuard',
      'ReqService',
      'ReqInterceptor',
      'RetryAfterException',
      'RetryAfterFilter',
      'DbErrorFilter',
      'OperatePipe',
      'UserController',
      'PassportController',
      'CommonService',
      'OptionService',
      'hashPassword',
      'random',
      'maskData',
    ]) {
      expect(shared, `缺少导出：${key}`).toHaveProperty(key);
    }
  });

  it('SharedModule 带有 Nest 模块元数据', () => {
    /** 模块导入列表 */
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      shared.SharedModule,
    );
    expect(Array.isArray(imports)).toBe(true);
    expect(imports.length).toBeGreaterThan(0);
  });
});
