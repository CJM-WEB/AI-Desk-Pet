import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import type { CodingSessionOptions } from '@myself/coding-task-core';

type TrustedExecutable = NonNullable<CodingSessionOptions['windowsJobHelper']>;

export interface CodingTaskResourceOptions {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  environment?: NodeJS.ProcessEnv;
}

export interface CodingTaskResources {
  windowsJobHelper: TrustedExecutable;
  ripgrepExecutable: TrustedExecutable;
  commandShell: string;
}

async function readDescriptor(
  root: string,
  manifestName: string,
  expectedFile: string
): Promise<TrustedExecutable> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(root, manifestName), 'utf8'));
    if (
      typeof raw !== 'object'
      || raw === null
      || Array.isArray(raw)
      || Object.keys(raw).sort().join(',') !== 'file,sha256'
      || Reflect.get(raw, 'file') !== expectedFile
      || typeof Reflect.get(raw, 'sha256') !== 'string'
      || !/^[a-f0-9]{64}$/u.test(Reflect.get(raw, 'sha256') as string)
    ) {
      throw new Error('invalid');
    }
    const executablePath = join(root, expectedFile);
    if (!isAbsolute(executablePath) || !(await lstat(executablePath)).isFile()) {
      throw new Error('invalid');
    }
    return Object.freeze({
      executablePath,
      sha256: Reflect.get(raw, 'sha256') as string
    });
  } catch {
    throw new Error('CODING_TASK_RESOURCE_MANIFEST_INVALID');
  }
}

function resolvePowerShell(systemRoot: string): string {
  const normalized = win32.normalize(systemRoot);
  if (!/^[a-z]:\\/iu.test(win32.parse(normalized).root) || normalized.includes('\0')) {
    throw new Error('CODING_TASK_SYSTEM_ROOT_INVALID');
  }
  return win32.join(normalized, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** 只解析开发产物或发行资源；哈希在 Core 每次实际执行前再次验证。 */
export async function resolveCodingTaskResources(
  options: CodingTaskResourceOptions
): Promise<CodingTaskResources> {
  const root = options.isPackaged
    ? resolve(options.resourcesPath, 'coding-task-resources')
    : resolve(options.appPath, '..', '..', 'packages', 'coding-task-core', 'dist');
  const systemRoot = options.environment?.SystemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
  const commandShell = resolvePowerShell(systemRoot);
  const [windowsJobHelper, ripgrepExecutable] = await Promise.all([
    readDescriptor(root, 'windows-job-helper.json', 'windows-job-helper.exe'),
    readDescriptor(root, 'ripgrep.json', 'rg.exe')
  ]);
  return {
    windowsJobHelper,
    ripgrepExecutable,
    commandShell
  };
}
