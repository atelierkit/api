// 外部依赖
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
// 内部依赖
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
  // 启动监听
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
