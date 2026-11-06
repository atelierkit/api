/** 证书列表项（前端唯一契约） */
export interface SslCertItem {
  /** 证书ID（对应接口的 `CertificateId`，与 `OrderId` 不是一个概念） */
  certId: number;
  /** 实例ID（`cas-cn-*`） */
  instanceId: string;
  /** 证书名称 */
  name: string;
  /** 主域名 */
  domain: string;
  /** 全部域名（原始为半角逗号分隔串） */
  sans: string[];
  /** 颁发机构 */
  issuer: string;
  /** 签发时间（ISO 8601） */
  startAt: string;
  /** 到期时间（ISO 8601） */
  endAt: string;
  /** 是否已过期 */
  expired: boolean;
  /** 是否外部上传（false 表示阿里云签发） */
  uploaded: boolean;
}

/** 订单列表项（前端唯一契约） */
export interface SslOrderItem {
  /** 实例ID（`cas-cn-*`），申请证书时作为 `InstanceId` 提交 */
  instanceId: string;
  /** 订单ID，查申请状态时作为 `OrderId` 提交 */
  orderId: number;
  /** 资源状态，如 `PAYED` / `ISSUED` / `EXPIRED` */
  status: string;
  /** 证书类型：DV / OV / EV / FREE */
  certType: string;
  /** 产品名，如 `EEFreeSSL` */
  product: string;
  /** 主域名，注：空串表示额度未使用 */
  domain: string;
  /** 购买时间（ISO 8601） */
  boughtAt: string;
  /** 到期时间（ISO 8601） */
  endAt: string;
}

/** DNS 验证记录 */
export interface SslDnsRecord {
  /** 记录类型 */
  type: 'TXT' | 'CNAME';
  /** 记录名（完整域名，如 `_dnsauth.kong.example.com`） */
  domain: string;
  /** 记录值 */
  value: string;
}

/**
 * 取字符串字段
 *
 * @param value 原始值
 * @returns 字符串，非字符串时为空串
 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 取数字字段
 *
 * @param value 原始值
 * @returns 数字，无法转换时为 0
 */
function numberOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    /** 解析结果 */
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * 拆分域名列表
 *
 * 注 1：`Sans` 在证书接口里是**半角逗号分隔串**（实测 `kong.marbleqi.top,www.kong.marbleqi.top`），
 * 在别处又可能是数组，两种都要吃
 * 注 2：去重并保留顺序 —— 同一域名重复出现会让 KONG 的 `snis` 建重复 SNI
 *
 * @param value 原始值
 * @returns 域名列表
 */
export function sansOf(value: unknown): string[] {
  /** 拆出的原始条目 */
  const items: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        items.push(item);
      }
    }
  } else if (typeof value === 'string') {
    items.push(...value.split(','));
  }
  /** 去重后的结果 */
  const seen = new Set<string>();
  for (const item of items) {
    /** 去空白后的域名 */
    const name = item.trim();
    if (name !== '') {
      seen.add(name);
    }
  }
  return [...seen];
}

/**
 * 归一化时间
 *
 * 注：阿里云同一条记录里**两套时间并存** —— `CertStartTime` 是毫秒时间戳、
 * `StartDate` 是 `YYYY-MM-DD` 字符串。统一转成 ISO 8601，避免前端各写一套判断
 *
 * @param value 毫秒时间戳 / 日期字符串 / 空
 * @returns ISO 8601 字符串，无法解析时为空串
 */
export function timeOf(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  if (typeof value !== 'string') {
    return '';
  }
  /** 去空白后的原文 */
  const text = value.trim();
  if (text === '') {
    return '';
  }
  // 纯日期按 UTC 零点补齐（`new Date('2026-11-06')` 在部分运行时会按本地时区解析）
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return new Date(`${text}T00:00:00.000Z`).toISOString();
  }
  /** 解析出的时间戳 */
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

/**
 * 归一化证书条目
 *
 * @param raw 阿里云 `CertificateOrderList` 里的原始条目（`OrderType=CERT` / `UPLOAD`）
 * @returns 证书列表项
 */
