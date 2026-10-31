// 外部依赖
import { Logger, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
// 内部依赖
import {
  DbErrorFilter,
  ReqInterceptor,
  RetryAfterFilter,
  SetupGuard,
  SharedModule,
  TokenGuard,
} from '@shared';
import { AuthModule } from './auth/auth.module.js';

/** 主模块 */
@Module({
  imports: [
    ConfigModule.forRoot({
      // 开发/联调按 APP_PROFILE 加载 profile 文件，.env 作兜底
      envFilePath: [`.env.${process.env.APP_PROFILE}`, '.env'],
    }),
    TypeOrmModule.forRootAsync({
      useFactory: () => {
        /** 日志器 */
        const logger = new Logger(AppModule.name);
        logger.debug(`当前APP_PROFILE ${process.env.APP_PROFILE}`);
        logger.debug(`当前环境 ${process.env.NODE_ENV}`);
        /** 是否自动同步表结构，注：仅开发/演示环境开启 */
        const synchronize = process.env.NODE_ENV
          ? ['dev', 'demo'].includes(process.env.NODE_ENV)
          : false;
        if (!process.env.POSTGRES_HOST) {
          throw new Error('未配置数据库地址');
        }
        /** 数据库地址 */
        const host = process.env.POSTGRES_HOST;
        if (!process.env.POSTGRES_DB) {
          throw new Error('未配置数据库名');
        }
        /** 数据库端口 */
        const port = process.env.POSTGRES_PORT
          ? parseInt(process.env.POSTGRES_PORT, 10)
          : 5432;
        /** 数据库名 */
        const database = process.env.POSTGRES_DB;
        logger.debug(`当前数据库用户 ${process.env.POSTGRES_USER}`);
        if (!process.env.POSTGRES_USER) {
          throw new Error('未配置数据库用户');
        }
        /** 数据库用户 */
        const username = process.env.POSTGRES_USER;
        if (!process.env.POSTGRES_PSW) {
          throw new Error('未配置数据库密码');
        }
        /** 数据库密码 */
        const password = process.env.POSTGRES_PSW;
        return {
          type: 'postgres',
          host,
          port,
          database,
          username,
          password,
          synchronize,
          autoLoadEntities: true,
          // 注：数据库可能为跨网络访问，冷连接握手实测需数秒，空闲连接保留时间过短
          // 会导致每次打开页面都要重新建连（首个请求变慢甚至超出连接超时后失败）
          extra: {
            max: 20,
            idleTimeoutMillis: 300000,
            connectionTimeoutMillis: 30000,
            statement_timeout: 30000,
            keepAlive: true,
            keepAliveInitialDelayMillis: 5000,
          },
          logging: ['error'],
        };
      },
    }),
    SharedModule,
    AuthModule,
  ],
  providers: [
    // 注：全局守卫按注册顺序执行，初始化守卫必须排在令牌守卫之前
    { provide: APP_GUARD, useClass: SetupGuard },
    { provide: APP_GUARD, useClass: TokenGuard },
    { provide: APP_FILTER, useClass: RetryAfterFilter },
    { provide: APP_FILTER, useClass: DbErrorFilter },
    { provide: APP_INTERCEPTOR, useClass: ReqInterceptor },
    { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true }) },
  ],
})
export class AppModule {}
