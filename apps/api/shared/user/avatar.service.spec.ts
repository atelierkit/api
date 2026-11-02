// 外部依赖
import { BadRequestException } from '@nestjs/common';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { resetFileStorage } from '../storage/local.storage.js';
import { AVATAR_MAX_BYTES } from '../storage/storage.constant.js';
import { AvatarService } from './avatar.service.js';
import type { UserService } from './user.service.js';

/** 测试用上传根目录 */
let root = '';

/** 用户服务替身 */
function userStub() {
  return { update: vi.fn(async () => 1) };
}

/** 构造 PNG 文件头（8 字节魔数 + 4 字节占位） */
function pngBuffer(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]);
}

/**
 * 构造上传文件
 *
 * @param buffer 文件内容
 * @param size 声明大小，缺省取实际长度
 * @returns 上传文件
 */
function uploadOf(buffer: Buffer, size: number = buffer.length) {
  return { buffer, size, mimetype: 'image/png', originalname: 'me.png' };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atelierkit-avatar-'));
  process.env['UPLOAD_DIR'] = root;
  // 单例缓存了旧的根目录，每个用例都要重置
  resetFileStorage();
});

afterEach(async () => {
  delete process.env['UPLOAD_DIR'];
  resetFileStorage();
  await rm(root, { recursive: true, force: true });
});

describe('AvatarService.upload', () => {
  it('写入文件、落库只存 key、返回可加载地址', async () => {
    const userSrv = userStub();
    const service = new AvatarService(userSrv as unknown as UserService);

    const result = await service.upload(uploadOf(pngBuffer()), 7, 88);

    // 返回的是可直接放进 <img> 的地址
    expect(result.avatar).toMatch(/^\/static\/avatar\/[0-9a-f-]{36}\.png$/);
    // 落库只存 key（不含 /static/ 与域名），换存储实现时数据不用迁移
    const key = userSrv.update.mock.calls[0]?.[1] as { avatar: string };
    expect(key.avatar).toMatch(/^avatar\/[0-9a-f-]{36}\.png$/);
    expect(userSrv.update).toHaveBeenCalledWith(7, key, 7, 88);
    // 文件确实落在上传目录
    await expect(readdir(join(root, 'avatar'))).resolves.toHaveLength(1);
  });

  it('拒收 SVG / 文本（不看客户端声明的 mimetype）', async () => {
    const userSrv = userStub();
    const service = new AvatarService(userSrv as unknown as UserService);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

    await expect(
      service.upload({ ...uploadOf(svg), mimetype: 'image/png' }, 7, 88),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userSrv.update).not.toHaveBeenCalled();
    await expect(readdir(root)).resolves.toHaveLength(0);
  });

  it('超过大小上限直接拒绝', async () => {
    const userSrv = userStub();
    const service = new AvatarService(userSrv as unknown as UserService);

    await expect(
      service.upload(uploadOf(pngBuffer(), AVATAR_MAX_BYTES + 1), 7, 88),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userSrv.update).not.toHaveBeenCalled();
  });

  it('没选文件或空文件时给出明确错误', async () => {
    const userSrv = userStub();
    const service = new AvatarService(userSrv as unknown as UserService);

    await expect(service.upload(undefined, 7, 88)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.upload(uploadOf(Buffer.alloc(0)), 7, 88),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('落库失败时删掉刚写入的文件，不留孤儿', async () => {
    const userSrv = { update: vi.fn(async () => Promise.reject(new Error('db down'))) };
    const service = new AvatarService(userSrv as unknown as UserService);

    await expect(service.upload(uploadOf(pngBuffer()), 7, 88)).rejects.toThrow(
      'db down',
    );
    await expect(readdir(join(root, 'avatar'))).resolves.toHaveLength(0);
  });
});
