import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';

async function bootstrap() {
  // 后台常驻服务：不监听 HTTP 端口，用于定时任务、队列消费等长时运行任务。
  // 日志级别与 api 同一口径（见 apps/api/log.options.ts）：保留 error / warn / log，
  // 让启动与依赖装载过程可见；debug / verbose 仍关闭，避免请求级追踪淹没故障
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();
}

await bootstrap();
