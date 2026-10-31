// 外部依赖
import {
  Injectable,
  HttpException,
  HttpStatus,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsSelect, MoreThan, InsertResult } from 'typeorm';
import { Subject } from 'rxjs';
// 内部依赖
import { CreateEntity, UpdateEntity } from '../common/common.entity.js';
import { CommonService } from '../common/common.service.js';
import { random } from '../common/common.util.js';
import { RetryAfterException } from '../common/retry-after.exception.js';
import { Email } from '../email/email.interface.js';
import { EmailService } from '../email/email.service.js';
import { OperateService } from '../operate/operate.service.js';
import { QueueService } from '../queue/queue.service.js';
import { RedisService } from '../redis/redis.service.js';
import { TOKEN_VALIDS, TOKEN_VALID_DEFAULT } from '../token/token.constant.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.util.js';
import {
  CHECK_LIMIT_PER_MINUTE,
  LOGIN_FAIL_MAX,
  LOGIN_FAIL_TTL,
  LOGIN_LOCK_TTL,
  LOGIN_LIMIT_PER_MINUTE,
  PASSWORD_MAX,
  PASSWORD_MIN,
  RESET_FAIL_MAX,
  RESET_VALID_MINUTES,
  USERNAME_MAX,
  USERNAME_MIN,
  USERNAME_RE,
  USER_MAX,
} from './user.constant.js';
import {
  LoginDto,
  PasswordDto,
  RegisterDto,
  ResetDto,
  UserManageCreateDto,
  UserManageUpdateDto,
} from './user.dto.js';
import { UserEntity, UserLogEntity } from './user.entity.js';

/** 用户服务 */
@Injectable()
export class UserService extends CommonService<UserEntity, UserLogEntity> {
  protected name = 'user';
  /** 授权结果订阅 */
  result: Subject<Record<string, string>>;
  /**
   * 构造函数
   *
   * @param redisSrv 缓存服务
   * @param emailSrv 邮件服务
   * @param operateSrv 操作序号服务
   * @param queueSrv 队列服务
   * @param userRepository 用户存储器
   * @param userLogRepository 用户日志存储器
   */
  constructor(
    private readonly redisSrv: RedisService,
    private readonly emailSrv: EmailService,
    protected readonly operateSrv: OperateService,
    protected readonly queueSrv: QueueService,
    @InjectRepository(UserEntity)
    protected readonly userRepository: Repository<UserEntity>,
    @InjectRepository(UserLogEntity)
    protected readonly userLogRepository: Repository<UserLogEntity>,
  ) {
    super(operateSrv, queueSrv, userRepository, userLogRepository);
    this.result = new Subject<Record<string, string>>();
  }

  /**
   * 获取用户清单（管理员管理页面）
   *
   * @param operateId 操作序号，用于获取增量数据
   * @returns 用户清单
   */
  async index(operateId: number = -1) {
    return this.userRepository.find({
      select: {
        id: true,
        username: true,
        name: true,
        avatar: true,
        email: true,
        status: true,
        roles: true,
        create: { userId: true, at: true },
        update: {
          userId: true,
          at: true,
          operateId: true,
          operate: true,
          reqId: true,
        },
      } as FindOptionsSelect<UserEntity>,
      where: {
        update: { operateId: MoreThan(operateId) },
      },
    });
  }

  /**
   * 创建用户（管理端）
   *
   * 注：覆盖基类实现 —— 用户名需先归一化、密码需先哈希，否则明文入库且该账号永远登录不上；
   * 自助注册走 `register()`，两者的差别在于入口与开关，落库字段保持一致
   *
   * @param value 用户创建信息
   * @param userId 操作用户ID
   * @param reqId 请求日志ID
   * @returns 新用户ID
   * @throws BadRequestException 用户名或密码不符合规则时抛出
   * @throws ConflictException 用户名/邮箱已占用或用户数已达上限时抛出
   */
  async create(
    value: UserManageCreateDto,
    userId: number = 0,
    reqId: number = 0,
  ) {
    /** 归一化并校验用户名 */
    const username = this.checkUsername(value.username);
    // 密码策略校验
    this.checkPassword(value.password, username);
    /** 归一化邮箱，注：空串转 NULL，否则第二个不填邮箱的用户会撞唯一索引 */
    const email = this.toEmail(value.email);
    /** 用户名存在标记 */
    if (await this.userRepository.existsBy({ username })) {
      throw new ConflictException(`用户名${username}已被占用！`);
    }
    // 邮箱为可选资料，填了才校验唯一性
    if (email && (await this.userRepository.existsBy({ email }))) {
      throw new ConflictException(`邮箱${email}已被使用！`);
    }
    /** 当前用户数 */
    const count = await this.userRepository.count();
    if (count >= USER_MAX) {
      throw new ConflictException(
        `当前系统限制最大用户数为${USER_MAX}，无法继续创建！`,
      );
    }
    /** 密码哈希，注：scrypt 约 50-100ms */
    const password = await hashPassword(value.password);
    return super.create(
      {
        username,
        password,
        passwordAt: Date.now(),
        email,
        name: (value.name ?? '').trim() || username,
        avatar: (value.avatar ?? '').trim(),
        roles: value.roles ?? [],
        status: value.status ?? true,
      },
      userId,
      reqId,
    );
  }

