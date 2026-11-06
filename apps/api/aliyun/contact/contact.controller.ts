// 外部依赖
import { Controller } from '@nestjs/common';
// 内部依赖
import { Allow, CommonController } from '@shared';
import { ContactCreateDto, ContactUpdateDto } from './contact.dto.js';
import { ContactService } from './contact.service.js';

/**
 * 申请联系人控制器
 *
 * 注 1：增删改查（清单 / 数量 / 详情 / 变更日志 / 创建 / 更新）全部由 `CommonController` 基类提供
 * 注 2：手机号与邮箱下发明文（申请表单要回填），脱敏放在前端展示层 —— 后端不维护两套字段，
 * 两套字段一定会有一处忘记同步
 */
@Controller('aliyun/contact')
@Allow('admin')
export class ContactController extends CommonController<
  ContactService,
  ContactCreateDto,
  ContactUpdateDto
> {
  /**
   * 构造函数
   *
   * @param contactSrv 联系人服务
   */
  constructor(protected readonly contactSrv: ContactService) {
    super(contactSrv);
  }
}
