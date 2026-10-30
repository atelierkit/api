// 外部依赖
import { Injectable, UnauthorizedException } from '@nestjs/common';
// 内部依赖
import { random } from '../common/common.util.js';
import { RedisService } from '../redis/redis.service.js';

/**
 * 令牌服务
 *
 * 令牌属于经常被使用，而且修改频繁的对象
 * 后端采用Redis存储的方式（以支持多后端实例同时运行的情况）
 */
@Injectable()
export class TokenService {
  /**
   * 构造函数
   *
   * @param redisSrv 共享缓存服务
   */
  constructor(private readonly redisSrv: RedisService) {}

  /**
   * 获取令牌清单
   *
   * @returns 令牌清单
   */
  async index() {
    /** 令牌清单，注：采用 scan 游标遍历，避免 keys 命令阻塞缓存服务 */
    const tokens = await this.redisSrv.scanKeys('token:*');
    /** 令牌数组 */
    const result: Record<string, string>[] = [];
    for (const item of tokens) {
      /** 令牌 */
      const token = await this.redisSrv.hgetall(item);
      result.push(token);
    }
    return result;
  }

  /**
   * 获取令牌数量
   *
   * @returns 令牌数量
   */
  async count() {
    /** 令牌清单，注：采用 scan 游标遍历，避免 keys 命令阻塞缓存服务 */
    const tokens = await this.redisSrv.scanKeys('token:*');
    return tokens.length;
  }

  /**
   * 获取令牌详情
   *
   * @param token 令牌
   * @returns 令牌详情
   */
  async show(token: string) {
    return this.redisSrv.hgetall(`token:${token}`);
  }

  /**
   * 刷新令牌，旧令牌换新令牌
   *
   * 注：有效期由调用方（用户服务）按用户设置提供，客户端不可指定
   *
   * @param id 待换令牌的用户ID
   * @param oldToken 原令牌
   * @param valid 有效期（单位：分钟），注：0 表示长期有效
   * @returns 新令牌信息
   */
  async refresh(id: number, oldToken: string, valid: number) {
    /** 过期时间，注：长期有效时同步记为 0 */
    const expired = valid ? Date.now() + valid * 60000 : 0;
    /** 新令牌 */
    let newToken: string;
    /** 新令牌存在标记 */
    let exists: number;
    do {
      newToken = random(60);
      exists = await this.redisSrv.exists(`token:${id}:${newToken}`);
    } while (exists);
    /** 新令牌键 */
    const newKey = `token:${id}:${newToken}`;
    /** 更换令牌键值 */
    const result: number = await this.redisSrv.renamenx(
      `token:${oldToken}`,
      newKey,
    );
    // 令牌更新失败，注：原令牌不存在或已过期时 renamenx 返回 0
    if (!result) {
      throw new UnauthorizedException(`令牌更新失败！`);
    }
    // 更新缓存部分字段
    await this.redisSrv.hmset(
      newKey,
      'code',
      newToken,
      'valid',
      valid,
      'expired',
      expired,
      'updateAt',
      Date.now(),
    );
    // 应用新的令牌有效期
    await this.applyValid(newKey, valid);
    // 返回新的令牌信息
    return this.redisSrv.hgetall(newKey);
  }

  /**
   * 应用令牌有效期
   *
   * 注：有效期外额外保留 5 分钟缓冲，避免业务有效期刚到点令牌即被缓存清理，
   * 导致前端来不及完成令牌刷新
   *
   * @param key 令牌键
   * @param valid 有效期（单位：分钟），注：0 表示长期有效
   */
  private async applyValid(key: string, valid: number) {
    if (valid) {
      await this.redisSrv.pexpireat(key, Date.now() + valid * 60000 + 300000);
    } else {
      // 长期有效：清除令牌键的过期时间，使其不随缓存自动失效
      await this.redisSrv.persist(key);
    }
  }

  /**
   * 令牌作废
   *
   * @param token 待作废的令牌
   * @returns 响应报文
   */
  async destroy(token: string) {
    return this.redisSrv.del(`token:${token}`);
  }
}
