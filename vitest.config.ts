import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`. Requires Vite 8, which ships this option.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // 注：脚手架自带的 AppController 用例已随 AppController 一起删除，当前没有单元测试文件
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      // 注：不写 include 时 v8 只统计「被测试加载过的文件」，controllers / 装配层会直接消失，
      // 覆盖率会虚高十几个点，所以这里显式圈定口径。
      include: ['apps/api/**/*.ts'],
      exclude: [
        'apps/api/**/*.spec.ts',
        // e2e 用例本身不是被测代码，而且它需要真实 PG + Redis
        'apps/api/test/**',
      ],
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      // 门槛设在实际值下方约 2-3 个百分点：既防回退，又不会因为一处小改动就红。
      // 注：只有 `yarn test:cov` 会校验门槛，`yarn test` 与 pre-commit 钩子不跑覆盖率。
      thresholds: {
        statements: 88,
        branches: 83,
        functions: 88,
        lines: 89,
      },
    },
  },
});
