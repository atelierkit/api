// 外部依赖
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
// 内部依赖
import { STATIC_URL_PREFIX } from '@shared/storage/storage.constant.js';
import { storageRoot } from '@shared/storage/storage.util.js';
import { AppModule } from './app.module.js';

/** 启动函数 */
async function bootstrap() {
  /** 应用 */
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // 信任反向代理（让 Express 正确解析 X-Forwarded-For 获取真实客户端 IP）
  app.set('trust proxy', 1);
  // 开启全局跨域许可
  app.enableCors({ origin: true });
  // 激活终止信号侦听器（Redis 连接、串行队列等资源依赖它优雅关闭）
  app.enableShutdownHooks();
  // 设置 JSON 解析器的限制（1 GiB，供大报文与文件上传使用）
  app.useBodyParser('json', { limit: 1073741824 });
  // 运行时上传的静态资源（当前只有头像）：
  // 1) 不经过全局 `TokenGuard` —— `<img>` 无法携带令牌头，只能靠 UUID 文件名不可猜测兜底；
  // 2) 目录由 `UPLOAD_DIR` 指定，容器部署时必须指向挂载卷，否则重建容器即丢文件；
  // 3) `nosniff` 是最后一道防线：万一上传目录混进脚本文件，也不让浏览器按 HTML 执行。
  app.useStaticAssets(storageRoot(), {
    prefix: STATIC_URL_PREFIX,
    maxAge: '365d',
    immutable: true,
    index: false,
    dotfiles: 'deny',
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  });
  // 启动监听（默认 80；80 属特权端口，非 root 直接运行时需 CAP_NET_BIND_SERVICE，
  // 或改用 PORT 覆盖成 1024 以上的端口）
  await app.listen(process.env.PORT ?? 80);
}
await bootstrap();
