import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';

async function bootstrap() {
  // 后台常驻服务：不监听 HTTP 端口，用于定时任务、队列消费等长时运行任务。
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();

  const logger = new Logger('Worker');
  logger.log('后台常驻服务已启动（无 HTTP 端口）');
}

await bootstrap();
