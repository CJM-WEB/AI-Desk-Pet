import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { build, mergeConfig } from 'vite';

import scannerBuildConfig from '../vite.build.config';

const outputDirectories: string[] = [];
const packageRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

afterEach(async () => {
  await Promise.all(outputDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('扫描器发布构建', () => {
  it('生成面向 Node 22 且可由 Node 加载的服务入口', async () => {
    // 复现容器内 /app/dist 与 /app/node_modules 同根的生产依赖解析布局。
    const outputDirectory = await mkdtemp(join(packageRoot, '.scanner-build-'));
    outputDirectories.push(outputDirectory);

    expect(scannerBuildConfig.build?.target).toBe('node22');
    await build(mergeConfig(scannerBuildConfig, {
      build: {
        outDir: outputDirectory,
        emptyOutDir: true,
      },
    }));

    await expect(import(pathToFileURL(join(outputDirectory, 'server.js')).href))
      .resolves.toMatchObject({
        createScannerServer: expect.any(Function),
        ClamAvCommandScanner: expect.any(Function),
      });
  });
});
