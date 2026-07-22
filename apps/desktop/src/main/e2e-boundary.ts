import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative } from 'node:path';

export interface MainE2eBoundary {
  userDataDirectory: string;
  authorizedRootDirectory: string;
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
  if (!rawUserData || !rawAuthorizedRoot) return null;

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

  const userDataDirectory = resolveTemporaryChild(rawUserData);
  const authorizedRootDirectory = resolveTemporaryChild(rawAuthorizedRoot);
  if (!userDataDirectory || !authorizedRootDirectory) return null;

  return { userDataDirectory, authorizedRootDirectory };
}