  /**
   * 更新用户（管理端）
   *
   * 注：覆盖基类实现 —— 邮箱需归一化后落库（空串转 NULL，避免撞唯一索引）；
   * 只处理提交了的字段，未提交的字段保持原值
   *
   * @param id 用户ID
   * @param value 用户更新信息
   * @param userId 操作用户ID
   * @param reqId 请求日志ID
   * @returns 用户ID
   * @throws NotFoundException 用户不存在时抛出
   * @throws ConflictException 邮箱被其他用户占用时抛出
   */
  async update(
    id: number,
    value: UserManageUpdateDto,
    userId: number = 0,
    reqId: number = 0,
  ) {
    /** 用户，注：需要邮箱原值判断「是否真的换了邮箱」 */
    const user = await this.show(id, 'status');
    if (!user) {
      throw new NotFoundException(`当前用户不存在！`);
    }
    /** 归一化邮箱 */
    const email = this.toEmail(value.email);
    // 邮箱被其他用户占用时提前拦截，注：自己沿用原邮箱不算冲突
    if (email && email !== user.email) {
      /** 邮箱存在标记 */
      const exist = await this.userRepository.existsBy({ email });
      if (exist) {
        throw new ConflictException(`邮箱${email}已被使用！`);
      }
    }
    return super.update(
      id,
      {
        ...(value.name === undefined ? {} : { name: value.name.trim() }),
        ...(value.avatar === undefined ? {} : { avatar: value.avatar.trim() }),
        ...(value.email === undefined ? {} : { email }),
        ...(value.status === undefined ? {} : { status: value.status }),
        ...(value.roles === undefined ? {} : { roles: value.roles }),
      },
      userId,
      reqId,
    );
  }

  /**
   * 获取用户信息
   *
   * 注：根据不同的type参数，返回不同的用户信息字段
   *
   * @param id 用户ID
   * @param type 数据结果类型
   * @returns 用户详情
   */
  async show(id: number, type: 'startup' | 'status' | 'login' | 'all' = 'all') {
    /** 返回字段 */
    let select: FindOptionsSelect<UserEntity>;
    if (type === 'startup') {
      select = {
        id: true,
        username: true,
        name: true,
        avatar: true,
        email: true,
        roles: true,
        tokenValid: true,
      } as FindOptionsSelect<UserEntity>;
    } else if (type === 'status') {
      select = {
        id: true,
        username: true,
        email: true,
        status: true,
        roles: true,
      } as FindOptionsSelect<UserEntity>;
    } else if (type === 'login') {
      select = {
        id: true,
        username: true,
        email: true,
        status: true,
        roles: true,
        loginTimes: true,
        firstLoginAt: true,
        tokenValid: true,
      } as FindOptionsSelect<UserEntity>;
    } else {
      select = {
        id: true,
        username: true,
        name: true,
        avatar: true,
        email: true,
        status: true,
        roles: true,
        tokenValid: true,
        loginTimes: true,
        firstLoginAt: true,
        lastLoginIp: true,
        lastLoginAt: true,
        lastSessionAt: true,
        create: { userId: true, at: true },
        update: {
          userId: true,
          at: true,
          operateId: true,
          operate: true,
          reqId: true,
        },
      } as FindOptionsSelect<UserEntity>;
    }
    return this.userRepository.findOne({
      select,
      where: { id },
    });
  }

