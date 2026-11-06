// 外部依赖
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
// 内部依赖
import { SharedModule } from '@shared';
import { CloudModule } from '../cloud/cloud.module.js';
import { ApiService } from './api/api.service.js';
import { AliyunContactEntity, AliyunContactLogEntity } from './contact/contact.entity.js';
import { ContactController } from './contact/contact.controller.js';
import { ContactService } from './contact/contact.service.js';
import { SslController } from './ssl/ssl.controller.js';
import { SslService } from './ssl/ssl.service.js';

/**
 * 阿里云模块
 *
 * 注 1：接口前缀统一为 `aliyun/`，全部用 `@Allow('admin')` 声明所需角色（鉴权由全局 `TokenGuard` 完成）
 * 注 2：依赖 `CloudModule` 的三项能力 —— `KeyService` 取访问密钥（Secret 只在服务端用）、
 * `KongService` / `ObjectService` 把证书部署到 KONG 站点
 * 注 3：`aliyun_contacts` 是本模块唯一的落库表（申请联系人备选），证书与订单全在阿里云侧，不落库
 * 注 4：不引入 `@nestjs/axios`，HTTP 请求用运行时自带的 `fetch`（见 `api/api.request.ts`）
 */
@Module({
  imports: [
    SharedModule,
    CloudModule,
    TypeOrmModule.forFeature([AliyunContactEntity, AliyunContactLogEntity]),
  ],
  controllers: [SslController, ContactController],
  providers: [ApiService, SslService, ContactService],
  exports: [ApiService, SslService, ContactService],
})
export class AliyunModule {}
