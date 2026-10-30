/** 令牌有效期可选档位（单位：分钟），注：0 表示长期有效 */
export const TOKEN_VALIDS: number[] = [60, 1440, 10080, 43200, 0];

/** 令牌有效期默认档位（单位：分钟），注：与 users.token_valid 列的默认值保持一致 */
export const TOKEN_VALID_DEFAULT = 1440;
