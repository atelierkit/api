// 外部依赖
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// 内部依赖
import { LocalFileStorage } from './local.storage.js';

/** 测试用上传根目录 */
let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atelierkit-storage-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('LocalFileStorage', () => {
  it('put 写入文件内容，并自动创建子目录', async () => {
    const storage = new LocalFileStorage(root);
    await storage.put('avatar/a.webp', Buffer.from('hello'));

    const target = join(root, 'avatar', 'a.webp');
    await expect(stat(target)).resolves.toBeTruthy();
    await expect(readFile(target, 'utf8')).resolves.toBe('hello');
  });

  it('put 遇到同名文件直接失败，不静默覆盖别人的头像', async () => {
    const storage = new LocalFileStorage(root);
    await storage.put('avatar/a.webp', Buffer.from('first'));

    await expect(
      storage.put('avatar/a.webp', Buffer.from('second')),
    ).rejects.toThrow();
    await expect(readFile(join(root, 'avatar', 'a.webp'), 'utf8')).resolves.toBe(
      'first',
    );
  });

  it('put 拒绝非法 key（穿越到根目录之外）', async () => {
    const storage = new LocalFileStorage(root);
    await expect(
      storage.put('../escape.webp', Buffer.from('x')),
    ).rejects.toThrow(/非法的存储 key/);
  });

  it('remove 删除文件，文件不存在时不抛错', async () => {
    const storage = new LocalFileStorage(root);
    await storage.put('avatar/a.webp', Buffer.from('hello'));

    await storage.remove('avatar/a.webp');
    await expect(stat(join(root, 'avatar', 'a.webp'))).rejects.toThrow();
    // 第二次删除（已不存在）同样不应抛错
    await expect(storage.remove('avatar/a.webp')).resolves.toBeUndefined();
  });

  it('remove 对非法 key 只跳过，不触碰根目录外的文件', async () => {
    const storage = new LocalFileStorage(root);
    await expect(storage.remove('../../etc/passwd')).resolves.toBeUndefined();
  });

  it('url 把 key 转成 /static/ 下的地址', () => {
    const storage = new LocalFileStorage(root);
    expect(storage.url('avatar/a.webp')).toBe('/static/avatar/a.webp');
  });
});
