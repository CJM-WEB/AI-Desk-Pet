import { lstat, realpath, stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import {
  PetHabitatStore,
  type HabitatDirectoryRecord
} from './pet-habitat-store';

interface FolderInspection {
  physicalPath: string;
  identity: { dev: number; ino: number };
}

export type FolderIdentityResolverCheckpoint = 'after-first-inspection';

export interface FolderIdentityStat {
  dev: number;
  ino: number;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}

export interface FolderIdentityResolverDependencies {
  realpathPath?: (path: string) => Promise<string>;
  lstatPath?: (path: string) => Promise<FolderIdentityStat>;
  statPath?: (path: string) => Promise<FolderIdentityStat>;
  onCheckpoint?: (checkpoint: FolderIdentityResolverCheckpoint) => Promise<void>;
}

export type FolderIdentityResolution =
  | { status: 'matched'; directoryId: string }
  | { status: 'hidden' };

const HIDDEN_RESOLUTION = { status: 'hidden' } as const;

function samePath(left: string, right: string): boolean {
  return win32.normalize(left).toLocaleLowerCase('en-US')
    === win32.normalize(right).toLocaleLowerCase('en-US');
}

function sameIdentity(
  left: Pick<HabitatDirectoryRecord['identity'], 'dev' | 'ino'>,
  right: Pick<HabitatDirectoryRecord['identity'], 'dev' | 'ino'>
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isSafeIdentity(identity: HabitatDirectoryRecord['identity']): boolean {
  return Number.isSafeInteger(identity.dev)
    && identity.dev >= 0
    && Number.isSafeInteger(identity.ino)
    && identity.ino >= 0;
}

/**
 * 只复核给定候选路径，不枚举目录，也不搜索任何相似路径。
 */
export class FolderIdentityResolver {
  private readonly realpathPath: NonNullable<FolderIdentityResolverDependencies['realpathPath']>;
  private readonly lstatPath: NonNullable<FolderIdentityResolverDependencies['lstatPath']>;
  private readonly statPath: NonNullable<FolderIdentityResolverDependencies['statPath']>;
  private readonly onCheckpoint?: FolderIdentityResolverDependencies['onCheckpoint'];

  constructor(
    private readonly store: PetHabitatStore,
    dependencies: FolderIdentityResolverDependencies = {}
  ) {
    this.realpathPath = dependencies.realpathPath ?? realpath;
    this.lstatPath = dependencies.lstatPath ?? lstat;
    this.statPath = dependencies.statPath ?? stat;
    this.onCheckpoint = dependencies.onCheckpoint;
  }

  async resolve(candidatePath: string): Promise<FolderIdentityResolution> {
    try {
      if (
        typeof candidatePath !== 'string'
        || candidatePath.length === 0
        || candidatePath.length > 32_768
        || candidatePath.includes('\0')
      ) return HIDDEN_RESOLUTION;

      const inspected = await this.inspectTwice(candidatePath);
      if (inspected === undefined) return HIDDEN_RESOLUTION;
      const snapshot = await this.store.load();
      const identityMatches = snapshot.directories.filter(directory => (
        sameIdentity(directory.identity, inspected.identity)
      ));
      if (identityMatches.length !== 1 || !identityMatches[0]!.enabled) {
        return HIDDEN_RESOLUTION;
      }

      const matched = identityMatches[0]!;
      const update = await this.store.updateDirectoryPath({
        directoryId: matched.id,
        expectedIdentity: inspected.identity,
        absolutePath: inspected.physicalPath
      });
      if (update === 'missing' || update === 'conflict') return HIDDEN_RESOLUTION;
      return { status: 'matched', directoryId: matched.id };
    } catch {
      return HIDDEN_RESOLUTION;
    }
  }

  private async inspectTwice(candidatePath: string): Promise<FolderInspection | undefined> {
    const first = await this.inspectOnce(candidatePath);
    if (first === undefined) return undefined;
    await this.onCheckpoint?.('after-first-inspection');
    const second = await this.inspectOnce(candidatePath);
    if (
      second === undefined
      || !samePath(first.physicalPath, second.physicalPath)
      || !sameIdentity(first.identity, second.identity)
    ) return undefined;
    return second;
  }

  private async inspectOnce(candidatePath: string): Promise<FolderInspection | undefined> {
    const [physicalPath, entry, target] = await Promise.all([
      this.realpathPath(candidatePath),
      this.lstatPath(candidatePath),
      this.statPath(candidatePath)
    ]);
    const identity = { dev: entry.dev, ino: entry.ino };
    if (
      typeof physicalPath !== 'string'
      || physicalPath.length === 0
      || physicalPath.length > 32_768
      || physicalPath.includes('\0')
      || entry.isSymbolicLink()
      || !entry.isDirectory()
      || !target.isDirectory()
      || !isSafeIdentity(identity)
      || entry.dev !== target.dev
      || entry.ino !== target.ino
    ) return undefined;
    return { physicalPath, identity };
  }
}