  /**
   * 获取用户的登录令牌有效期
   *
   * 注：以用户自身设置为准，历史数据或非法值统一回退到默认档位
   *
   * @param id 用户ID
   * @returns 令牌有效期（单位：分钟），注：0 表示长期有效
   * @throws NotFoundException 用户不存在时抛出
   */
  async valid(id: number) {
    /** 用户 */
    const user = await this.userRepository.findOne({
      select: { id: true, tokenValid: true } as FindOptionsSelect<UserEntity>,
      where: { id },
    });
    if (!user) {
      throw new NotFoundException(`当前用户不存在！`);
    }
    // 白名单兜底，兼容历史数据与异常值
    return this.normalizeValid(user.tokenValid);
  }

  /**
   * 归一化令牌有效期
   *
   * @param valid 原始有效期（单位：分钟）
   * @returns 白名单内的有效期，注：非法值回退到默认档位
   */
  private normalizeValid(valid: number): number {
    return TOKEN_VALIDS.includes(valid) ? valid : TOKEN_VALID_DEFAULT;
  }

  /**
   * 设置用户的登录令牌有效期
   *
   * 注：设置值作为该用户后续登录签发与令牌续期的默认值
   *
   * @param id 用户ID
   * @param valid 令牌有效期（单位：分钟），注：0 表示长期有效
   * @param reqId 请求日志ID
   * @returns 设置后的令牌有效期
   * @throws BadRequestException 有效期不在可选档位内时抛出
   */
  async setValid(id: number, valid: number, reqId: number = 0) {
    // 档位白名单校验，防止写入非法时长
    if (!TOKEN_VALIDS.includes(valid)) {
      throw new BadRequestException(`令牌有效期不合法！`);
    }
    /** 用户 */
    const user = await this.show(id, 'status');
    if (!user) {
      throw new NotFoundException(`当前用户不存在！`);
    }
    /** 创建操作序号 */
    const operateId = await this.operateSrv.create('user', 'valid', id);
    /** 设置时间 */
    const at = Date.now();
    // 更新用户的令牌有效期
    const result = await this.userRepository.update(id, {
      tokenValid: valid,
      update: { userId: id, operate: 'valid', operateId, reqId, at },
    });
    if (result.affected) {
      // 追加日志
      this.addLog(operateId);
      return valid;
    }
    throw new UnprocessableEntityException(`令牌有效期设置失败！`);
  }

  /**
   * 用户名归一化
   *
   * 注：去除首尾空格并转小写，保证同一用户名的不同书写形式命中同一账号与频控键
   *
   * @param username 原始用户名
   * @returns 归一化用户名
   */
  normalizeUsername(username: string): string {
    return (username ?? '').trim().toLowerCase();
  }

  /**
   * 校验并归一化用户名
   *
   * @param username 原始用户名
   * @returns 归一化后的用户名
   * @throws BadRequestException 不符合规则时抛出
   */
  checkUsername(username: string): string {
    /** 归一化用户名 */
    const name = this.normalizeUsername(username);
    if (!USERNAME_RE.test(name)) {
      throw new BadRequestException(
        `用户名需为${USERNAME_MIN}-${USERNAME_MAX}位小写字母、数字、下划线或短横线！`,
      );
    }
    return name;
  }

