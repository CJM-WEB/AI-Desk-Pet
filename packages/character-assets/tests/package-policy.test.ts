import { describe, expect, test } from 'vitest';
import {
  validatePackageEntries,
  type PackageEntryDescriptor
} from '../src/package-policy';

function file(
  path: string,
  compressedBytes = 10,
  uncompressedBytes = 20
): PackageEntryDescriptor {
  return {
    path,
    compressedBytes,
    uncompressedBytes,
    kind: 'file'
  };
}

function directory(path: string): PackageEntryDescriptor {
  return {
    path,
    compressedBytes: 0,
    uncompressedBytes: 0,
    kind: 'directory'
  };
}

describe('角色包纯安全策略', () => {
  test.each([
    '../outside.txt',
    'draft/../../outside.json',
    'C:/outside.txt',
    'C:\\outside.txt',
    'C:outside.json',
    '/absolute.txt',
    '\\absolute.txt',
    '\\\\server\\share\\outside.txt',
    '//server/share/outside.txt'
  ])('拒绝越界路径：%s', path => {
    expect(() => validatePackageEntries([file(path)]))
      .toThrow('CHARACTER_PACKAGE_PATH_REJECTED');
  });

  test.each([
    'draft//draft.json',
    'draft\\\\draft.json',
    'draft/./draft.json',
    'draft./draft.json',
    'draft /draft.json',
    'draft/draft.json.',
    'draft/draft.json ',
    'draft/foo:bar.json',
    'draft/draft.json:stream'
  ])('拒绝 Windows 会折叠或产生空段的路径：%s', path => {
    expect(() => validatePackageEntries([file(path)]))
      .toThrow('CHARACTER_PACKAGE_PATH_REJECTED');
  });

  test.each([
    'CON.json',
    'draft/PRN.json',
    'source/aux.png',
    'source/NUL.webp',
    'compiled/com1.png',
    'compiled/LPT9.webp',
    'source/con.extra.png',
    'source/COM¹.png',
    'source/com².webp',
    'source/CoM³.png',
    'compiled/LPT¹.webp',
    'compiled/lpt².png',
    'compiled/LpT³.webp'
  ])('拒绝 Windows 保留名：%s', path => {
    expect(() => validatePackageEntries([file(path)]))
      .toThrow('CHARACTER_PACKAGE_PATH_REJECTED');
  });

  test.each([
    'scripts/run.js',
    'pages/index.html',
    'bin/tool.exe',
    'bin/library.dll',
    'native/addon.node',
    'source/readme.txt'
  ])('拒绝非白名单文件：%s', path => {
    expect(() => validatePackageEntries([file(path)]))
      .toThrow('CHARACTER_PACKAGE_FILE_TYPE_REJECTED');
  });

  test('规范化反斜杠并返回文件计数与总解压量', () => {
    expect(validatePackageEntries([
      {
        path: 'draft\\',
        compressedBytes: 0,
        uncompressedBytes: 0,
        kind: 'directory'
      },
      file('draft\\draft.json', 10, 20),
      file('compiled\\thumbnail.webp', 5, 15)
    ])).toEqual({
      fileCount: 2,
      totalUncompressedBytes: 35,
      normalizedPaths: [
        'draft/',
        'draft/draft.json',
        'compiled/thumbnail.webp'
      ]
    });
  });

  test.each([
    {
      entries: [
      file('draft/Draft.json'),
      file('draft/draft.json')
      ]
    },
    {
      entries: [
      file('source/café.png'),
      file('source/cafe\u0301.png')
      ]
    },
    {
      entries: [
      file('compiled/atlas.png'),
      file('compiled\\atlas.png')
      ]
    }
  ])('拒绝大小写、Unicode 或分隔符归一化后的重复条目', ({ entries }) => {
    expect(() => validatePackageEntries(entries))
      .toThrow('CHARACTER_PACKAGE_DUPLICATE_ENTRY');
  });

  test.each([
    {
      entries: [
        file('draft.json'),
        file('draft.json/child.png')
      ]
    },
    {
      entries: [
        file('SOURCE.JSON'),
        file('source.json/child.webp')
      ]
    }
  ])('拒绝普通文件与后代路径的前缀冲突', ({ entries }) => {
    expect(() => validatePackageEntries(entries))
      .toThrow('CHARACTER_PACKAGE_PATH_PREFIX_CONFLICT');
  });

  test.each([
    {
      path: 'source/link.png',
      compressedBytes: 0,
      uncompressedBytes: 0,
      kind: 'symlink' as const
    },
    {
      path: 'source/junction',
      compressedBytes: 0,
      uncompressedBytes: 0,
      kind: 'symlink' as const
    }
  ])('拒绝链接或目录联接：$path', entry => {
    expect(() => validatePackageEntries([entry]))
      .toThrow('CHARACTER_PACKAGE_LINK_REJECTED');
  });

  test('拒绝单条目压缩倍率超过 100 或伪造零压缩大小', () => {
    expect(() => validatePackageEntries([file('source/bomb.png', 10, 1_001)]))
      .toThrow('CHARACTER_PACKAGE_EXPANSION_LIMIT');
    expect(() => validatePackageEntries([file('source/zero.png', 0, 1)]))
      .toThrow('CHARACTER_PACKAGE_EXPANSION_LIMIT');
  });

  test('拒绝超过 256 MiB 的总解压量', () => {
    const entries = Array.from(
      { length: 9 },
      (_, index) => file(
        `source/${index}.png`,
        512 * 1024,
        30 * 1024 * 1024
      )
    );
    expect(() => validatePackageEntries(entries))
      .toThrow('CHARACTER_PACKAGE_TOTAL_BYTES_EXCEEDED');
  });

  test('拒绝超过 2 MiB 的 JSON 文档', () => {
    expect(() => validatePackageEntries([
      file('draft/draft.json', 32 * 1024, 2 * 1024 * 1024 + 1)
    ])).toThrow('CHARACTER_PACKAGE_JSON_TOO_LARGE');
  });

  test('拒绝超过 32 MiB 的单个资源', () => {
    expect(() => validatePackageEntries([
      file('source/large.png', 512 * 1024, 32 * 1024 * 1024 + 1)
    ])).toThrow('CHARACTER_PACKAGE_RESOURCE_TOO_LARGE');
  });

  test('拒绝超过 2,000 个文件', () => {
    const entries = Array.from(
      { length: 2_001 },
      (_, index) => file(`source/${index}.png`, 1, 1)
    );

    expect(() => validatePackageEntries(entries))
      .toThrow('CHARACTER_PACKAGE_FILE_COUNT_EXCEEDED');
  });

  test('拒绝超过 2,000 个目录条目的目录洪泛', () => {
    const entries = Array.from(
      { length: 2_001 },
      (_, index) => directory(`tree/${index}/`)
    );

    expect(() => validatePackageEntries(entries))
      .toThrow('CHARACTER_PACKAGE_ENTRY_COUNT_EXCEEDED');
  });

  test.each([
    file('source/negative.png', -1, 1),
    file('source/fraction.png', 1, 1.5),
    file('source/infinite.png', 1, Number.POSITIVE_INFINITY)
  ])('拒绝非法 ZIP 大小元数据：$path', entry => {
    expect(() => validatePackageEntries([entry]))
      .toThrow('CHARACTER_PACKAGE_ENTRY_INVALID');
  });
});
