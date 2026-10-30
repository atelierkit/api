// 外部依赖
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Redis } from 'ioredis';
// 内部依赖
import { random } from '../common/common.util.js';

/** 随机码缓存记录 */
export interface Code {
  /** 其他预留字段 */
  [key: string]: any;

  /** 随机码 */
  code: string;

  /** 类型 */
  type?: string;

  /** 创建时间 */
  createAt: number;

  /** 更新时间 */
  updateAt: number;

  /** 过期时间，注：0 表示长期有效 */
  expired: number;
}

/** 缓存服务（Redis） */
@Injectable()
export class RedisService extends Redis implements OnApplicationBootstrap {
  private readonly logger = new Logger(RedisService.name);
  /** 构造函数 */
  constructor() {
    // 进行配置参数验证
    if (!process.env.REDIS_HOST) {
      throw new Error('未配置缓存地址');
    }
    /** 缓存地址 */
    const host = process.env.REDIS_HOST;
    /** 缓存端口 */
    const port = process.env.REDIS_PORT
      ? parseInt(process.env.REDIS_PORT, 10)
      : 6379;
    /** 缓存数据库 */
    const db = process.env.REDIS_DB ? parseInt(process.env.REDIS_DB, 10) : 0;
    /** 缓存密码 */
    const password = process.env.REDIS_PSW || '';
    /** 缓存配置 */
    const options = { host, port, db, password };
    super(options);
    this.logger.debug('应用缓存已连接');
  }

  /**
   * 应用启动钩子
   * 当环境变量 REDIS_INIT 为 'true' 时，清空应用缓存与 Bull 队列缓存
   */
  async onApplicationBootstrap() {
    if (process.env.REDIS_INIT === 'true') {
      this.logger.debug('正在初始化缓存...');
      // 清空当前数据库的所有缓存记录
      await this.flushdb();
      /** 队列缓存数据库 */
      const bullDb = process.env.BULL_DB
        ? parseInt(process.env.BULL_DB, 10)
        : 1;
      /** 应用缓存数据库 */
      const db = process.env.REDIS_DB ? parseInt(process.env.REDIS_DB, 10) : 0;
      if (bullDb !== db) {
        // Bull 队列使用独立数据库，复制当前连接并切换后单独清空
        const bullClient = this.duplicate({ db: bullDb });
        await bullClient.flushdb();
        await bullClient.quit();
      }
      this.logger.debug('缓存初始化完成');
    }
  }

  /**
   * 创建随机码缓存记录
   *
   * @param prefix 随机码前缀
   * @param length 随机码长度
   * @param valid 有效期（单位：分钟），注：默认为0，表示永久有效
   * @param cache 附加信息
   */
  async addCode(
    prefix: string,
    length: number = 60,
    valid: number = 0,
    cache: object = {},
  ) {
    /** 随机码 */
    let code: string;
    /** 随机码已存在标记 */
    let exists: number;
    // 生成新的随机码，且确保该随机码不重复
    do {
      code = random(length);
      exists = await this.exists(`${prefix}:${code}`);
    } while (exists);
    const result: Code = {
      ...cache,
      code,
      // 有效期为 0 时表示长期有效，过期时间同步记为 0
      expired: valid ? Date.now() + valid * 60000 : 0,
      createAt: Date.now(),
      updateAt: Date.now(),
    };
    // 缓存随机码
    await this.hmset(`${prefix}:${code}`, result);
    if (valid) {
      // 设置随机码有效期，注：业务有效期外加 30 秒缓冲，避免与邮件/前端公示的有效期不符
      await this.pexpireat(`${prefix}:${code}`, result.expired + 30000);
    }
    // 返回随机码信息
    return result;
  }

  /**
   * 游标遍历匹配的缓存键
   *
   * 注：以 scan 分批遍历替代 keys 命令，避免阻塞缓存服务
   *
   * @param pattern 匹配模式
   * @param count 每批扫描数量，默认 100
   * @returns 匹配的缓存键清单
   */
  async scanKeys(pattern: string, count: number = 100) {
    /** 匹配的缓存键清单 */
    const keys: string[] = [];
    /** 扫描游标 */
    let cursor = '0';
    do {
      const [next, list] = await this.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        count,
      );
      cursor = next;
      keys.push(...list);
    } while (cursor !== '0');
    return keys;
  }
}
