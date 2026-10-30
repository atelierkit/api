// 外部依赖
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { timingSafeEqual } from 'crypto';
// 内部依赖
import { RetryAfterException } from '../common/retry-after.exception.js';
import { RedisService } from '../redis/redis.service.js';
import { SettingEntity } from '../setting/setting.entity.js';
import { hashPassword } from '../user/password.util.js';
import { UserEntity } from '../user/user.entity.js';
import { UserService } from '../user/user.service.js';
import { SETUP_CACHE_KEY, SETUP_SETTING_CODE } from './setup.constant.js';
import { SetupDto } from './setup.dto.js';

/** 初始化防护凭据的环境变量名 */
const SETUP_TOKEN_KEY = 'SETUP_TOKEN';

/** 单 IP 每分钟初始化请求上限 */
const SETUP_LIMIT_PER_MINUTE = 5;

/** 写入初始化标记的 SQL，注：ON CONFLICT 是并发下的唯一闸门 */
const INIT_SQL = `
INSERT INTO settings (code, value, status,
                      create_user_id, create_at,
                      update_user_id, update_operate, update_operate_id, update_req_id, update_at)
VALUES ($1, $2::json, true, 0, $3, 0, 'setup', 0, $4, $3)
ON CONFLICT (code) DO NOTHING
RETURNING code`;

/**
 * 系统初始化服务
 *
 * 系统是否已初始化，用 settings 表中一次性写入的 `init` 标记判定，**不用「用户表是否为空」**：
 * 后者会留下接管漏洞（管理员被误删 ⇒ 系统自动回到未初始化 ⇒ 任何人都能重新建成管理员）
 */
