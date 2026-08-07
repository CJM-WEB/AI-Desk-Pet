import { existsSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export interface MainE2eBoundary {
  userDataDirectory: string;
  authorizedRootDirectory: string;
  recycleBinDirectory: string;
  characterAssetsDirectory: string;
  safeCharacterPackage: string;
  maliciousCharacterPackage: string;
  characterExportDestination: string;
}

export interface MainE2eBoundaryOptions {
  appIsPackaged: boolean;
  env: NodeJS.ProcessEnv;
  temporaryDirectory?: string;
}

/**
 * Main 侧唯一的 E2E 环境入口。任一条件不满足时完整回退到正式逻辑。
 */
export function resolveMainE2eBoundary(
  options: MainE2eBoundaryOptions
): MainE2eBoundary | null {
  if (options.appIsPackaged || options.env['MYSELF_E2E'] !== '1') return null;

  const rawUserData = options.env['MYSELF_E2E_USER_DATA'];
  const rawAuthorizedRoot = options.env['MYSELF_E2E_AUTHORIZED_ROOT'];
  const rawRecycleBin = options.env['MYSELF_E2E_RECYCLE_BIN'];
  const rawCharacterAssets = options.env['MYSELF_E2E_CHARACTER_ASSETS'];
  const rawSafePackage = options.env['MYSELF_E2E_SAFE_CHARACTER_PACKAGE'];
  const rawMaliciousPackage = options.env['MYSELF_E2E_MALICIOUS_CHARACTER_PACKAGE'];
  const rawExportDestination = options.env['MYSELF_E2E_CHARACTER_EXPORT'];
  if (
    !rawUserData
    || !rawAuthorizedRoot
    || !rawRecycleBin
    || !rawCharacterAssets
    || !rawSafePackage
    || !rawMaliciousPackage
    || !rawExportDestination
  ) return null;

  /** 只对真实存在目录的规范路径做包含关系判断，阻断链接逃逸与名称前缀碰撞。 */
  const canonicalDirectory = (candidate: string): string | null => {
    if (!isAbsolute(candidate)) return null;
    try {
      if (!statSync(candidate).isDirectory()) return null;
      return realpathSync.native(candidate);
    } catch {
      return null;
    }
  };

  const temporaryDirectory = canonicalDirectory(options.temporaryDirectory ?? tmpdir());
  if (!temporaryDirectory) return null;
  const resolveTemporaryChild = (candidate: string): string | null => {
    const canonicalCandidate = canonicalDirectory(candidate);
    if (!canonicalCandidate) return null;
    const relativePath = relative(temporaryDirectory, canonicalCandidate);
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return null;
    return canonicalCandidate;
  };
  const resolveTemporaryFile = (candidate: string): string | null => {
    if (!isAbsolute(candidate)) return null;
    try {
      if (!statSync(candidate).isFile()) return null;
      const canonicalCandidate = realpathSync.native(candidate);
      const relativePath = relative(temporaryDirectory, canonicalCandidate);
      if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        return null;
      }
      return canonicalCandidate;
    } catch {
      return null;
    }
  };
  const resolveNewTemporaryFile = (candidate: string): string | null => {
    if (!isAbsolute(candidate) || existsSync(candidate)) return null;
    const canonicalParent = resolveTemporaryChild(dirname(candidate));
    if (!canonicalParent) return null;
    const target = resolve(canonicalParent, relative(dirname(candidate), candidate));
    const relativePath = relative(temporaryDirectory, target);
    return relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)
      ? target
      : null;
  };

  const userDataDirectory = resolveTemporaryChild(rawUserData);
  const authorizedRootDirectory = resolveTemporaryChild(rawAuthorizedRoot);
  const recycleBinDirectory = resolveTemporaryChild(rawRecycleBin);
  const characterAssetsDirectory = resolveTemporaryChild(rawCharacterAssets);
  const safeCharacterPackage = resolveTemporaryFile(rawSafePackage);
  const maliciousCharacterPackage = resolveTemporaryFile(rawMaliciousPackage);
  const characterExportDestination = resolveNewTemporaryFile(rawExportDestination);
  if (
    !userDataDirectory
    || !authorizedRootDirectory
    || !recycleBinDirectory
    || !characterAssetsDirectory
    || !safeCharacterPackage
    || !maliciousCharacterPackage
    || !characterExportDestination
  ) return null;
  if (new Set([
    userDataDirectory,
    authorizedRootDirectory,
    recycleBinDirectory,
    characterAssetsDirectory
  ]).size !== 4) return null;

  return {
    userDataDirectory,
    authorizedRootDirectory,
    recycleBinDirectory,
    characterAssetsDirectory,
    safeCharacterPackage,
    maliciousCharacterPackage,
    characterExportDestination
  };
}