  /**
   * 校验密码复杂度
   *
   * @param password 明文密码
   * @param username 关联用户名，注：密码不允许与用户名相同
   * @throws BadRequestException 不符合规则时抛出
   */
  checkPassword(password: string, username: string = ''): void {
    if (
      !password ||
      password.length < PASSWORD_MIN ||
      password.length > PASSWORD_MAX
    ) {
      throw new BadRequestException(
        `密码长度需为${PASSWORD_MIN}-${PASSWORD_MAX}位！`,
      );
    }
    // 必须同时包含字母与数字，不强制大小写与符号，避免个人工具自己都记不住
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      throw new BadRequestException(`密码必须同时包含字母和数字！`);
    }
    if (username && password.toLowerCase() === username.toLowerCase()) {
      throw new BadRequestException(`密码不能与用户名相同！`);
    }
  }

  /**
   * 邮箱归一化
   *
   * 注：去除首尾空格并转小写，保证同一邮箱的不同书写形式命中同一账号与频控键
   *
   * @param email 原始邮箱
   * @returns 归一化邮箱
   */
  private normalizeEmail(email: string): string {
    return (email ?? '').trim().toLowerCase();
  }

  /**
   * 邮箱落库归一化
   *
   * 注：空串统一转 NULL —— users.email 上有唯一索引，多个空串会互相冲突（NULL 之间不冲突）
   *
   * @param email 原始邮箱
   * @returns 归一化邮箱或 null
   */
  toEmail(email?: string | null): string | null {
    /** 归一化邮箱 */
    const mail = this.normalizeEmail(email ?? '');
    return mail || null;
  }

  /**
   * IP 级请求频控
   *
   * @param ip 客户端IP
   * @param action 动作标识
   * @param max 每分钟最大次数，默认 3 次
   */
  private async limitByIp(ip: string, action: string, max: number = 3) {
    if (!ip) {
      return;
    }
    /** 频控键 */
    const key = `limit:ip:${action}:${ip}`;
    /** 已请求次数 */
    const count = await this.redisSrv.incr(key);
    if (count === 1) {
      // 首次请求时设置计数有效期
      await this.redisSrv.expire(key, 60);
    }
    if (count > max) {
      /** 剩余限流秒数 */
      const ttl = (await this.redisSrv.ttl(key)) || 60;
      throw new RetryAfterException(`请求过于频繁，请${ttl}秒后再试！`, ttl);
    }
  }

  /**
   * 清理用户令牌
   *
   * @param userId 用户ID
   * @param keep 需要保留的令牌，注：形如 `<用户ID>:<随机码>`，改密时用于保留当前会话
   * @returns 清理的令牌数
   */
  private async purgeTokens(
    userId: number,
    keep: string = '',
  ): Promise<number> {
    /** 该用户全部令牌键，注：采用 scan 游标遍历，避免 keys 命令阻塞缓存服务 */
    const keys = await this.redisSrv.scanKeys(`token:${userId}:*`);
    /** 待删除令牌键 */
    const targets = keep ? keys.filter((key) => key !== `token:${keep}`) : keys;
    if (!targets.length) {
      return 0;
    }
    // 以管道批量清理，避免逐条串行等待
    const pipeline = this.redisSrv.pipeline();
    targets.forEach((key) => pipeline.del(key));
    await pipeline.exec();
    return targets.length;
  }

  /**
   * 归一化登录IP
   *
   * 注：只放行 IPv4 与简化 IPv6，其余（空串、带端口、转发链脏值）一律丢弃，
   * 避免把非法值写进 inet 列导致更新直接 500
   *
   * @param ip 原始IP
   * @returns 可落库的IP，非法时为空串
   */
  private toIp(ip: string): string {
    /** 去空白后的IP */
    const value = (ip ?? '').trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
      return value;
    }
    if (value.includes(':') && /^[0-9a-f:.]{3,45}$/i.test(value)) {
      return value;
    }
    return '';
  }

  /**
   * 签发登录令牌
   *
   * 注：登录成功后统一走这里 —— 清旧令牌、写登录统计、记操作日志、签发新令牌，
   * 首次初始化与密码登录共用同一套语义
   *
   * @param userId 用户ID
   * @param operate 操作类型，注：login 或 setup
   * @param reqId 请求日志ID
   * @param ip 客户端IP
   * @returns 令牌信息
   */
  async issueToken(
    userId: number,
    operate: string,
    reqId: number = 0,
    ip: string = '',
  ) {
    /** 用户 */
    const user = await this.userRepository.findOne({
      select: {
        id: true,
        username: true,
        status: true,
        tokenValid: true,
        loginTimes: true,
        firstLoginAt: true,
      } as FindOptionsSelect<UserEntity>,
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException(`当前用户不存在！`);
    }
    if (!user.status) {
      throw new ForbiddenException('用户已被禁用！');
    }
    // 清理该用户的全部旧令牌（单会话策略）
    await this.purgeTokens(user.id);
    /** 创建操作序号 */
    const operateId = await this.operateSrv.create('user', operate, user.id);
    /** 是否首次登录 */
    const first = !user.firstLoginAt;
    /** 登录时间 */
    const at = Date.now();
    /** 最后登录IP */
    const lastIp = this.toIp(ip);
    // 更新用户的登录统计信息
    const result = await this.userRepository.update(user.id, {
      ...(lastIp ? { lastLoginIp: lastIp } : {}),
      loginTimes: first ? 1 : user.loginTimes + 1,
      firstLoginAt: first ? at : user.firstLoginAt,
      lastLoginAt: at,
      lastSessionAt: at,
      update: {
        userId: user.id,
        operate,
        operateId,
        reqId,
        at,
      },
    });
    if (!result.affected) {
      throw new UnprocessableEntityException(`登录状态更新失败！`);
    }
    // 追加日志
    this.addLog(operateId);
    // 按用户设置的有效期签发令牌，注：0 表示长期有效
    const valid = this.normalizeValid(user.tokenValid);
    return this.redisSrv.addCode(`token:${user.id}`, 60, valid, {
      id: user.id,
      valid,
    });
  }

  /**
   * 用户名查重
   *
   * 注：仅供注册/初始化页面使用，只返回是否存在，不暴露账号状态
   *
   * @param username 用户名
   * @param ip 客户端IP
   * @returns 查重结果
   */
  async check(username: string, ip: string = '') {
    // IP 级限流，防止被用来批量探测用户名
    await this.limitByIp(ip, 'check', CHECK_LIMIT_PER_MINUTE);
    /** 归一化用户名 */
    const name = this.normalizeUsername(username);
    if (!name) {
      return { exists: false };
    }
    return { exists: await this.userRepository.existsBy({ username: name }) };
  }

  /**
   * 用户名密码登录
   *
   * 注：失败一律返回「用户名或密码不正确」，账号不存在时也跑一次等价耗时的假校验，
   * 避免通过文案或响应时间探测账号是否存在
   *
   * @param value 登录信息
   * @param reqId 请求日志ID
   * @param ip 客户端IP
   * @returns 令牌信息
   */
  async login(value: LoginDto, reqId: number = 0, ip: string = '') {
    // IP 级限流，防止撞库
    await this.limitByIp(ip, 'login', LOGIN_LIMIT_PER_MINUTE);
    /** 归一化用户名 */
    const username = this.normalizeUsername(value.username);
    /** 账号锁定键 */
    const lockKey = `loginLock:${username}`;
    /** 锁定剩余秒数 */
    const lockTtl: number = await this.redisSrv.ttl(lockKey);
    if (lockTtl > 0) {
      throw new RetryAfterException(
        `密码错误次数过多，请${lockTtl}秒后再试！`,
        lockTtl,
      );
    }
    /** 用户，注：password 列 select:false，需显式指定 */
    const user = await this.userRepository.findOne({
      select: {
        id: true,
        username: true,
        password: true,
        status: true,
      },
      where: { username },
    });
    if (!user) {
      // 账号不存在：跑一次等价耗时的假校验，让两种失败不可区分
      await verifyPassword(value.password, DUMMY_HASH);
      throw new UnauthorizedException('用户名或密码不正确！');
    }
    if (!user.status) {
      throw new ForbiddenException('用户已被禁用！');
    }
    // 老数据（迁移前只有邮箱、没有密码）引导到重置流程，而不是直接判密码错
    if (!user.password) {
      throw new ConflictException('该账号尚未设置密码，请先通过邮箱重置密码！');
    }
    /** 密码校验结果 */
    const ok = await verifyPassword(value.password, user.password);
    if (!ok) {
      /** 失败计数键 */
      const failKey = `loginFail:${username}`;
      /** 连续失败次数 */
      const fails = await this.redisSrv.incr(failKey);
      if (fails === 1) {
        await this.redisSrv.expire(failKey, LOGIN_FAIL_TTL);
      }
      if (fails >= LOGIN_FAIL_MAX) {
        // 达到上限：锁账号一段时间，并清掉计数（锁到期后可重新尝试）
        await this.redisSrv.set(lockKey, '1', 'EX', LOGIN_LOCK_TTL);
        await this.redisSrv.del(failKey);
        throw new RetryAfterException(
          `密码错误次数过多，请${LOGIN_LOCK_TTL}秒后再试！`,
          LOGIN_LOCK_TTL,
        );
      }
      throw new UnauthorizedException('用户名或密码不正确！');
    }
    // 登录成功，清空失败计数
    await this.redisSrv.del(`loginFail:${username}`);
    return this.issueToken(user.id, 'login', reqId, ip);
  }

  /**
   * 修改密码（登录态）
   *
   * 注：保留当前令牌、作废该用户的其它令牌，避免改密把自己踢下线
   *
   * @param id 用户ID
   * @param value 改密信息
   * @param token 当前令牌，注：形如 `<用户ID>:<随机码>`
   * @param reqId 请求日志ID
   * @returns 响应报文
   */
  async password(
    id: number,
    value: PasswordDto,
    token: string = '',
    reqId: number = 0,
  ) {
    /** 用户，注：password 列 select:false，需显式指定 */
    const user = await this.userRepository.findOne({
      select: { id: true, username: true, password: true, status: true },
      where: { id },
    });
    if (!user) {
      throw new NotFoundException(`当前用户不存在！`);
    }
    if (!user.status) {
      throw new ForbiddenException('用户已被禁用！');
    }
    if (!user.password) {
      throw new ConflictException('该账号尚未设置密码，请先通过邮箱重置密码！');
    }
    // 先校验原密码，避免攻击者拿登录态直接改密
    if (!(await verifyPassword(value.oldPassword, user.password))) {
      throw new UnauthorizedException('原密码不正确！');
    }
    if (value.oldPassword === value.newPassword) {
      throw new BadRequestException('新密码不能与原密码相同！');
    }
    // 新密码策略校验
    this.checkPassword(value.newPassword, user.username);
    /** 新密码哈希 */
    const password = await hashPassword(value.newPassword);
    /** 创建操作序号 */
    const operateId = await this.operateSrv.create('user', 'password', id);
    /** 修改时间 */
    const at = Date.now();
    // 更新密码与修改时间
    const result = await this.userRepository.update(id, {
      password,
      passwordAt: at,
      update: { userId: id, operate: 'password', operateId, reqId, at },
    });
    if (!result.affected) {
      throw new UnprocessableEntityException(`密码修改失败！`);
    }
    // 追加日志
    this.addLog(operateId);
    // 保留当前会话，作废其它会话
    const purged = await this.purgeTokens(id, token);
    return {
      code: 0,
      msg: purged
        ? `密码修改成功，已退出${purged}个其它会话！`
        : `密码修改成功！`,
    };
  }

  /**
   * 发送重置密码验证码
   *
   * 注：邮箱不存在或账号被禁用时同样返回统一文案且不发送邮件，避免被用来探测账号
   *
   * @param email 邮箱
   * @param ip 客户端IP
   * @returns 响应报文
   */
  async sendResetCode(email: string, ip: string = '') {
    /** 归一化邮箱 */
    const mail = this.normalizeEmail(email);
    // IP 级限流，防止对多个邮箱并发轰炸邮件
    await this.limitByIp(ip, 'reset');
    /** 邮箱频控键 */
    const limitKey = `limit:reset:${mail}`;
    /** 频控标记，注：1分钟内同一邮箱只允许发送一次 */
    const locked = await this.redisSrv.set(limitKey, '1', 'EX', 60, 'NX');
    if (!locked) {
      /** 剩余限流秒数 */
      const retryAfter = (await this.redisSrv.ttl(limitKey)) || 60;
      throw new RetryAfterException(
        `验证码发送过于频繁，请${retryAfter}秒后再试！`,
        retryAfter,
      );
    }
    /** 统一文案 */
    const msg = `如果该邮箱已绑定账号，验证码已发送，有效期${RESET_VALID_MINUTES}分钟，请及时使用！`;
    /** 用户 */
    const user = await this.userRepository.findOne({
      select: { id: true, email: true, status: true },
      where: { email: mail },
    });
    if (!user || !user.status) {
      return { code: 0, msg };
    }
    /** 验证码 */
    const captcha = random(6, 'number');
    /** 缓存键，注：以邮箱为键，避免再维护一层序列码映射 */
    const key = `reset:${mail}`;
    /** 当前时间 */
    const at = Date.now();
    /** 业务过期时间 */
    const expired = at + RESET_VALID_MINUTES * 60000;
    // 缓存验证码与失败计数
    await this.redisSrv.hmset(key, {
      id: user.id,
      email: mail,
      captcha,
      fails: 0,
      expired,
      createAt: at,
      updateAt: at,
    });
    // 业务有效期外额外留 30 秒缓冲，避免前端刚拿到就过期
    await this.redisSrv.pexpireat(key, expired + 30000);
    /** 邮件内容 */
    const mailBody: Email = {
      to: mail,
      subject: '个人量化工具的重置密码验证码',
      html: `<p>个人量化工具的重置密码验证码</p><p>验证码：<b>${captcha}</b></p><p>该验证码有效期只有${RESET_VALID_MINUTES}分钟，请及时使用！</p>`,
    };
    // 发送邮件
    await this.emailSrv.send(mailBody);
    return { code: 0, msg };
  }

  /**
   * 通过邮箱验证码重置密码
   *
   * @param value 重置信息
   * @param reqId 请求日志ID
   * @returns 响应报文
   */
  async reset(value: ResetDto, reqId: number = 0) {
    /** 归一化邮箱 */
    const mail = this.normalizeEmail(value.email);
    /** 缓存键 */
    const key = `reset:${mail}`;
    /** 缓存数据 */
    const cache: Record<string, string> = await this.redisSrv.hgetall(key);
    if (!cache || !cache.id) {
      throw new BadRequestException('验证码已失效或已过期，请重新获取！');
    }
    // 业务有效期校验，注：hgetall 返回全 string，需显式转换为数字比较
    if (Number(cache.expired) < Date.now()) {
      await this.redisSrv.del(key);
      throw new BadRequestException('验证码已失效或已过期，请重新获取！');
    }
    if (String(cache.captcha) !== String(value.code ?? '').trim()) {
      /** 连续失败次数 */
      const fails = await this.redisSrv.hincrby(key, 'fails', 1);
      if (fails >= RESET_FAIL_MAX) {
        // 失败次数超限，销毁该验证码，防止被暴力破解
        await this.redisSrv.del(key);
        throw new HttpException(
          '验证码错误次数过多，请重新获取验证码！',
          HttpStatus.GONE,
        );
      }
      throw new BadRequestException('验证码不正确！');
    }
    /** 用户 */
    const user = await this.userRepository.findOne({
      select: { id: true, username: true, status: true },
      where: { id: Number(cache.id) },
    });
    if (!user) {
      throw new NotFoundException('用户还未注册！');
    }
    if (!user.status) {
      throw new ForbiddenException('用户已被禁用！');
    }
    // 新密码策略校验
    this.checkPassword(value.password, user.username);
    /** 新密码哈希 */
    const password = await hashPassword(value.password);
    /** 创建操作序号 */
    const operateId = await this.operateSrv.create('user', 'reset', user.id);
    /** 重置时间 */
    const at = Date.now();
    // 更新密码与修改时间
    const result = await this.userRepository.update(user.id, {
      password,
      passwordAt: at,
      update: { userId: user.id, operate: 'reset', operateId, reqId, at },
    });
    if (!result.affected) {
      throw new UnprocessableEntityException(`密码重置失败！`);
    }
    // 追加日志
    this.addLog(operateId);
    // 删除验证码缓存并作废该用户的全部令牌
    await this.redisSrv.del(key);
    await this.purgeTokens(user.id);
    return { code: 0, msg: `密码已重置，请使用新密码登录！` };
  }

  /**
   * 用户注册
   *
   * 注：默认关闭（ALLOW_SIGNUP !== 'true' 时返回 410），账号由管理员或初始化流程创建
   *
   * @param value 用户注册信息
   * @param reqId 请求日志ID
   * @param ip 客户端IP
   * @returns 用户ID
   */
  async register(value: RegisterDto, reqId: number = 0, ip: string = '') {
    // 自助注册开关，默认关闭
    if (process.env.ALLOW_SIGNUP !== 'true') {
      throw new HttpException('系统已关闭自助注册！', HttpStatus.GONE);
    }
    // IP 级限流，防止注册接口被刷
    await this.limitByIp(ip, 'register');
    /** 归一化并校验用户名 */
    const username = this.checkUsername(value.username);
    // 密码策略校验
    this.checkPassword(value.password, username);
    /** 归一化邮箱 */
    const email = this.toEmail(value.email);
    // 邮箱唯一性校验，注：邮箱为可选资料，未填时跳过
    if (email) {
      /** 邮箱存在标记 */
      const existMail = await this.userRepository.existsBy({ email });
      if (existMail) {
        throw new ConflictException(`邮箱${email}已被注册！`);
      }
    }
    /** 用户名存在标记 */
    const exist = await this.userRepository.existsBy({ username });
    if (exist) {
      throw new ConflictException(`用户名${username}已被占用！`);
    }
    /** 当前用户数 */
    const count = await this.userRepository.count();
    if (count >= USER_MAX) {
      throw new ConflictException(
        `当前系统限制最大用户数为${USER_MAX}，已关闭注册！`,
      );
    }
    /** 密码哈希 */
    const password = await hashPassword(value.password);
    /** 创建操作序号 */
    const operateId = await this.operateSrv.create('user', 'register', 0);
    /** 注册时间 */
    const at = Date.now();
    /** 用户数据 */
    const data: Partial<UserEntity> = {
      username,
      password,
      passwordAt: at,
      email,
      name: (value.name ?? '').trim() || username,
      avatar: (value.avatar ?? '').trim(),
      roles: [],
      status: true,
      create: { userId: 0, at } as CreateEntity,
      update: {
        userId: 0,
        operate: 'register',
        operateId,
        reqId,
        at,
      } as UpdateEntity,
    };
    /** 操作结果 */
    let result: InsertResult;
    try {
      result = await this.userRepository.insert(data);
    } catch (error) {
      // 并发注册时唯一索引冲突（PostgreSQL 23505），转为 409 而非 500
      const code =
        (error as { code?: string; driverError?: { code?: string } })?.code ??
        (error as { driverError?: { code?: string } })?.driverError?.code;
      if (code === '23505') {
        throw new ConflictException(`用户名${username}或邮箱已被占用！`);
      }
      throw error;
    }
    if (result.identifiers.length) {
      // 追加日志
      this.addLog(operateId);
      return Number(result.identifiers[0].id);
    }
    throw new UnprocessableEntityException(`用户${username}注册失败！`);
  }

  /**
   * 修改登录邮箱
   *
   * @param id 用户ID
   * @param email 新邮箱
   * @param ip 客户端IP
   * @returns 激活用户ID
   */
  async email(id: number, email: string, ip: string = '') {
    // IP 级限流，防止激活邮件被刷
    await this.limitByIp(ip, 'email');
    /** 用户 */
    const user = await this.show(id, 'status');
    if (!user) {
      throw new NotFoundException(`当前用户不存在！`);
    }
    // 邮箱归一化，与登录/注册保持一致
    email = this.normalizeEmail(email);
    if (email === (user.email ?? '')) {
      throw new UnprocessableEntityException(`邮箱并未发生变化，无需修改！`);
    }
    /** 用户存在标记 */
    const exist = await this.userRepository.existsBy({ email });
    // 邮箱被其他用户使用
    if (exist) {
      throw new ConflictException(`邮箱${email}已被使用，无法修改！`);
    }
    /** 缓存信息 */
    const cache: object = { id, email };
    /** 随机码消息 */
    const code = await this.redisSrv.addCode('activate', 100, 30, cache);
    /** 激活链接 */
    const url = `${process.env.WEB_URL}passport/activate/${code.code}`;
    /** 邮件内容 */
    const mail: Email = {
      to: email, // 收件人邮箱
      subject: '个人量化工具的修改邮箱验证邮件', // 邮件主题
      html: `<p>请点击该<a href="${url}" target="_blank">新邮箱激活链接</a>。</p>
      <p>或将以下地址复制到浏览器地址栏中打开：</p>
      <p>${url}</p>`, // HTML内容（可选）
    };
    // 发送邮件
    await this.emailSrv.send(mail);
    return id;
  }

  /**
   * 激活新邮箱
   *
   * @param code 激活码
   * @returns 激活用户ID
   */
  async activate(code: string, reqId: number = 0) {
    /** 缓存数据 */
    const cache: Record<string, string> = await this.redisSrv.hgetall(
      `activate:${code}`,
    );
    if (!cache || !cache.email) {
      throw new NotFoundException('激活地址已过期！');
    }
    /** 用户ID */
    const id = Number(cache.id);
    /** 用户 */
    const user = await this.userRepository.findOne({
      select: {
        id: true,
        email: true,
        status: true,
        roles: true,
      } as FindOptionsSelect<UserEntity>,
      where: { id },
    });
    if (!user) {
      throw new NotFoundException('用户还未注册！');
    }
    if (!user.status) {
      throw new UnauthorizedException('用户已被禁用！');
    }
    /** 检查结果 */
    const exists = await this.userRepository.existsBy({ email: cache.email });
    if (exists) {
      throw new ConflictException(`邮箱${cache.email}已被使用，无法修改！`);
    }
    /** 创建操作序号 */
    const operateId = await this.operateSrv.create('user', 'email', id);
    // 更新用户信息
    const result = await this.userRepository.update(id, {
      email: cache.email,
      update: {
        userId: id,
        operate: 'chgemail',
        operateId,
        reqId,
        at: Date.now(),
      },
    });
    if (result.affected) {
      // 追加日志
      this.addLog(operateId);
      // 删除激活随机码缓存
      await this.redisSrv.del(`activate:${code}`);
      return {
        code: 0,
        msg: `用户绑定邮箱已成功修改为${cache.email}，可返回首页登录！`,
      };
    }
    throw new UnprocessableEntityException(
      `用户新邮箱${cache.email}激活失败！`,
    );
  }

  /**
   * 修改用户的最后会话时间
   *
   * @param id 用户ID
   */
  async session(id: number) {
    await this.userRepository.update(id, { lastSessionAt: Date.now() });
  }
}
