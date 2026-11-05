import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';

async function bootstrap() {
  // 后台常驻服务：不监听 HTTP 端口，用于定时任务、队列消费等长时运行任务。
  // 日志级别与 api 同一口径（见 apps/api/log.options.ts）：只留异常与告警，
  // 启动成功这类 info 输出不再刷屏，进程存活由容器状态判断
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn'],
  });
  app.enableShutdownHooks();
}

await bootstrap();
