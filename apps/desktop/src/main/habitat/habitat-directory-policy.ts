import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, normalize, parse, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  HabitatDirectoryAvailability,
  HabitatDirectoryRecord
} from './pet-habitat-store';

const MAX_PUBLIC_NAME_LENGTH = 80;
const execFileAsync = promisify(execFile);
const WINDOWS_CLOUD_ATTRIBUTE_MASK = 0x400
  | 0x1000
  | 0x40000
  | 0x400000;

export type HabitatStorageKind =
  | 'fixed'
  | 'network'
  | 'removable'
  | 'cloud-placeholder'
  | 'unknown';

export type HabitatDirectoryPolicyErrorCode =
  | 'HABITAT_DIRECTORY_INVALID'
  | 'HABITAT_DIRECTORY_UNAVAILABLE'
  | 'HABITAT_DIRECTORY_UNSAFE'
  | 'HABITAT_DIRECTORY_PROTECTED'
  | 'HABITAT_DIRECTORY_UNSUPPORTED'
  | 'HABITAT_DIRECTORY_CHANGED'
  | 'HABITAT_DIRECTORY_DUPLICATE'
  | 'HABITAT_DIRECTORY_IDENTITY_CONFLICT';

export interface HabitatDirectoryPolicyRoots {
  userDataPath: string;
  characterStoragePath: string;
}

export type HabitatDirectoryPolicyCheckpoint = 'after-first-inspection';

export interface HabitatDirectoryPolicyDependencies {
  realpathPath?: typeof realpath;
  lstatPath?: typeof lstat;
  statPath?: typeof stat;
  inspectStorage?: (physicalPath: string) => Promise<HabitatStorageKind>;
  onCheckpoint?: (checkpoint: HabitatDirectoryPolicyCheckpoint) => Promise<void>;
}

interface DirectoryInspection {
  physicalPath: string;
  dev: number;
  ino: number;
}

function policyError(code: HabitatDirectoryPolicyErrorCode): Error {
  return new Error(code);
}

function canonicalComparison(path: string): string {
  const canonical = normalize(path);
  return process.platform === 'win32'
    ? canonical.toLocaleLowerCase('en-US')
    : canonical;
}

function samePath(left: string, right: string): boolean {
  return canonicalComparison(left) === canonicalComparison(right);
}

function sameIdentity(
  left: Pick<DirectoryInspection, 'dev' | 'ino'>,
  right: Pick<DirectoryInspection, 'dev' | 'ino'>
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isFiniteIdentity(identity: Pick<DirectoryInspection, 'dev' | 'ino'>): boolean {
  return Number.isFinite(identity.dev)
    && Number.isInteger(identity.dev)
    && identity.dev >= 0
    && Number.isFinite(identity.ino)
    && Number.isInteger(identity.ino)
    && identity.ino >= 0;
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  const child = canonicalComparison(candidate);
  const parent = canonicalComparison(resolve(root));
  const difference = relative(parent, child);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

function boundedDirectoryName(path: string): string {
  const normalized = basename(path)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const bounded = Array.from(normalized).slice(0, MAX_PUBLIC_NAME_LENGTH).join('');
  if (bounded.length === 0) throw policyError('HABITAT_DIRECTORY_INVALID');
  return bounded;
}

function environmentPath(name: string): string | null {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : null;
}

/**
 * 固定 Windows 元数据探针只读取卷类型与目录属性，不枚举目录内容。
 */
async function inspectWindowsStorage(physicalPath: string): Promise<HabitatStorageKind> {
  if (process.platform !== 'win32') return 'fixed';
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe'
  );
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$selectedPath = $env:AI_PET_HABITAT_PROBE_PATH',
    "$attributePath = if ($selectedPath.StartsWith('\\\\?\\')) { $selectedPath } else { '\\\\?\\' + $selectedPath }",
    '$root = [IO.Path]::GetPathRoot($selectedPath)',
    '$driveType = [IO.DriveInfo]::new($root).DriveType.ToString()',
    '$attributes = [int][IO.File]::GetAttributes($attributePath)',
    '[Console]::Out.Write($driveType + "|" + $attributes)'
  ].join('; ');
  try {
    const result = await execFileAsync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AI_PET_HABITAT_PROBE_PATH: physicalPath
      },
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 4_096
    });
    const [driveType, rawAttributes] = result.stdout.trim().split('|');
    const attributes = Number(rawAttributes);
    if (!Number.isInteger(attributes)) return 'unknown';
    if ((attributes & WINDOWS_CLOUD_ATTRIBUTE_MASK) !== 0) return 'cloud-placeholder';
    if (driveType === 'Fixed') return 'fixed';
    if (driveType === 'Network') return 'network';
    if (driveType === 'Removable') return 'removable';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 目录策略只验证 Main 已取得的选择结果，不枚举、读取或修改目录内容。
 */
export class HabitatDirectoryPolicy {
  private readonly realpathPath: typeof realpath;
  private readonly lstatPath: typeof lstat;
  private readonly statPath: typeof stat;
  private readonly inspectStorage: NonNullable<HabitatDirectoryPolicyDependencies['inspectStorage']>;
  private readonly onCheckpoint?: HabitatDirectoryPolicyDependencies['onCheckpoint'];

  constructor(
    private readonly roots: HabitatDirectoryPolicyRoots,
    dependencies: HabitatDirectoryPolicyDependencies = {}
  ) {
    this.realpathPath = dependencies.realpathPath ?? realpath;
    this.lstatPath = dependencies.lstatPath ?? lstat;
    this.statPath = dependencies.statPath ?? stat;
    this.inspectStorage = dependencies.inspectStorage ?? inspectWindowsStorage;
    this.onCheckpoint = dependencies.onCheckpoint;
  }

