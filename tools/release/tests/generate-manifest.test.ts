import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { releaseManifestSchema } from '@myself/shared-types/release-manifest';
import {
  generateReleaseManifest,
  parseManifestCommandArgs,
  writeReleaseManifest
} from '../src/generate-manifest';

const temporaryRoots: string[] = [];

async function createFixtureInstaller(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'myself-release-'));
  temporaryRoots.push(directory);
  const installerPath = join(directory, 'AI-Pet-0.1.0-alpha.1-windows-x64.exe');
  await writeFile(installerPath, Buffer.from('fixture-installer'), 'utf8');
  return installerPath;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe('generateReleaseManifest', () => {
  test('从最终安装包字节生成官网发布清单', async () => {
    const installerPath = await createFixtureInstaller();
    const manifest = await generateReleaseManifest({
      installerPath,
      downloadBaseUrl: 'https://download.example.com/releases/',
      publishedAt: '2026-07-25T00:00:00.000Z'
    });

    expect(releaseManifestSchema.parse(manifest)).toEqual({
      version: '0.1.0-alpha.1',
      platform: 'windows-x64',
      status: 'published',
      fileName: 'AI-Pet-0.1.0-alpha.1-windows-x64.exe',
      downloadUrl: 'https://download.example.com/releases/AI-Pet-0.1.0-alpha.1-windows-x64.exe',
      sizeBytes: 17,
      sha256: createHash('sha256').update(Buffer.from('fixture-installer')).digest('hex'),
      publishedAt: '2026-07-25T00:00:00.000Z',
      signed: false
    });
  });

  test('拒绝不符合第一阶段命名契约的安装包', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'myself-release-invalid-'));
    temporaryRoots.push(directory);
    const installerPath = join(directory, 'AI-Pet-latest.exe');
    await writeFile(installerPath, 'fixture', 'utf8');

    await expect(generateReleaseManifest({
      installerPath,
      downloadBaseUrl: 'https://download.example.com/releases/',
      publishedAt: '2026-07-25T00:00:00.000Z'
    })).rejects.toThrow('安装包文件名不符合第一阶段发布契约');
  });
});

describe('writeReleaseManifest', () => {
  test('以稳定 JSON 格式写入清单文件', async () => {
    const installerPath = await createFixtureInstaller();
    const directory = await mkdtemp(join(tmpdir(), 'myself-manifest-output-'));
    temporaryRoots.push(directory);
    const outputPath = join(directory, 'release-manifest.json');

    await writeReleaseManifest({
      installerPath,
      downloadBaseUrl: 'https://download.example.com/releases/',
      publishedAt: '2026-07-25T00:00:00.000Z',
      outputPath
    });

    const written = await readFile(outputPath, 'utf8');
    expect(written).toContain('"version": "0.1.0-alpha.1"');
    expect(written.endsWith('\n')).toBe(true);
  });
});

describe('parseManifestCommandArgs', () => {
  test('忽略 pnpm 透传的分隔符并读取必填参数', () => {
    expect(parseManifestCommandArgs([
      '--',
      '--installer',
      'dist/AI-Pet-0.1.0-alpha.1-windows-x64.exe',
      '--base-url',
      'https://download.example.com/releases/',
      '--published-at',
      '2026-07-25T00:00:00.000Z',
      '--output',
      'apps/website/content/release-manifest.json'
    ])).toEqual({
      installerPath: 'dist/AI-Pet-0.1.0-alpha.1-windows-x64.exe',
      downloadBaseUrl: 'https://download.example.com/releases/',
      publishedAt: '2026-07-25T00:00:00.000Z',
      outputPath: 'apps/website/content/release-manifest.json'
    });
  });
});
