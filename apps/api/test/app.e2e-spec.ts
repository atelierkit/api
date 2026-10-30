import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../app.module.js';

/** 是否具备跑通 AppModule 所需的基础设施，注：AppModule 会连 PostgreSQL 与 Redis */
const hasInfra = Boolean(process.env.POSTGRES_HOST && process.env.REDIS_HOST);

// 注：缺少 env 时跳过，避免把「本机没配环境」误报成用例失败
describe.skipIf(!hasInfra)('AppModule (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  // 注：AppModule 目前没有业务控制器（脚手架自带的 AppController 已删除），
  // 因此根路径不存在，应返回 404；本用例的价值是证明「模块能装配、应用能初始化」。
  // 接入控制器后应改断言：未携带令牌的请求由全局 TokenGuard 拒绝（401）
  it('/ (GET) 无对应路由', () => {
    return request(app.getHttpServer()).get('/').expect(404);
  });

  afterEach(async () => {
    await app.close();
  });
});
