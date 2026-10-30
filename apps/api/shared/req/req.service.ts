// 外部依赖
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
// 内部依赖
import { ReqIndexDto } from './req.dto.js';
import { ReqEntity } from './req.entity.js';
import { UserEntity } from '../user/user.entity.js';

/**
 * 请求日志查询结果项
 *
 * 注：排除实体的生命周期方法，查询结果经对象展开后不携带方法
 */
export type ReqItem = Omit<ReqEntity, 'reqLoad'> & {
  /** 请求用户邮箱 */
  email: string;
  /** 请求耗时（毫秒） */
  duration: number;
};

/** 默认查询时间窗：24 小时 */
const DEFAULT_RANGE = 24 * 60 * 60 * 1000;
/** 每页最大条数 */
const MAX_PAGE_SIZE = 100;
/** 每页默认条数 */
const DEFAULT_PAGE_SIZE = 20;

/** 请求日志服务 */
@Injectable()
export class ReqService {
  /**
   * 构造函数
   *
   * @param reqRepository 请求日志存储器
   * @param userRepository 用户存储器，用于补齐请求用户邮箱
   */
  constructor(
    @InjectRepository(ReqEntity)
    private readonly reqRepository: Repository<ReqEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  /**
   * 创建请求日志
   *
   * @param value 请求日志数据
   * @returns 请求日志ID
   */
  async insert(value: Partial<ReqEntity>) {
    const result = await this.reqRepository.insert(value);
    return result.identifiers.length;
  }

  /**
   * 获取请求路径列表
   *
   * 注：历史数据中存在带 query string 的记录，此处统一截取 query 之前的部分后去重，
   * 排序在内存中完成，避免 SELECT DISTINCT 与 ORDER BY 的表达式冲突
   *
   * @returns 去重并排序后的请求路径清单
   */
  async url() {
    /** 请求路径记录 */
    const list = await this.reqRepository
      .createQueryBuilder('req')
      .select("DISTINCT split_part(req.url, '?', 1)", 'url')
      .getRawMany<{ url: string }>();
    return list.map((item) => item.url).sort((a, b) => a.localeCompare(b));
  }

  /**
   * 获取控制器列表
   *
   * @returns 去重并排序后的控制器清单
   */
  async controller() {
    /** 控制器记录 */
    const list = await this.reqRepository
      .createQueryBuilder('req')
      .select('DISTINCT req.controller', 'controller')
      .getRawMany<{ controller: string }>();
    return list
      .map((item) => item.controller)
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * 获取方法列表
   *
   * @param controller 控制器名
   * @returns 去重并排序后的方法清单
   */
  async action(controller: string) {
    /** 方法记录 */
    const list = await this.reqRepository
      .createQueryBuilder('req')
      .select('DISTINCT req.action', 'action')
      .where('req.controller = :controller', { controller })
      .getRawMany<{ action: string }>();
    return list.map((item) => item.action).sort((a, b) => a.localeCompare(b));
  }

  /**
   * 分页搜索请求日志记录
   *
   * @param value 请求日志搜索条件
   * @param reqId 当前请求ID（排除正在执行的这条查询自身产生的日志）
   * @returns 请求日志清单与总条数
   */
  async index(value: ReqIndexDto, reqId = 0) {
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
    let query: SelectQueryBuilder<ReqEntity> = this.reqRepository
      .createQueryBuilder('req')
      .where('req.req_id != :reqId', { reqId })
      .andWhere('req.start_at BETWEEN :start AND :end', { start, end })
      .orderBy('req.start_at', 'DESC')
      .addOrderBy('req.req_id', 'DESC')
      .skip((pi - 1) * ps)
      .take(ps);
    // 搜索条件增加用户ID，注：userId 为 0 表示未登录请求，是有意义的筛选值，故不能用真值判断
    if (value.userId !== undefined && value.userId !== null) {
      query = query.andWhere('req.user_id = :userId', { userId: value.userId });
    }
    // 搜索条件增加请求路径，兼容历史数据中带 query string 的记录
    if (value.path) {
      query = query.andWhere('(req.url = :path OR req.url LIKE :pathLike)', {
        path: value.path,
        pathLike: `${value.path}?%`,
      });
    }
    // 搜索条件增加控制器
    if (value.controller) {
      query = query.andWhere('req.controller = :controller', {
        controller: value.controller,
      });
    }
    // 搜索条件增加方法
    if (value.action) {
      query = query.andWhere('req.action = :action', { action: value.action });
    }
    // 搜索条件增加结果：成功为 2xx，异常为非 2xx，精确状态码优先于结果
    if (value.status) {
      query = query.andWhere('req.status = :status', { status: value.status });
    } else if (value.success === true) {
      query = query.andWhere('req.status >= 200 AND req.status < 300');
    } else if (value.success === false) {
      query = query.andWhere('(req.status < 200 OR req.status >= 300)');
    }
    /** 请求日志清单与总条数 */
    const [list, total] = await query.getManyAndCount();
    return { total, data: await this.withUserInfo(list) };
  }

  /**
   * 获取日志详情
   *
   * @param reqId 日志ID
   * @returns 日志详情
   */
  async show(reqId: number) {
    /** 日志记录 */
    const record = await this.reqRepository.findOneBy({ reqId });
    if (!record) {
      return record;
    }
    /** 带用户邮箱与耗时的日志记录 */
    const [item] = await this.withUserInfo([record]);
    return item;
  }

  /**
   * 按用户ID批量补齐请求用户邮箱，并计算请求耗时
   *
   * 注：不使用 leftJoin 加 getRawMany 关联用户表，getRawMany 会绕过实体的加载回调
   * （AfterLoad），bigint 类型的 reqId、startAt 与 endAt 将以字符串返回，导致前端
   * 时间列与耗时列失效；此处改用批量 IN 查询后在内存中合并
   *
   * @param list 日志记录清单
   * @returns 带请求用户邮箱与耗时的日志记录清单
   */
  private async withUserInfo(list: ReqEntity[]): Promise<ReqItem[]> {
    /** 用户邮箱映射 */
    const emails = await this.emailMap(list.map((item) => item.userId));
    return list.map((item) => ({
      ...item,
      email: emails.get(item.userId) ?? '',
      duration: item.endAt && item.startAt ? item.endAt - item.startAt : 0,
    }));
  }

  /**
   * 获取请求用户字典
   *
   * 注：日志由框架层自动写入，请求用户取值来自日志表本身，用户ID为 0 表示未登录请求
   *
   * @returns 去重并排序后的请求用户清单
   */
  async user() {
    /** 请求用户ID记录 */
    const rows = await this.reqRepository
      .createQueryBuilder('req')
      .select('DISTINCT req.user_id', 'userId')
      .getRawMany<{ userId: number }>();
    /** 请求用户ID清单 */
    const userIds = rows
      .map((item) => Number(item.userId))
      .sort((a, b) => a - b);
    /** 用户邮箱映射 */
    const emails = await this.emailMap(userIds);
    return userIds.map((id) => ({
      value: id,
      label: emails.get(id) || (id ? `用户ID${id}` : '未登录'),
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
    /** 请求用户清单 */
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
