/** 支持的云服务商标识，注：前端下拉与后端校验共用这一份清单 */
export const KEY_PROVIDERS = ['aws', 'aliyun', 'tencent'] as const;

/** 云服务商标识 */
export type KeyProvider = (typeof KEY_PROVIDERS)[number];
