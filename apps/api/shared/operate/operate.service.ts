// 外部依赖
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
// 内部依赖
import { OperateIndexDto } from './operate.dto.js';
import { OperateEntity } from './operate.entity.js';
import { UserEntity } from '../user/user.entity.js';

/**
 * 操作日志查询结果项
 *
 * 注：排除实体的生命周期方法，查询结果经对象展开后不携带方法
 */
export type OperateItem = Omit<OperateEntity, 'operateLoad' | 'createAt'> & {
  /** 操作用户邮箱 */
  email: string;
};

/** 默认查询时间窗：24 小时 */
const DEFAULT_RANGE = 24 * 60 * 60 * 1000;
/** 每页最大条数 */
const MAX_PAGE_SIZE = 100;
/** 每页默认条数 */
const DEFAULT_PAGE_SIZE = 20;

/** 操作序号服务 */
@Injectable()
export class OperateService {
  /**
   * 构造函数
   *
   * @param operateRepository 操作序号存储器
   * @param userRepository 用户存储器，用于补齐操作用户邮箱
   */
  constructor(
    @InjectRepository(OperateEntity)
    private readonly operateRepository: Repository<OperateEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  /**
   * 分页获取操作记录
   *
   * @param value 查询条件
   * @returns 操作记录清单与总条数
   */
  async index(value: OperateIndexDto) {
    /** 截止时间 */
    const end = value.end ?? Date.now();
    /** 起始时间 */
    const start = value.start ?? end - DEFAULT_RANGE;
    /** 页码 */
    const pi = value.pi && value.pi > 0 ? value.pi : 1;
    /** 每页条数 */
    const ps =
      value.ps && value.ps > 0
        ? Math.min(value.ps, MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;

    /** 查询构造器 */
    let query = this.operateRepository
      .createQueryBuilder('operate')
      .where('operate.at BETWEEN :start AND :end', { start, end })
      .orderBy('operate.at', 'DESC')
      .addOrderBy('operate.id', 'DESC')
      .skip((pi - 1) * ps)
      .take(ps);
    // 搜索条件增加操作用户，注：userId 为 0 表示系统操作，是有意义的筛选值，故不能用真值判断
    if (value.userId !== undefined && value.userId !== null) {
      query = query.andWhere('operate.user_id = :userId', {
        userId: value.userId,
      });
    }
    // 搜索条件增加操作对象
    if (value.name) {
      query = query.andWhere('operate.name = :name', { name: value.name });
    }
    // 搜索条件增加操作类型
    if (value.operate) {
      query = query.andWhere('operate.operate = :operate', {
        operate: value.operate,
      });
    }
    /** 操作记录清单与总条数 */
    const [list, total] = await query.getManyAndCount();
    return { total, data: await this.withEmail(list) };
  }

  /**
   * 获取操作日志字典
   *
   * @returns 操作用户、操作对象与操作类型清单
   */
  async options() {
    /** 操作用户ID记录 */
    const userRows = await this.operateRepository
      .createQueryBuilder('operate')
      .select('DISTINCT operate.user_id', 'userId')
      .getRawMany<{ userId: number }>();
    /** 操作用户ID清单 */
    const userIds = userRows
      .map((item) => Number(item.userId))
      .sort((a, b) => a - b);
    /** 用户邮箱映射 */
    const emails = await this.emailMap(userIds);
    /** 操作对象记录 */
    const nameRows = await this.operateRepository
      .createQueryBuilder('operate')
      .select('DISTINCT operate.name', 'name')
      .orderBy('name', 'ASC')
      .getRawMany<{ name: string }>();
    /** 操作类型记录 */
    const operateRows = await this.operateRepository
      .createQueryBuilder('operate')
      .select('DISTINCT operate.operate', 'operate')
      .orderBy('operate', 'ASC')
      .getRawMany<{ operate: string }>();
    return {
      users: userIds.map((id) => ({
        value: id,
        label: emails.get(id) || (id ? `用户ID${id}` : '系统/未登录'),
      })),
      names: nameRows.map((item) => item.name),
      operates: operateRows.map((item) => item.operate),
    };
  }

  /**
   * 获取操作详情
   *
   * @param id 操作序号ID
   * @returns 操作序号详情
   */
  async show(id: number) {
    /** 操作记录 */
    const record = await this.operateRepository.findOneBy({ id });
    if (!record) {
      return record;
    }
    /** 带用户邮箱的操作记录 */
    const [item] = await this.withEmail([record]);
    return item;
  }

  /**
   * 获取新的操作序号
   *
   * @param name 操作对象
   * @param operate 操作类型
   * @param userId 操作用户ID
   * @param remark 操作备注
   * @returns 新的操作序号
   */
  async create(
    name: string,
    operate: string,
    userId: number = 0,
    remark: string = '',
  ) {
    const result = await this.operateRepository.insert({
      name,
      operate,
      userId,
      remark,
      at: Date.now(),
    });
    if (result.identifiers.length) {
      return Number(result.identifiers[0].id);
    }
    return 0;
  }

  /**
   * 按用户ID批量补齐操作用户邮箱
   *
   * 注：不使用 leftJoin 加 getRawMany 关联用户表取邮箱，getRawMany 会绕过实体的加载
   * 回调（AfterLoad），bigint 类型的 id 与 at 将以字符串返回，导致前端时间列失效；
   * 此处改用批量 IN 查询后在内存中合并
   *
   * @param list 操作记录清单
   * @returns 带操作用户邮箱的操作记录清单
   */
  private async withEmail(list: OperateEntity[]): Promise<OperateItem[]> {
    /** 用户邮箱映射 */
    const emails = await this.emailMap(list.map((item) => item.userId));
    return list.map((item) => ({
      ...item,
      email: emails.get(item.userId) ?? '',
    }));
  }

  /**
   * 按用户ID批量获取用户邮箱映射
   *
   * @param userIds 用户ID清单
   * @returns 用户ID到邮箱的映射，注：用户ID为 0 或用户不存在时不在映射中
   */
  private async emailMap(userIds: number[]): Promise<Map<number, string>> {
    /** 有效用户ID清单 */
    const ids = [...new Set(userIds.filter((id) => id > 0))];
    /** 用户邮箱映射 */
    const emails = new Map<number, string>();
    if (!ids.length) {
      return emails;
    }
    /** 用户清单 */
    const users = await this.userRepository.find({
      select: { id: true, email: true, username: true },
      where: { id: In(ids) },
    });
    for (const user of users) {
      // 注：邮箱为可选资料，未填时退回用户名，避免日志里没有用户标识
      emails.set(user.id, user.email ?? user.username);
    }
    return emails;
  }
}
