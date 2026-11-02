// 外部依赖
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  isExternalUrl,
  isSafeKey,
  sniffImageExtension,
  storageRoot,
  toPublicUrl,
  toStorageKey,
  toStoragePath,
} from './storage.util.js';

/** 构造 PNG 文件头（8 字节魔数 + 4 字节占位） */
function pngBuffer(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]);
}

/** 构造 JPEG 文件头 */
function jpgBuffer(): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  ]);
}

/** 构造 WebP 文件头（RIFF + 长度 + WEBP） */
function webpBuffer(): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
    Buffer.from([0x56, 0x50, 0x38, 0x20]),
  ]);
}

describe('sniffImageExtension', () => {
  it('识别 PNG / JPEG / WebP 的真实文件头', () => {
    expect(sniffImageExtension(pngBuffer())).toBe('png');
    expect(sniffImageExtension(jpgBuffer())).toBe('jpg');
    expect(sniffImageExtension(webpBuffer())).toBe('webp');
  });

  it('拒收 SVG、纯文本与过短的缓冲区（不看 mimetype 与扩展名）', () => {
    expect(
      sniffImageExtension(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    ).toBeNull();
    expect(sniffImageExtension(Buffer.from('not an image at all'))).toBeNull();
    expect(sniffImageExtension(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(sniffImageExtension(Buffer.alloc(0))).toBeNull();
  });

  it('RIFF 但子类型不是 WEBP 时拒收（如 WAV）', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'ascii'),
      Buffer.from([0x66, 0x6d, 0x74, 0x20]),
    ]);
    expect(sniffImageExtension(wav)).toBeNull();
  });
});

describe('isExternalUrl', () => {
  it('识别 http / https / 协议相对 / data 地址', () => {
    expect(isExternalUrl('https://example.com/a.png')).toBe(true);
    expect(isExternalUrl('http://example.com/a.png')).toBe(true);
    expect(isExternalUrl('//cdn.example.com/a.png')).toBe(true);
    expect(isExternalUrl('data:image/png;base64,AAAA')).toBe(true);
  });

  it('本地 key 与站内路径不算外链', () => {
    expect(isExternalUrl('avatar/a.png')).toBe(false);
    expect(isExternalUrl('/static/avatar/a.png')).toBe(false);
    expect(isExternalUrl('')).toBe(false);
  });
});

describe('isSafeKey', () => {
  it('放行正常的层级 key', () => {
    expect(isSafeKey('avatar/8f14e45f.webp')).toBe(true);
    expect(isSafeKey('files/2026/11/a.png')).toBe(true);
  });

  it('挡掉穿越、绝对路径、反斜杠与空段', () => {
    for (const key of [
      '../etc/passwd',
      'avatar/../../secret',
      '/etc/passwd',
      'avatar\\..\\secret',
      'avatar//a.png',
      'avatar/./a.png',
      '',
      '   ',
      'avatar/\u0000a.png',
    ]) {
      expect(isSafeKey(key), `应拒收：${JSON.stringify(key)}`).toBe(false);
    }
  });
});

describe('toStoragePath', () => {
  const root = join('data', 'uploads');

  it('把 key 拼成根目录下的路径（相对根目录也按绝对路径返回）', () => {
    expect(toStoragePath(root, 'avatar/a.png')).toBe(
      resolve(root, 'avatar', 'a.png'),
    );
  });

  it('越界与非法 key 返回 null', () => {
    expect(toStoragePath(root, '../a.png')).toBeNull();
    expect(toStoragePath(root, 'avatar/../../a.png')).toBeNull();
  });

  it('同名前缀的兄弟目录不被当成子路径', () => {
    // 根目录为 `data/uploads` 时，`data/uploads2/a.png` 不能通过前缀判断
    const sibling = `${root}2${sep}a.png`;
    expect(toStoragePath(root, sibling)).toBeNull();
  });
});

describe('toPublicUrl', () => {
  it('key 拼成 /static/ 地址', () => {
    expect(toPublicUrl('avatar/a.webp')).toBe('/static/avatar/a.webp');
  });

  it('已拼好的地址、站内路径与外链原样返回（不二次拼接）', () => {
    expect(toPublicUrl('/static/avatar/a.webp')).toBe('/static/avatar/a.webp');
    expect(toPublicUrl('https://example.com/a.png')).toBe(
      'https://example.com/a.png',
    );
  });

  it('空值统一返回空串，交给前端回退首字符头像', () => {
    expect(toPublicUrl('')).toBe('');
    expect(toPublicUrl(null)).toBe('');
    expect(toPublicUrl(undefined)).toBe('');
    expect(toPublicUrl('   ')).toBe('');
  });
});

describe('toStorageKey', () => {
  it('从公开地址反解 key', () => {
    expect(toStorageKey('/static/avatar/a.webp')).toBe('avatar/a.webp');
    expect(toStorageKey('avatar/a.webp')).toBe('avatar/a.webp');
  });

  it('外链与空值返回 null（别人图床上的图不能删）', () => {
    expect(toStorageKey('https://example.com/a.png')).toBeNull();
    expect(toStorageKey('')).toBeNull();
    expect(toStorageKey(null)).toBeNull();
  });

  it('非法路径返回 null', () => {
    expect(toStorageKey('/static/../secret')).toBeNull();
  });

  it('站内非托管路径返回 null（历史手填的 /a.png 不是可删除的文件）', () => {
    expect(toStorageKey('/a.png')).toBeNull();
    expect(toStorageKey('/assets/tmp/img/avatar.jpg')).toBeNull();
  });
});

describe('storageRoot', () => {
  it('优先取 UPLOAD_DIR，并解析为绝对路径', () => {
    const backup = process.env['UPLOAD_DIR'];
    process.env['UPLOAD_DIR'] = join('data', 'uploads-test');
    try {
      expect(storageRoot()).toBe(join(process.cwd(), 'data', 'uploads-test'));
    } finally {
      if (backup === undefined) {
        delete process.env['UPLOAD_DIR'];
      } else {
        process.env['UPLOAD_DIR'] = backup;
      }
    }
  });

  it('未配置时回退到 data/uploads', () => {
    const backup = process.env['UPLOAD_DIR'];
    delete process.env['UPLOAD_DIR'];
    try {
      expect(storageRoot()).toBe(join(process.cwd(), 'data', 'uploads'));
    } finally {
      if (backup !== undefined) {
        process.env['UPLOAD_DIR'] = backup;
      }
    }
  });
});
