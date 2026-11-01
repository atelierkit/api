// 外部依赖
import { UnprocessableEntityException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { decryptSecret, encryptSecret } from '../../shared/common/secret.util.js';
import { EmailService } from '../../shared/email/email.service.js';
import { SettingService } from '../../shared/setting/setting.service.js';
import { AdminEmailController } from './email.controller.js';

/** 测试用密钥口令 */
const KEY = 'unit-test-key';

/** 原授权码 */
const AUTH_CODE = 'original-code';

/**
 * 组装一条配置记录
 *
 * @param value 覆盖的配置字段
 * @param status 启用状态
 * @returns 配置记录
 */
function rowOf(
  value: Record<string, unknown> = {},
  status = true,
): { code: string; status: boolean; value: Record<string, unknown> } {
  return {
    code: 'email',
    status,
    value: {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      account: 'robot@example.com',
      name: '个人量化工具',
      replyTo: '',
      password: encryptSecret(AUTH_CODE, KEY),
      ...value,
    },
  };
}

/**
 * 组装被测控制器
 *
 * @param row 配置记录，null 表示未配置
 * @returns 被测控制器与替身
 */
function controllerOf(row: unknown = rowOf()) {
  /** 配置服务替身 */
  const settingSrv = {
    show: vi.fn(async (_code: string) => row),
    create: vi.fn(async (..._args: unknown[]) => ({ code: 'email' })),
    update: vi.fn(async (..._args: unknown[]) => ({ code: 'email' })),
  };
  /** 邮件服务替身 */
  const emailSrv = {
    invalidate: vi.fn(() => undefined),
    verify: vi.fn(async () => undefined),
    send: vi.fn(async (_mail: unknown) => undefined),
  };
  /** 被测控制器 */
  const controller = new AdminEmailController(
    settingSrv as unknown as SettingService,
    emailSrv as unknown as EmailService,
  );
  return { controller, settingSrv, emailSrv };
}

/** 一份合法的保存入参 */
const SAVE = {
  host: ' smtp.example.com ',
  port: 465,
  secure: true,
  account: 'robot@example.com',
  name: '个人量化工具',
  replyTo: '',
  password: 'new-code',
};

describe('AdminEmailController', () => {
  beforeEach(() => {
    process.env.SETTING_KEY = KEY;
  });

  afterEach(() => {
    delete process.env.SETTING_KEY;
    delete process.env.SMTP_HOST;
  });

  it('未配置时给出表单初值与 source=none', async () => {
    /** 被测控制器 */
    const { controller } = controllerOf(null);
    /** 详情 */
    const view = await controller.show();
    expect(view.source).toBe('none');
    expect(view.status).toBe(true);
    expect(view.hasPassword).toBe(false);
    expect(view.value.host).toBe('smtp.163.com');
    expect(view.value.port).toBe(465);
  });

  it('已配置时授权码只回占位符，密文不出库', async () => {
    /** 被测控制器 */
    const { controller } = controllerOf();
    /** 详情 */
    const view = await controller.show();
    expect(view.source).toBe('db');
    expect(view.hasPassword).toBe(true);
    expect(view.value.password).toBe('***');
    expect(JSON.stringify(view)).not.toContain(AUTH_CODE);
  });

  it('配置其它字段不完整但授权码有值时，仍提示「已设置」', async () => {
    /** 被测控制器 */
    const { controller } = controllerOf(rowOf({ name: '' }));
    /** 详情 */
    const view = await controller.show();
    expect(view.hasPassword).toBe(true);
  });

  it('环境变量里还有 SMTP 参数时给出迁移提示', async () => {
    process.env.SMTP_HOST = 'smtp.163.com';
    /** 被测控制器 */
    const { controller } = controllerOf();
    expect((await controller.show()).envDetected).toBe(true);
  });

  it('首次保存会创建记录，授权码加密落库', async () => {
    /** 被测控制器与替身 */
    const { controller, settingSrv } = controllerOf(null);
    await controller.save(SAVE, 3, 9);
    /** 创建入参 */
    const [payload, userId, reqId] = settingSrv.create.mock.calls[0] as [
      Record<string, unknown>,
      number,
      number,
    ];
    expect(userId).toBe(3);
    expect(reqId).toBe(9);
    expect((payload.value as Record<string, unknown>).host).toBe(
      'smtp.example.com',
    );
    expect(payload.status).toBe(true);
    /** 落库的授权码 */
    const password = (payload.value as Record<string, string>).password;
    expect(password.startsWith('enc:v1:')).toBe(true);
    expect(decryptSecret(password, KEY)).toBe('new-code');
  });

  it('更新时授权码留空即保持原值，不会把密文冲成空', async () => {
    /** 被测控制器与替身 */
    const { controller, settingSrv } = controllerOf();
    await controller.save({ ...SAVE, password: '' }, 3, 9);
    /** 更新入参 */
    const [key, payload] = settingSrv.update.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(key).toBe('email');
    /** 落库的授权码 */
    const password = (payload.value as Record<string, string>).password;
    expect(decryptSecret(password, KEY)).toBe(AUTH_CODE);
  });

  it('回传占位符同样视为「不改」，前端无需特判', async () => {
    /** 被测控制器与替身 */
    const { controller, settingSrv } = controllerOf();
    await controller.save({ ...SAVE, password: '***' }, 3, 9);
    /** 更新入参 */
    const [, payload] = settingSrv.update.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(decryptSecret((payload.value as Record<string, string>).password, KEY)).toBe(
      AUTH_CODE,
    );
  });

  it('新授权码会覆盖旧值', async () => {
    /** 被测控制器与替身 */
    const { controller, settingSrv } = controllerOf();
    await controller.save(SAVE, 3, 9);
    /** 更新入参 */
    const [, payload] = settingSrv.update.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(decryptSecret((payload.value as Record<string, string>).password, KEY)).toBe(
      'new-code',
    );
  });

  it('历史明文授权码在保存时顺手转成密文', async () => {
    /** 被测控制器与替身 */
    const { controller, settingSrv } = controllerOf(
      rowOf({ password: 'plain-code' }),
    );
    await controller.save({ ...SAVE, password: '' }, 3, 9);
    /** 更新入参 */
    const [, payload] = settingSrv.update.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    /** 落库的授权码 */
    const password = (payload.value as Record<string, string>).password;
    expect(password.startsWith('enc:v1:')).toBe(true);
    expect(decryptSecret(password, KEY)).toBe('plain-code');
  });

  it('首次保存没填授权码时明确拒绝，而不是存个空密码', async () => {
    /** 被测控制器 */
    const { controller, settingSrv } = controllerOf(null);
    await expect(
      controller.save({ ...SAVE, password: '' }, 3, 9),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(settingSrv.create).not.toHaveBeenCalled();
  });

  it('保存后清掉连接器缓存，新配置立即生效', async () => {
    /** 被测控制器与替身 */
    const { controller, emailSrv } = controllerOf();
    await controller.save(SAVE, 3, 9);
    expect(emailSrv.invalidate).toHaveBeenCalledTimes(1);
  });

  it('测试邮件先握手再发信，返回耗时', async () => {
    /** 被测控制器与替身 */
    const { controller, emailSrv } = controllerOf();
    /** 测试结果 */
    const result = await controller.test({ to: ' me@example.com ' });
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
    expect(emailSrv.verify).toHaveBeenCalledTimes(1);
    expect(emailSrv.send).toHaveBeenCalledTimes(1);
    expect((emailSrv.send.mock.calls[0][0] as Record<string, unknown>).to).toBe(
      'me@example.com',
    );
  });
});