  async authorize(
    selectedPath: string,
    existingDirectories: readonly HabitatDirectoryRecord[] = []
  ): Promise<HabitatDirectoryRecord> {
    const candidate = this.normalizeSelection(selectedPath);
    const inspected = await this.inspectTwice(candidate);
    await this.assertSupportedAndUnprotected(inspected.physicalPath);

    for (const existing of existingDirectories) {
      const pathsMatch = samePath(existing.absolutePath, inspected.physicalPath);
      const identitiesMatch = sameIdentity(existing.identity, inspected);
      if (pathsMatch && identitiesMatch) {
        throw policyError('HABITAT_DIRECTORY_DUPLICATE');
      }
      if (pathsMatch || identitiesMatch) {
        throw policyError('HABITAT_DIRECTORY_IDENTITY_CONFLICT');
      }
    }

    const displayName = boundedDirectoryName(inspected.physicalPath);
    return {
      id: randomUUID(),
      displayName,
      pathHint: displayName,
      absolutePath: inspected.physicalPath,
      identity: { dev: inspected.dev, ino: inspected.ino },
      enabled: true
    };
  }

  async availability(
    directory: HabitatDirectoryRecord
  ): Promise<HabitatDirectoryAvailability> {
    try {
      const candidate = this.normalizeSelection(directory.absolutePath);
      const inspected = await this.inspectTwice(candidate);
      await this.assertSupportedAndUnprotected(inspected.physicalPath);
      return samePath(directory.absolutePath, inspected.physicalPath)
        && sameIdentity(directory.identity, inspected)
        ? 'available'
        : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  private normalizeSelection(selectedPath: string): string {
    if (
      typeof selectedPath !== 'string'
      || selectedPath.length === 0
      || selectedPath.length > 32_768
      || selectedPath.includes('\0')
    ) {
      throw policyError('HABITAT_DIRECTORY_INVALID');
    }
    if (/^(?:\\\\|\/\/)/u.test(selectedPath)) {
      throw policyError('HABITAT_DIRECTORY_UNSUPPORTED');
    }
    return resolve(selectedPath);
  }

  private async inspectTwice(candidate: string): Promise<DirectoryInspection> {
    let first: DirectoryInspection;
    let second: DirectoryInspection;
    try {
      first = await this.inspectOnce(candidate);
      await this.onCheckpoint?.('after-first-inspection');
      second = await this.inspectOnce(candidate);
    } catch (error) {
      if (
        error instanceof Error
        && /^HABITAT_DIRECTORY_(?:UNSAFE|CHANGED)$/u.test(error.message)
      ) {
        throw error;
      }
      throw policyError('HABITAT_DIRECTORY_UNAVAILABLE');
    }
    if (!samePath(first.physicalPath, second.physicalPath) || !sameIdentity(first, second)) {
      throw policyError('HABITAT_DIRECTORY_CHANGED');
    }
    return second;
  }

  private async inspectOnce(candidate: string): Promise<DirectoryInspection> {
    const [physicalPath, entry, target] = await Promise.all([
      this.realpathPath(candidate),
      this.lstatPath(candidate),
      this.statPath(candidate)
    ]);
    const identity = { dev: entry.dev, ino: entry.ino };
    if (
      entry.isSymbolicLink()
      || !entry.isDirectory()
      || !target.isDirectory()
      || !isFiniteIdentity(identity)
      || entry.dev !== target.dev
      || entry.ino !== target.ino
    ) {
      throw policyError('HABITAT_DIRECTORY_UNSAFE');
    }
    return { physicalPath, ...identity };
  }

  private async assertSupportedAndUnprotected(physicalPath: string): Promise<void> {
    const root = parse(physicalPath).root;
    if (samePath(physicalPath, root)) {
      throw policyError('HABITAT_DIRECTORY_PROTECTED');
    }

    const cloudRoots = [
      environmentPath('OneDrive'),
      environmentPath('OneDriveCommercial'),
      environmentPath('OneDriveConsumer')
    ].filter((path): path is string => path !== null);
    if (cloudRoots.some(cloudRoot => isSameOrDescendant(physicalPath, cloudRoot))) {
      throw policyError('HABITAT_DIRECTORY_UNSUPPORTED');
    }
    if (await this.inspectStorage(physicalPath) !== 'fixed') {
      throw policyError('HABITAT_DIRECTORY_UNSUPPORTED');
    }

    const exactProtectedRoots = [homedir()];
    const protectedTrees = [
      this.roots.userDataPath,
      this.roots.characterStoragePath,
      tmpdir(),
      environmentPath('SystemRoot'),
      environmentPath('windir'),
      environmentPath('ProgramFiles'),
      environmentPath('ProgramFiles(x86)'),
      environmentPath('ProgramW6432'),
      environmentPath('ProgramData'),
      environmentPath('APPDATA'),
      environmentPath('LOCALAPPDATA'),
      environmentPath('TEMP'),
      environmentPath('TMP')
    ].filter((path): path is string => path !== null && path.length > 0);
    const containsRecycleBin = physicalPath
      .split(/[\\/]+/u)
      .some(segment => segment.toLocaleLowerCase('en-US') === '$recycle.bin');
    if (
      containsRecycleBin
      || exactProtectedRoots.some(protectedRoot => samePath(physicalPath, protectedRoot))
      || protectedTrees.some(protectedRoot => isSameOrDescendant(physicalPath, protectedRoot))
    ) {
      throw policyError('HABITAT_DIRECTORY_PROTECTED');
    }
  }
}
