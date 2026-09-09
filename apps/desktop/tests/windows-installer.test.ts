import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
// @ts-expect-error 生产构建脚本保持原生 ESM，测试直接验证其公开行为。
import { buildWindowsInstaller } from '../scripts/build-windows-installer.mjs';

const temporaryRoots: string[] = [];

async function createDesktopFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ai-pet-installer-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'dist', 'win-unpacked'), { recursive: true });
  await mkdir(join(root, 'resources', 'windows'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.0-alpha.1' }));
  await writeFile(join(root, 'resources', 'windows', 'installer.iss'), '[Setup]\n');
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('Windows Inno Setup 安装器构建脚本', () => {
  test('缺少可信编译器路径时给出可执行的构建说明', async () => {
    const root = await createDesktopFixture();

    await expect(buildWindowsInstaller({ desktopRoot: root, environment: {} }))
      .rejects.toThrow('AI_PET_ISCC');
  });

  test('缺少 win-unpacked 发行目录时拒绝调用编译器', async () => {
    const root = await createDesktopFixture();
    await rm(join(root, 'dist', 'win-unpacked'), { recursive: true });
    const runCompiler = vi.fn();

    await expect(buildWindowsInstaller({
      desktopRoot: root,
      environment: { AI_PET_ISCC: join(root, 'ISCC.exe') },
      runCompiler
    })).rejects.toThrow('win-unpacked');
    expect(runCompiler).not.toHaveBeenCalled();
  });

  test('通过独立参数传递版本和路径，并确认单个离线安装包存在', async () => {
    const root = await createDesktopFixture();
    const compiler = join(root, 'ISCC.exe');
    await writeFile(compiler, 'fixture');
    const expectedOutput = join(root, 'dist', 'AI-Pet-0.1.0-alpha.1-windows-x64.exe');
    const runCompiler = vi.fn(async () => {
      await writeFile(expectedOutput, 'installer');
    });

    await expect(buildWindowsInstaller({
      desktopRoot: root,
      environment: { AI_PET_ISCC: compiler },
      runCompiler
    })).resolves.toBe(expectedOutput);

    expect(runCompiler).toHaveBeenCalledWith(compiler, [
      '--define=AppVersion=0.1.0-alpha.1',
      '--define=AppVersionNumeric=0.1.0.0',
      `--define=SourceDir=${join(root, 'dist', 'win-unpacked')}`,
      `--define=OutputDir=${join(root, 'dist')}`,
      join(root, 'resources', 'windows', 'installer.iss')
    ], { cwd: root, windowsHide: true });
    await expect(readFile(expectedOutput, 'utf8')).resolves.toBe('installer');
  });

  test('编译失败和编译成功但未产生产物均返回明确失败', async () => {
    const root = await createDesktopFixture();
    const compiler = join(root, 'ISCC.exe');
    await writeFile(compiler, 'fixture');

    await expect(buildWindowsInstaller({
      desktopRoot: root,
      environment: { AI_PET_ISCC: compiler },
      runCompiler: vi.fn(async () => { throw new Error('compiler fixture failure'); })
    })).rejects.toThrow('Inno Setup 编译失败');

    await expect(buildWindowsInstaller({
      desktopRoot: root,
      environment: { AI_PET_ISCC: compiler },
      runCompiler: vi.fn(async () => undefined)
    })).rejects.toThrow('未生成预期安装包');
  });
});
