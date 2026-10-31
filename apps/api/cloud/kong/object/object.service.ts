// 外部依赖
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
// 内部依赖
import { kongRequest } from '../kong.request.js';
import { KongService } from '../kong.service.js';
import { parseCertificate } from './certificate.util.js';
import type { KongObject, KongObjectType, KongPage } from './object.types.js';

/** 翻页上限，注：防止网关返回的 `offset` 恒不为空时死循环 */
const MAX_PAGES = 100;

/**
 * KONG 站点下的对象服务
 *
 * 注 1：Kong 各对象（路由 / 服务 / 用户 / 证书 / 插件 / 上游）在 Admin API 上是同一套 REST 形状
 * （`GET|POST /{type}`、`GET|PATCH|DELETE /{type}/{id}`），故一个服务管全部类型，不按类型拆
 * 注 2：与旧私有项目相比有两处刻意不同 —— 分页改用 `offset` 自行拼查询串（旧代码直接拼
 * `data.next`，而新版 Kong 给的 `next` 是完整 URL，拼出来会变成 `http://host:8001http://...`）；
 * 证书的域名与有效期改在后端解析（见 `certificate.util.ts`）
 */
@Injectable()
export class ObjectService {
  /**
   * 构造函数
   *
   * @param kongSrv 站点服务，注：用于把站点ID换成 Admin API 地址（站点不存在时抛 404）
   */
  constructor(private readonly kongSrv: KongService) {}

  /**
   * 获取对象清单（自动翻页取全量）
   *
   * @param kongId 站点ID
   * @param type 对象类型
   * @returns 对象清单
   */
  async index(kongId: number, type: KongObjectType): Promise<KongObject[]> {
    /** Admin API 地址 */
    const base = await this.kongSrv.url(kongId);
    /** 汇总结果 */
    const rows: KongObject[] = [];
    /** 下一页游标，空串表示已到末页 */
    let offset = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      /** 当前页请求路径，注：Kong 的分页参数是 `offset`，取上一页返回的游标 */
      const path: string =
        offset === ''
          ? `/${type}`
          : `/${type}?offset=${encodeURIComponent(offset)}`;
      /** 当前页响应 */
      const body: KongPage = await kongRequest<KongPage>(base, path);
      if (Array.isArray(body.data)) {
        rows.push(...body.data);
      }
      offset = typeof body.offset === 'string' ? body.offset : '';
      if (offset === '') {
        return rows.map((row) => this.enrich(type, row));
      }
    }
    // 注：翻到上限还没结束，说明分页本身有问题，宁可报错也不要静默返回半份数据
    throw new HttpException(
      `网关分页异常，已翻过 ${MAX_PAGES} 页仍未取完！`,
      HttpStatus.BAD_GATEWAY,
    );
  }

  /**
   * 获取对象详情
   *
   * @param kongId 站点ID
   * @param type 对象类型
   * @param id 对象ID（Kong 也接受 name）
   * @returns 对象详情
   */
  async show(
    kongId: number,
    type: KongObjectType,
    id: string,
  ): Promise<KongObject> {
    /** Admin API 地址 */
    const base = await this.kongSrv.url(kongId);
    /** 对象详情 */
    const row = await kongRequest<KongObject>(base, `/${type}/${id}`);
    return this.enrich(type, row);
  }

  /**
   * 创建对象
   *
   * @param kongId 站点ID
   * @param type 对象类型
   * @param value 对象数据，注：由 Kong 自行校验字段，后端不建模
   * @returns 创建结果
   */
  async create(
    kongId: number,
    type: KongObjectType,
    value: Record<string, unknown>,
  ): Promise<KongObject> {
    /** Admin API 地址 */
    const base = await this.kongSrv.url(kongId);
    return kongRequest<KongObject>(base, `/${type}`, {
      method: 'POST',
      body: value,
    });
  }

  /**
   * 更新对象
   *
   * @param kongId 站点ID
   * @param type 对象类型
   * @param id 对象ID
   * @param value 对象数据，注：Kong 用 PATCH，只改提交的字段
   * @returns 更新结果
   */
  async update(
    kongId: number,
    type: KongObjectType,
    id: string,
    value: Record<string, unknown>,
  ): Promise<KongObject> {
    /** Admin API 地址 */
    const base = await this.kongSrv.url(kongId);
    return kongRequest<KongObject>(base, `/${type}/${id}`, {
      method: 'PATCH',
      body: value,
    });
  }

  /**
   * 删除对象
   *
   * @param kongId 站点ID
   * @param type 对象类型
   * @param id 对象ID
   */
  async destroy(
    kongId: number,
    type: KongObjectType,
    id: string,
  ): Promise<void> {
    /** Admin API 地址 */
    const base = await this.kongSrv.url(kongId);
    // 注：Kong 删除成功返回 204 空正文，故不解析响应
    await kongRequest(base, `/${type}/${id}`, { method: 'DELETE' });
  }

  /**
   * 给证书对象补上域名与有效期
   *
   * @param type 对象类型
   * @param row 原始对象
   * @returns 补齐后的对象，注：非证书类型或证书解析失败时原样返回
   */
  private enrich(type: KongObjectType, row: KongObject): KongObject {
    if (type !== 'certificates') {
      return row;
    }
    /** 证书 PEM */
    const pem = typeof row['cert'] === 'string' ? row['cert'] : '';
    /** 解析结果 */
    const info = parseCertificate(pem);
    if (info === null) {
      return row;
    }
    return { ...row, ...info };
  }
}
