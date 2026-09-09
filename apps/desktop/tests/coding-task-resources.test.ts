import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { ZipFile } from 'yazl';
import { afterEach, expect, test } from 'vitest';
import { resolveCodingTaskResources } from '../src/main/agent/coding-task-resources';

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function writeResourceSet(root: string) {
  await mkdir(root, { recursive: true });
  const helper = Buffer.from('helper fixture');
  const ripgrep = Buffer.from('ripgrep fixture');
  await Promise.all([
    writeFile(join(root, 'windows-job-helper.exe'), helper),
    writeFile(join(root, 'windows-job-helper.json'), `${JSON.stringify({
      file: 'windows-job-helper.exe', sha256: sha256(helper)
    })}\n`),
    writeFile(join(root, 'rg.exe'), ripgrep),
    writeFile(join(root, 'ripgrep.json'), `${JSON.stringify({
      file: 'rg.exe', sha256: sha256(ripgrep)
    })}\n`)
  ]);
  return { helper: sha256(helper), ripgrep: sha256(ripgrep) };
}

async function prepareFixtureRipgrep(workspace: string) {
  const files = {
    'rg.exe': Buffer.from('prepared ripgrep fixture'),
    'LICENSE-MIT': Buffer.from('prepared license fixture')
  };
  const archive = join(workspace, 'fixture.zip');
  const zip = new ZipFile();
  for (const [name, value] of Object.entries(files)) zip.addBuffer(value, `fixture/${name}`);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(archive));
  const archiveBytes = await readFile(archive);
  const manifest = join(workspace, 'manifest.json');
  await writeFile(manifest, `${JSON.stringify({
    schemaVersion: 1,
    repository: 'https://example.invalid/repository',
    releaseTag: 'fixture-v1',
    tagObject: 'a'.repeat(40),
    commit: 'b'.repeat(40),
    archive: {
      url: 'http://127.0.0.1:9/unreachable.zip',
      file: 'fixture.zip',
      size: archiveBytes.length,
      sha256: sha256(archiveBytes),
      root: 'fixture/'
    },
    files: Object.entries(files).map(([name, value]) => ({
      archivePath: `fixture/${name}`,
      outputPath: name === 'rg.exe' ? name : `ripgrep-licenses/${name}`,
      size: value.length,
      sha256: sha256(value),
      kind: name === 'rg.exe' ? 'executable' : 'license'
    }))
  }, null, 2)}\n`, 'utf8');
  const output = join(workspace, 'packages', 'coding-task-core', 'dist');
  await execFileAsync(process.execPath, [
    resolve(import.meta.dirname, '../../../packages/coding-task-core/prepare-ripgrep.cjs'),
    '--manifest', manifest,
    '--archive', archive,
    '--cache', join(workspace, 'cache', 'fixture.zip'),
    '--output', output,
    '--offline'
  ]);
  return { files, output };
}

test('开发环境从 Core dist 解析两个可信程序及固定 Windows PowerShell', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'coding-resources-dev-'));
  temporaryDirectories.push(workspace);
  const appPath = join(workspace, 'apps', 'desktop');
  const root = join(workspace, 'packages', 'coding-task-core', 'dist');
  await mkdir(appPath, { recursive: true });
  const hashes = await writeResourceSet(root);

  expect(await resolveCodingTaskResources({
    isPackaged: false,
    resourcesPath: 'unused',
    appPath,
    environment: { SystemRoot: 'C:\\Windows' }
  })).toEqual({
    windowsJobHelper: {
      executablePath: join(root, 'windows-job-helper.exe'),
      sha256: hashes.helper
    },
    ripgrepExecutable: {
      executablePath: join(root, 'rg.exe'),
      sha256: hashes.ripgrep
    },
    commandShell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  });
});

