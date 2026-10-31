// 外部依赖
import { Controller } from '@nestjs/common';
// 内部依赖
import { Allow, CommonController } from '@shared';
import { KeyCreateDto, KeyUpdateDto } from './key.dto.js';
import { KeyService } from './key.service.js';

/**
 * 云服务密钥控制器
 *
 * 注：增删改查（清单 / 数量 / 详情 / 变更日志 / 创建 / 更新）全部由 `CommonController`
 * 基类提供；详情与清单都不含 `secret`，密钥 Secret 不经过 HTTP 往返
 */
@Controller('cloud/key')
@Allow('admin')
export class KeyController extends CommonController<
  KeyService,
  KeyCreateDto,
  KeyUpdateDto
> {
  /**
   * 构造函数
   *
   * @param keySrv 密钥服务
   */
  constructor(protected readonly keySrv: KeyService) {
    super(keySrv);
  }
}
