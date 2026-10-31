// 外部依赖
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
// 内部依赖
import { SharedModule } from '@shared';
import { KeyController } from './key/key.controller.js';
import { KeyEntity, KeyLogEntity } from './key/key.entity.js';
import { KeyService } from './key/key.service.js';
import { KongController } from './kong/kong.controller.js';
import { KongEntity, KongLogEntity } from './kong/kong.entity.js';
import { KongService } from './kong/kong.service.js';

/**
 * 云服务模块
 *
 * 注：自旧私有项目 `marbleqi/api` 的 `src/cloud`（密钥）与 `src/kong`（站点）合并迁入，
 * 两者在页面上同属「云服务」一个导航区，故收在同一个模块里；全部接口用 `@Allow('admin')` 声明
 * 所需角色，鉴权由全局 `TokenGuard` 完成。旧项目里按云厂商（tencent / aliyun）分的业务模块不迁移
 */
@Module({
  imports: [
    SharedModule,
    TypeOrmModule.forFeature([
      KeyEntity,
      KeyLogEntity,
      KongEntity,
      KongLogEntity,
    ]),
  ],
  providers: [KeyService, KongService],
  controllers: [KeyController, KongController],
  exports: [KeyService, KongService],
})
export class CloudModule {}