test('发行环境只从 process.resourcesPath 下的专用目录解析', async () => {
  const resourcesPath = await mkdtemp(join(tmpdir(), 'coding-resources-packaged-'));
  temporaryDirectories.push(resourcesPath);
  const root = join(resourcesPath, 'coding-task-resources');
  const hashes = await writeResourceSet(root);

  expect(await resolveCodingTaskResources({
    isPackaged: true,
    resourcesPath,
    appPath: join(resourcesPath, 'ignored'),
    environment: { SystemRoot: 'D:\\Windows' }
  })).toMatchObject({
    windowsJobHelper: { executablePath: join(root, 'windows-job-helper.exe'), sha256: hashes.helper },
    ripgrepExecutable: { executablePath: join(root, 'rg.exe'), sha256: hashes.ripgrep },
    commandShell: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  });
});

test('资源清单缺失或文件名越界时封闭失败且错误不泄露根路径', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'coding-resources-missing-'));
  temporaryDirectories.push(workspace);
  const appPath = join(workspace, 'apps', 'desktop');
  const missing = join(workspace, 'packages', 'coding-task-core', 'dist');
  await mkdir(appPath, { recursive: true });
  let missingFailure: unknown;
  try {
    await resolveCodingTaskResources({
      isPackaged: false,
      resourcesPath: 'unused',
      appPath
    });
  } catch (error) {
    missingFailure = error;
  }
  expect((missingFailure as Error).message).toBe('CODING_TASK_RESOURCE_MANIFEST_INVALID');
  expect(String(missingFailure)).not.toContain(missing);

  await writeResourceSet(missing);
  await writeFile(join(missing, 'ripgrep.json'), JSON.stringify({
    file: '../outside.exe',
    sha256: '0'.repeat(64)
  }));
  await expect(resolveCodingTaskResources({
    isPackaged: false,
    resourcesPath: 'unused',
    appPath
  })).rejects.toThrow('CODING_TASK_RESOURCE_MANIFEST_INVALID');
});

test.each([
  '',
  'Windows',
  'C:Windows',
  '\\\\server\\share\\Windows',
  '\\\\?\\C:\\Windows'
])('拒绝非本地绝对 Windows 系统根：%s', async systemRoot => {
  const resourcesPath = await mkdtemp(join(tmpdir(), 'coding-resources-system-root-'));
  temporaryDirectories.push(resourcesPath);
  await writeResourceSet(join(resourcesPath, 'coding-task-resources'));

  await expect(resolveCodingTaskResources({
    isPackaged: true,
    resourcesPath,
    appPath: join(resourcesPath, 'ignored'),
    environment: { SystemRoot: systemRoot }
  })).rejects.toThrow('CODING_TASK_SYSTEM_ROOT_INVALID');
});

test('临时固定归档准备出的资源可由真实应用根接缝解析', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'coding-resources-integration-'));
  temporaryDirectories.push(workspace);
  const appPath = join(workspace, 'apps', 'desktop');
  await mkdir(appPath, { recursive: true });
  const { files, output } = await prepareFixtureRipgrep(workspace);
  const helper = Buffer.from('prepared helper fixture');
  await Promise.all([
    writeFile(join(output, 'windows-job-helper.exe'), helper),
    writeFile(join(output, 'windows-job-helper.json'), `${JSON.stringify({
      file: 'windows-job-helper.exe', sha256: sha256(helper)
    })}\n`)
  ]);

  const resources = await resolveCodingTaskResources({
    isPackaged: false,
    resourcesPath: 'unused',
    appPath,
    environment: { SystemRoot: 'C:\\Windows' }
  });
  expect(resources.ripgrepExecutable).toEqual({
    executablePath: join(output, 'rg.exe'),
    sha256: sha256(files['rg.exe'])
  });
  expect(resources.windowsJobHelper).toEqual({
    executablePath: join(output, 'windows-job-helper.exe'),
    sha256: sha256(helper)
  });
  expect(await readFile(join(output, 'ripgrep-licenses', 'LICENSE-MIT')))
    .toEqual(files['LICENSE-MIT']);
});
