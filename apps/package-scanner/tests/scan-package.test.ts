import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ClamAvScanner,
  ImageContentModerator
} from '../src/scan-package';
import { scanPackage } from '../src/scan-package';
import {
  ONE_PIXEL_PNG,
  ONE_PIXEL_WEBP,
  corruptedPixelPng,
  patchCentralDirectoryEntries,
  validPackageEntries,
  validManifest,
  validSourceCatalog,
  zipFixture
} from './zip-fixture';

const archives: string[] = [];
const cleanClamav: ClamAvScanner = {
  scan: async () => ({ infected: false })
};
const cleanImageModerator: ImageContentModerator = {
  review: async ({ path }) => ({
    path,
    provider: 'test',
    suggestion: 'pass',
    labels: []
  })
};

async function createArchive(
  entries: Parameters<typeof zipFixture>[0]
): Promise<string> {
  const path = await zipFixture(entries);
  archives.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(archives.splice(0).map(path => (
    rm(dirname(path), { recursive: true, force: true })
  )));
});

describe('ZIP 隔离扫描', () => {
  it.each([
    ['路径穿越', '../evil.json', 'CHARACTER_PACKAGE_PATH_REJECTED'],
    ['嵌套压缩', 'nested.zip', 'CHARACTER_PACKAGE_FILE_TYPE_REJECTED'],
    ['脚本文件', 'run.js', 'CHARACTER_PACKAGE_FILE_TYPE_REJECTED'],
    ['隐藏文件', '.secret.json', 'CHARACTER_PACKAGE_PATH_REJECTED'],
    ['ZIP 内 JPG', 'preview.jpg', 'CHARACTER_PACKAGE_FILE_TYPE_REJECTED']
  ])('%s 被拒绝', async (_name, path, code) => {
    const archivePath = await createArchive([{ path }]);

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow(code);
  });

  it('超过 500 个文件时在读取内容前拒绝', async () => {
    const archivePath = await createArchive(Array.from({ length: 501 }, (_, index) => ({
      path: `asset-${index}.json`
    })));

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_FILE_COUNT_EXCEEDED');
  });

  it('声明总解压量超过 300 MB 时在读取内容前拒绝', async () => {
    const archivePath = await createArchive(Array.from({ length: 151 }, (_, index) => ({
      path: `asset-${index}.png`,
      bytes: ONE_PIXEL_PNG
    })));
    await patchCentralDirectoryEntries(archivePath, () => ({
      compressedSize: 21 * 1024,
      uncompressedSize: 2 * 1024 * 1024
    }));

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_TOTAL_BYTES_EXCEEDED');
  });

  it('单图声明大小超过 10 MB 时拒绝', async () => {
    const archivePath = await createArchive([{
      path: 'oversized.png',
      bytes: Buffer.alloc(10 * 1024 * 1024 + 1),
      compress: false
    }]);

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_RESOURCE_TOO_LARGE');
  });

  it('JSON 审核文本累计超过 8 MB 时在读取内容前拒绝', async () => {
    const archivePath = await createArchive(Array.from({ length: 5 }, (_, index) => ({
      path: `review/data-${index}.json`,
      bytes: Buffer.from(`"${'a'.repeat(1_700_000)}"`),
      compress: false
    })));

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_JSON_REVIEW_BYTES_EXCEEDED');
  });

  it('大写 JSON 扩展名仍执行 2 MB 上限', async () => {
    const archivePath = await createArchive([{
      path: 'oversized.JSON',
      bytes: Buffer.from(`"${'a'.repeat(2 * 1024 * 1024)}"`),
      compress: false
    }]);

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_JSON_TOO_LARGE');
  });

  it('大小写与 Unicode 归一化后的路径冲突时拒绝', async () => {
    const archivePath = await createArchive([
      { path: 'images/Idle.png', bytes: ONE_PIXEL_PNG },
      { path: 'images/idle.png', bytes: ONE_PIXEL_PNG }
    ]);

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_DUPLICATE_ENTRY');
  });

  it('加密 ZIP 条目被拒绝', async () => {
    const archivePath = await createArchive([{ path: 'data.json' }]);
    await patchCentralDirectoryEntries(archivePath, () => ({
      generalPurposeBitFlag: 1
    }));

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_ENCRYPTED_REJECTED');
  });

  it('符号链接条目被拒绝', async () => {
    const archivePath = await createArchive([{
      path: 'linked.json',
      mode: 0o120777
    }]);

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_LINK_REJECTED');
  });

  it.each([
    ['FIFO', 0o010644],
    ['socket', 0o140644],
    ['字符设备', 0o020644],
    ['块设备', 0o060644]
  ])('%s 特殊 Unix 文件被拒绝', async (_name, mode) => {
    const archivePath = await createArchive([{
      path: 'special.json',
      mode
    }]);

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_LINK_REJECTED');
  });

  it.each([
    ['PNG 扩展名装入 JSON', 'fake.png', Buffer.from('{}')],
    ['WebP 扩展名装入 PNG', 'fake.webp', ONE_PIXEL_PNG],
    ['JSON 扩展名装入 PNG', 'fake.json', ONE_PIXEL_PNG]
  ])('%s 时拒绝扩展名、签名和 MIME 不一致', async (_name, path, bytes) => {
    const archivePath = await createArchive([{ path, bytes }]);

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_SIGNATURE_MISMATCH');
  });

  it('无法安全解码的伪 PNG 被拒绝', async () => {
    const archivePath = await createArchive([{
      path: 'broken.png',
      bytes: Buffer.from('89504e470d0a1a0a00000000', 'hex')
    }]);

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_IMAGE_INVALID');
  });

  it('头部和元数据合法但像素流损坏的 PNG 被拒绝', async () => {
    const archivePath = await createArchive([{
      path: 'broken-pixels.png',
      bytes: corruptedPixelPng()
    }]);

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_IMAGE_INVALID');
  });

  it('JSON 解析失败时拒绝', async () => {
    const archivePath = await createArchive([{
      path: 'data.json',
      bytes: Buffer.from('{')
    }]);

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_JSON_INVALID');
  });

  it('发布清单不符合既有 schema 时拒绝', async () => {
    const archivePath = await createArchive([{
      path: 'compiled/manifest.json',
      bytes: Buffer.from('{}')
    }]);

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_MANIFEST_INVALID');
  });

  it('缺少草稿或源目录文件时拒绝不完整角色包', async () => {
    const archivePath = await createArchive(
      validPackageEntries().filter(entry => entry.path !== 'source/catalog.json')
    );

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_STRUCTURE_INVALID');
  });

  it('草稿、发布清单与源目录角色标识不一致时拒绝', async () => {
    const archivePath = await createArchive(validPackageEntries({
      sourceCatalog: validSourceCatalog({ characterId: 'other-pet' })
    }));

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_ID_MISMATCH');
  });

  it.each([
    ['字节数', validSourceCatalog({ byteLength: ONE_PIXEL_PNG.byteLength + 1 })],
    ['摘要', validSourceCatalog({ sha256: 'b'.repeat(64) })]
  ])('源目录%s声明与文件不一致时拒绝', async (_name, sourceCatalog) => {
    const archivePath = await createArchive(validPackageEntries({
      sourceCatalog
    }));

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_RESOURCE_INVALID');
  });

  it('源目录声明的文件缺失时拒绝', async () => {
    const archivePath = await createArchive(
      validPackageEntries().filter(entry => !entry.path.startsWith('source/1'))
    );

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_STRUCTURE_INVALID');
  });

  it('角色包包含任何未声明文件时拒绝', async () => {
    const archivePath = await createArchive([
      ...validPackageEntries(),
      { path: 'source/extra.png', bytes: ONE_PIXEL_PNG }
    ]);

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_STRUCTURE_INVALID');
  });

  it('整包超时会取消当前文件并停止后续扫描', async () => {
    const archivePath = await createArchive(validPackageEntries());
    const controller = new AbortController();
    let scanCalls = 0;
    const operation = scanPackage({
      archivePath,
      signal: controller.signal,
      clamav: {
        scan: async ({ signal }) => {
          scanCalls += 1;
          if (scanCalls === 1) return { infected: false };
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new Error('已取消')),
              { once: true }
            );
          });
        }
      },
      imageModerator: cleanImageModerator
    });
    setTimeout(() => controller.abort(), 10);

    await expect(operation).rejects.toThrow('SCANNER_SCAN_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(scanCalls).toBe(2);
  });

  it('发布清单声明的资源在 ZIP 中缺失时拒绝', async () => {
    const archivePath = await createArchive(
      validPackageEntries().filter(entry => entry.path !== 'compiled/idle.png')
    );

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_STRUCTURE_INVALID');
  });

  it.each([
    ['字节数', validManifest({ byteLength: ONE_PIXEL_PNG.byteLength + 1 })],
    ['SHA-256', validManifest({ sha256: 'b'.repeat(64) })]
  ])('发布清单资源%s与 ZIP 不一致时拒绝', async (_name, manifest) => {
    const archivePath = await createArchive(validPackageEntries({ manifest }));

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_RESOURCE_INVALID');
  });

  it('发布清单重复声明同一文件名时拒绝', async () => {
    const manifest = validManifest() as {
      resources: Array<Record<string, unknown>>;
    };
    manifest.resources.push({
      ...manifest.resources[0],
      assetId: 'idle-copy'
    });
    const archivePath = await createArchive(validPackageEntries({ manifest }));

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_STRUCTURE_INVALID');
  });

  it('compiled 目录存在未声明资源时拒绝', async () => {
    const archivePath = await createArchive([
      ...validPackageEntries(),
      {
        path: 'compiled/extra.png',
        bytes: ONE_PIXEL_PNG
      }
    ]);

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_STRUCTURE_INVALID');
  });

  it('ClamAV 命中任意文件时拒绝', async () => {
    const archivePath = await createArchive([{
      path: 'data.json',
      bytes: Buffer.from('{}')
    }]);
    const infectedClamav: ClamAvScanner = {
      scan: async () => ({
        infected: true,
        signature: 'Eicar-Test-Signature'
      })
    };

    await expect(scanPackage({
      archivePath,
      clamav: infectedClamav,
      imageModerator: cleanImageModerator
    })).rejects.toThrow('CHARACTER_PACKAGE_MALWARE_DETECTED');
  });

  it('ClamAV 故障返回稳定依赖错误，不伪装成恶意包', async () => {
    const archivePath = await createArchive([{
      path: 'data.json',
      bytes: Buffer.from('{}')
    }]);

    await expect(scanPackage({
      archivePath,
      clamav: {
        scan: async () => {
          throw new Error('ClamAV 私有故障详情');
        }
      },
      imageModerator: cleanImageModerator
    })).rejects.toThrow('SCANNER_CLAMAV_UNAVAILABLE');
  });

  it('图片审核故障返回稳定依赖错误，不伪装成恶意包', async () => {
    const archivePath = await createArchive(validPackageEntries());

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: {
        review: async () => {
          throw new Error('图片审核私有故障详情');
        }
      }
    })).rejects.toThrow('SCANNER_IMAGE_MODERATION_UNAVAILABLE');
  });

  it('合法包仅返回摘要、JSON 文本和图片审核信号', async () => {
    const entries = validPackageEntries();
    const archivePath = await createArchive(entries);
    const archiveBytes = await readFile(archivePath);

    const result = await scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    });

    expect(result).toMatchObject({
      code: 'CHARACTER_PACKAGE_SCAN_PASSED',
      archive: {
        sizeBytes: archiveBytes.byteLength,
        sha256: createHash('sha256').update(archiveBytes).digest('hex')
      },
      summary: {
        fileCount: 5,
        files: expect.arrayContaining([
          expect.objectContaining({ path: 'compiled/manifest.json', kind: 'json' }),
          expect.objectContaining({ path: 'compiled/idle.png', kind: 'image' })
        ])
      }
    });
    expect(result.jsonTexts.map(item => item.path)).toEqual([
      'draft/draft.json',
      'compiled/manifest.json',
      'source/catalog.json'
    ]);
    expect(result.imageSignals.map(signal => signal.path)).toEqual([
      'compiled/idle.png',
      expect.stringMatching(/^source\/.+\.png$/u)
    ]);

    expect(JSON.stringify(result)).not.toContain(ONE_PIXEL_PNG.toString('base64'));
    expect(await readFile(archivePath)).toBeInstanceOf(Buffer);
  });

  it('合法 WebP 按真实签名和解码结果通过', async () => {
    const archivePath = await createArchive(validPackageEntries({
      compiledFileName: 'idle.webp',
      compiledBytes: ONE_PIXEL_WEBP,
      sourceBytes: ONE_PIXEL_WEBP,
      sourceMimeType: 'image/webp'
    }));

    const result = await scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: cleanImageModerator
    });

    expect(result.summary.files.find(file => file.path === 'compiled/idle.webp'))
      .toMatchObject({
      path: 'compiled/idle.webp',
      kind: 'image',
      mime: 'image/webp'
    });
  });

  it('扫描响应预计超过 12 MB 时结构化拒绝', async () => {
    const archivePath = await createArchive(validPackageEntries());

    await expect(scanPackage({
      archivePath,
      clamav: cleanClamav,
      imageModerator: {
        review: async ({ path }) => ({
          path,
          provider: 'test',
          suggestion: 'review',
          labels: [],
          ocrText: 'x'.repeat(13 * 1024 * 1024)
        })
      }
    })).rejects.toThrow('CHARACTER_PACKAGE_SCAN_RESPONSE_TOO_LARGE');
  });
});