export function certItemOf(raw: Record<string, unknown>): SslCertItem {
  /** 主域名 */
  const domain = textOf(raw.CommonName) || sansOf(raw.Domain)[0] || '';
  /** 绑定域名 */
  const sans = sansOf(raw.Sans);
  return {
    certId: numberOf(raw.CertificateId),
    instanceId: textOf(raw.InstanceId),
    name: textOf(raw.Name),
    domain,
    // 注：证书条目的 `Sans` 是逗号分隔串；缺失时退回主域名，避免前端列表出现空列
    sans: sans.length > 0 ? sans : sansOf(domain),
    issuer: textOf(raw.Issuer),
    // 注：优先用日期字符串（与证书实际起止日一致），缺失时退回毫秒时间戳
    startAt: timeOf(raw.StartDate) || timeOf(raw.CertStartTime),
    endAt: timeOf(raw.EndDate) || timeOf(raw.CertEndTime),
    expired: raw.Expired === true,
    uploaded: raw.Upload === true,
  };
}

/**
 * 归一化订单条目
 *
 * @param raw 阿里云 `CertificateOrderList` 里的原始条目（`OrderType=CPACK` / `BUY`）
 * @returns 订单列表项
 */
export function orderItemOf(raw: Record<string, unknown>): SslOrderItem {
  return {
    instanceId: textOf(raw.InstanceId),
    orderId: numberOf(raw.OrderId),
    status: textOf(raw.Status),
    certType: textOf(raw.CertType),
    product: textOf(raw.ProductName),
    domain: textOf(raw.Domain),
    boughtAt: timeOf(raw.BuyDate),
    endAt: timeOf(raw.CertEndTime),
  };
}

/**
 * 从申请状态响应里取 DNS 验证记录
 *
 * @param state `DescribeCertificateState` 的响应
 * @returns 验证记录，非「待验证」状态时为 null
 */
export function dnsRecordOf(state: Record<string, unknown>): SslDnsRecord | null {
  if (state.Type !== 'domain_verify') {
    return null;
  }
  /** 记录类型 */
  const type = state.RecordType;
  // 注：FILE 验证没有 DNS 记录，此时不返回
  if (type !== 'TXT' && type !== 'CNAME') {
    return null;
  }
  /** 记录名 */
  const domain = textOf(state.RecordDomain);
  /** 记录值 */
  const value = textOf(state.RecordValue);
  if (domain === '' || value === '') {
    return null;
  }
  return { type, domain, value };
}

/**
 * 逐级上推可查 NS 的域名
 *
 * 注：子域的 NS 可能与注册域不同，直接截「最后两段」在 `.com.cn` / `.co.uk` 上会取错，
 * 故按层级逐级尝试，由调用方取第一个有 NS 的结果
 *
 * @param domain 完整域名（如 `_dnsauth.kong.example.com`）
 * @returns 候选域名，从最具体到最宽泛
 */
export function domainLevelsOf(domain: string): string[] {
  /** 标签 */
  const labels = domain.split('.').filter((label) => label !== '');
  /** 候选列表 */
  const levels: string[] = [];
  // 至少要保留两段（`example.com`），再短就不是可查的注册域
  for (let index = 0; index <= labels.length - 2; index += 1) {
    levels.push(labels.slice(index).join('.'));
  }
  return levels;
}

/**
 * 判定 DNS 记录是否已生效
 *
 * 注：`existing` 是查询到的同类记录值；TXT 的解析结果可能带引号且被拆成多段，调用方需先规整
 *
 * @param expected 阿里云要求的记录值
 * @param existing 查询到的记录值
 * @returns DNS 状态
 */
export function dnsStatusOf(
  expected: string,
  existing: string[],
): 'pending' | 'matched' | 'mismatched' {
  if (existing.length === 0) {
    return 'pending';
  }
  return existing.some((item) => item.trim() === expected.trim())
    ? 'matched'
    : 'mismatched';
}
