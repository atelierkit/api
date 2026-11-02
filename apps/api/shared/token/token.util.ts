/** 设备标识允许的字符与长度，注：禁止冒号、空白等分隔符，避免与缓存键或日志格式冲突 */
export const DEVICE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** 客户端未上报设备标识时归入的分组，注：等价于改造前的「全部设备共用一个会话」语义 */
export const DEVICE_UNKNOWN = 'unreported';

/**
 * 归一化设备标识
 *
 * 注：设备标识由客户端生成并在登录时上报（同一设备重复登录只保留一个令牌）；
 * 缺失或格式非法时归入统一分组，保证 curl、脚本、未升级的旧客户端仍能登录
 *
 * @param device 客户端上报的设备标识
 * @returns 可用于令牌记录的设备标识
 */
export function normalizeDevice(device?: string): string {
  /** 去空白后的客户端标识 */
  const value = (device ?? '').trim();
  return DEVICE_PATTERN.test(value) ? value : DEVICE_UNKNOWN;
}

/**
 * 判断令牌是否属于指定设备
 *
 * 注：改造前的令牌没有设备字段，无法归属到具体设备，一律视为可被本次登录清理，
 * 避免升级后旧会话与新会话并存
 *
 * @param field 令牌记录中的设备字段
 * @param device 目标设备标识
 * @returns 是否属于该设备
 */
export function sameDevice(field: string | undefined, device: string): boolean {
  /** 令牌记录中的设备标识 */
  const value = field ?? '';
  return !value || value === device;
}