@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);
  /**
   * 构造函数
   *
   * @param dataSource 数据源，注：初始化需要把「标记 + 管理员」放进同一事务
   * @param settingRepository 配置存储器
   * @param redisSrv 缓存服务
   * @param userSrv 用户服务
   */
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(SettingEntity)
    private readonly settingRepository: Repository<SettingEntity>,
    private readonly redisSrv: RedisService,
    private readonly userSrv: UserService,
  ) {}

  /**
   * 是否已完成初始化
   *
   * 注：只缓存正向结果（已初始化），未初始化只存在于极短窗口，缓存它反而会拖慢首次初始化
   *
   * @returns 初始化完成标记
   */
  async ready(): Promise<boolean> {
    /** 缓存标记 */
    const cached = await this.redisSrv.get(SETUP_CACHE_KEY);
    if (cached === '1') {
      return true;
    }
    /** 库中标记 */
    const exists = await this.settingRepository.existsBy({
      code: SETUP_SETTING_CODE,
    });
    if (exists) {
      await this.redisSrv.set(SETUP_CACHE_KEY, '1');
      return true;
    }
    return false;
  }

  /**
   * 初始化管理员账号
   *
   * @param value 管理员账号信息
   * @param token 请求头中的初始化凭据
   * @param peerIp 直连对端地址，注：必须取 socket 地址，不能用 X-Forwarded-For
   * @param ip 客户端IP，注：仅用于限流键
   * @param reqId 请求日志ID
   * @returns 令牌信息，注：初始化成功即完成登录
   */
  async setup(
    value: SetupDto,
    token: string = '',
    peerIp: string = '',
    ip: string = '',
    reqId: number = 0,
  ) {
    // 先判已初始化，重复调用直接失败，不泄漏凭据对错
    if (await this.ready()) {
      throw new ConflictException('系统已完成初始化，无法重复创建管理员！');
    }
    // 防护闸门：防止服务刚暴露到公网就被他人抢先建号
    this.assertGate(token, peerIp);
    // IP 级限流
    await this.limitByIp(ip || peerIp, 'setup', SETUP_LIMIT_PER_MINUTE);
    /** 归一化并校验用户名 */
    const username = this.userSrv.checkUsername(value.username);
    // 密码策略校验
    this.userSrv.checkPassword(value.password, username);
    /** 归一化邮箱 */
    const email = this.userSrv.toEmail(value.email);
    /** 密码哈希，注：scrypt 约 50-100ms，放在事务外算，避免长时间占用事务 */
    const password = await hashPassword(value.password);
    /** 初始化时间 */
    const at = Date.now();
    /** 管理员用户ID */
    const adminId = await this.dataSource.transaction(async (manager) => {
      /** 写入结果 */
      const raw = await manager.query(INIT_SQL, [
        SETUP_SETTING_CODE,
        JSON.stringify({ at, username, version: 1 }),
        at,
        reqId,
      ]);
      // 注：INSERT ... RETURNING 返回行数组，但统一按「可能被包一层」归一化，避免形态假设出错
      const rows: unknown[] =
        Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw;
      if (!rows.length) {
        // 并发中被抢先：settings.code 是主键，只有一个请求能拿到 RETURNING 行
        throw new ConflictException('系统已完成初始化，无法重复创建管理员！');
      }
      /** 管理员用户 */
      const result = await manager.getRepository(UserEntity).insert({
        username,
        password,
        passwordAt: at,
        email,
        name: (value.name ?? '').trim() || username,
        avatar: (value.avatar ?? '').trim(),
        roles: ['admin'],
        status: true,
        create: { userId: 0, at },
        update: { userId: 0, operate: 'setup', operateId: 0, reqId, at },
      });
      return Number(result.identifiers[0].id);
    });
    // 回填缓存，注：失败不影响初始化结果，下次 ready() 会回查数据库
    await this.redisSrv.set(SETUP_CACHE_KEY, '1');
    this.logger.log(`系统已完成初始化，管理员：${username}`);
    // 初始化成功即签发令牌，前端不需要再走一次登录
    return this.userSrv.issueToken(adminId, 'setup', reqId, ip || peerIp);
  }

  /**
   * 初始化防护闸门
   *
   * 注：配置了 SETUP_TOKEN 则必须校验请求头（主闸门，反代部署下唯一可靠的方式）；
   * 未配置则退化为「只接受回环/内网来源」，服务本机直连首次启动的便利路径
   *
   * @param token 请求头中的初始化凭据
   * @param peerIp 直连对端地址
   * @throws ForbiddenException 校验不通过时抛出
   */
  private assertGate(token: string, peerIp: string) {
    /** 期望的凭据 */
    const expected = (process.env[SETUP_TOKEN_KEY] ?? '').trim();
    if (expected) {
      /** 实际凭据 */
      const actual = (token ?? '').trim();
      /** 期望凭据字节 */
      const expectBuf = Buffer.from(expected);
      /** 实际凭据字节 */
      const actualBuf = Buffer.from(actual);
      if (
        expectBuf.length !== actualBuf.length ||
        !timingSafeEqual(expectBuf, actualBuf)
      ) {
        throw new ForbiddenException('初始化凭据无效或来源不被允许！');
      }
      return;
    }
    if (!this.isPrivateAddress(peerIp)) {
      throw new ForbiddenException('初始化凭据无效或来源不被允许！');
    }
  }

  /**
   * 判断是否回环/内网地址
   *
   * @param ip 直连对端地址
   * @returns 判断结果
   */
  private isPrivateAddress(ip: string): boolean {
    // IPv4-mapped IPv6 归一（::ffff:127.0.0.1）
    const address = (ip ?? '').replace(/^::ffff:/i, '');
    if (!address) {
      return false;
    }
    if (address === '::1' || address === '127.0.0.1') {
      return true;
    }
    if (address.startsWith('127.') || address.startsWith('10.')) {
      return true;
    }
    if (address.startsWith('192.168.')) {
      return true;
    }
    /** 172.16.0.0/12 网段 */
    const match = /^172\.(\d{1,3})\./.exec(address);
    if (match) {
      const second = Number(match[1]);
      if (second >= 16 && second <= 31) {
        return true;
      }
    }
    // IPv6 唯一本地地址 fc00::/7 与链路本地 fe80::/10
    if (/^f[cd][0-9a-f]{2}:/i.test(address) || /^fe[89ab][0-9a-f]:/i.test(address)) {
      return true;
    }
    return false;
  }

  /**
   * IP 级请求频控
   *
   * @param ip 客户端IP
   * @param action 动作标识
   * @param max 每分钟最大次数
   */
  private async limitByIp(ip: string, action: string, max: number) {
    if (!ip) {
      return;
    }
    /** 频控键 */
    const key = `limit:ip:${action}:${ip}`;
    /** 已请求次数 */
    const count = await this.redisSrv.incr(key);
    if (count === 1) {
      await this.redisSrv.expire(key, 60);
    }
    if (count > max) {
      /** 剩余限流秒数 */
      const ttl = (await this.redisSrv.ttl(key)) || 60;
      throw new RetryAfterException(`请求过于频繁，请${ttl}秒后再试！`, ttl);
    }
  }
}
