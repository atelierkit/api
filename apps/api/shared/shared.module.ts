// 外部依赖
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
// 内部依赖
import { EmailService } from './email/email.service.js';
import { DbMonitorService } from './monitor/monitor.service.js';
import { OperateEntity } from './operate/operate.entity.js';
import { OperateService } from './operate/operate.service.js';
import { PassportController } from './passport/passport.controller.js';
import { QueueService } from './queue/queue.service.js';
import { RedisService } from './redis/redis.service.js';
import { ReqEntity } from './req/req.entity.js';
import { ReqService } from './req/req.service.js';
import { RoleEntity, RoleLogEntity } from './role/role.entity.js';
import { RoleService } from './role/role.service.js';
import { SettingController } from './setting/setting.controller.js';
import { SettingEntity, SettingLogEntity } from './setting/setting.entity.js';
import { SettingService } from './setting/setting.service.js';
import { SetupService } from './setup/setup.service.js';
import { ShortcutController } from './shortcut/shortcut.controller.js';
import { TokenService } from './token/token.service.js';
import { UserController } from './user/user.controller.js';
import { UserEntity, UserLogEntity } from './user/user.entity.js';
import { UserGateway } from './user/user.gateway.js';
import { UserService } from './user/user.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OperateEntity,
      ReqEntity,
      SettingEntity,
      SettingLogEntity,
      RoleEntity,
      RoleLogEntity,
      UserEntity,
      UserLogEntity,
    ]),
  ],
  providers: [
    RedisService,
    OperateService,
    EmailService,
    ReqService,
    SettingService,
    QueueService,
    UserService,
    TokenService,
    RoleService,
    SetupService,
    UserGateway,
    DbMonitorService,
  ],
  controllers: [
    PassportController,
    UserController,
    ShortcutController,
    SettingController,
  ],
  exports: [
    RedisService,
    OperateService,
    EmailService,
    ReqService,
    SettingService,
    QueueService,
    RoleService,
    UserService,
    TokenService,
    SetupService,
  ],
})
export class SharedModule {}
