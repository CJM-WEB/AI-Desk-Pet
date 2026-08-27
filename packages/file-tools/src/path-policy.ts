import { lstat, realpath } from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  sep,
  win32
} from 'node:path';
import { FileToolError } from './errors';

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function mapFileSystemError(error: unknown, notFoundMessage: string): FileToolError {
  if (error instanceof FileToolError) return error;
  if (isNodeError(error)) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return new FileToolError('ENTRY_NOT_FOUND', notFoundMessage, { cause: error });
    }
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return new FileToolError('PERMISSION_DENIED', '没有权限访问该路径', { cause: error });
    }
  }
  return new FileToolError('PATH_INVALID', '无法解析该路径', { cause: error });
}

function normalizeRelativePath(input: string): string {
  // Windows 相对路径不需要卷标或替代数据流；统一拒绝冒号，避免敏感文件经 NTFS ADS 语法绕过保护。
  if (
    input.length === 0
    || input.includes('\0')
    || input.includes(':')
    || isAbsolute(input)
    || win32.isAbsolute(input)
    || /^[a-zA-Z]:/.test(input)
    || input.startsWith('\\\\')
  ) {
    throw new FileToolError('PATH_INVALID', '路径必须是授权根目录内的相对路径');
  }

  const segments = input.split(/[\\/]+/u);
  if (segments.includes('..')) {
    throw new FileToolError('PATH_INVALID', '路径不能包含上级目录穿越');
  }

  const normalized = normalize(input);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new FileToolError('PATH_INVALID', '路径不能超出授权根目录');
  }
  return normalized;
}

/** 复用正式路径裁决的词法边界，供执行前的保守意图分流使用。 */
export function isRootRelativePathInput(input: string): boolean {
  try {
    normalizeRelativePath(input);
    return true;
  } catch {
    return false;
  }
}

function assertInside(rootReal: string, candidate: string): void {
  const relation = relative(rootReal, candidate);
  if (
    relation === ''
    || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
  ) {
    return;
  }
  throw new FileToolError('PATH_OUTSIDE_ROOT', '路径位于授权根目录之外');
}

// basename 规则覆盖任意授权根下的同名敏感条目；环境目录规则只保护已知私有数据根，
// 避免把普通项目的 .git 或其他隐藏目录一并误封。
const SENSITIVE_PATH_BASENAMES = new Set([
  '.codex',
  '.git-credentials',
  '.npmrc'
]);

const PRIVATE_APP_DATA_DIRECTORY_NAMES = [
  'AI Pet',
  '@myself'
] as const;

// 这些规则只在 Windows 用户配置根的直接子目录下生效，
// 从而在授权 C:\Users 或磁盘根时保护所有用户，但不误封普通项目内的同名目录。
const PRIVATE_USER_PROFILE_RELATIVE_ROOTS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  'NTUSER.DAT',
  win32.join('AppData', 'Local', 'Microsoft', 'Credentials'),
  win32.join('AppData', 'Local', 'Microsoft', 'Vault'),
  win32.join('AppData', 'Roaming', 'Microsoft', 'Credentials'),
  win32.join('AppData', 'Roaming', 'Microsoft', 'Protect'),
  win32.join('AppData', 'Roaming', 'Microsoft', 'SystemCertificates', 'My', 'Keys'),
  win32.join('AppData', 'Local', 'Google', 'Chrome', 'User Data'),
  win32.join('AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
  win32.join('AppData', 'Local', 'Mozilla'),
  win32.join('AppData', 'Roaming', 'Mozilla'),
  ...PRIVATE_APP_DATA_DIRECTORY_NAMES.flatMap(name => [
    win32.join('AppData', 'Local', name),
    win32.join('AppData', 'Roaming', name)
  ])
].map(path => path.toLocaleLowerCase('en-US'));

async function assertNoLinks(rootReal: string, normalized: string): Promise<void> {
  if (normalized === '.') return;

  let cursor = rootReal;
  for (const part of normalized.split(sep).filter(part => part !== '' && part !== '.')) {
    cursor = join(cursor, part);
    let information;
    try {
      information = await lstat(cursor);
    } catch (error) {
      throw mapFileSystemError(error, '路径中的条目不存在');
    }
    if (information.isSymbolicLink()) {
      throw new FileToolError('LINK_NOT_ALLOWED', '不允许通过符号链接或 Junction 访问文件');
    }
    // Windows 的 Junction 在部分 Node 版本中不会由 lstat 标记为符号链接；
    // 词法路径与 realpath 偏离同样说明本段已跳转，必须失败关闭。
    const resolvedCursor = await realpath(cursor);
    if (normalize(resolvedCursor).toLocaleLowerCase() !== normalize(cursor).toLocaleLowerCase()) {
      throw new FileToolError('LINK_NOT_ALLOWED', '不允许通过符号链接或 Junction 访问文件');
    }
  }
}

function protectedWindowsRoots(environment: NodeJS.ProcessEnv): string[] {
  const profile = environment.USERPROFILE;
  const roaming = environment.APPDATA;
  const local = environment.LOCALAPPDATA;
  const candidates = [
    environment.SystemRoot,
    environment.WINDIR,
    environment.ProgramFiles,
    environment['ProgramFiles(x86)'],
    environment.ProgramData,
    ...(roaming ? [
      win32.join(roaming, 'Microsoft', 'Credentials'),
      win32.join(roaming, 'Microsoft', 'Protect'),
      win32.join(roaming, 'Microsoft', 'SystemCertificates', 'My', 'Keys'),
      win32.join(roaming, 'Mozilla'),
      ...PRIVATE_APP_DATA_DIRECTORY_NAMES.map(name => win32.join(roaming, name))
    ] : []),
    ...(local ? [
      win32.join(local, 'Microsoft', 'Credentials'),
      win32.join(local, 'Microsoft', 'Vault'),
      win32.join(local, 'Google', 'Chrome', 'User Data'),
      win32.join(local, 'Microsoft', 'Edge', 'User Data'),
      win32.join(local, 'Mozilla'),
      ...PRIVATE_APP_DATA_DIRECTORY_NAMES.map(name => win32.join(local, name))
    ] : []),
    ...(profile ? [
      win32.join(profile, '.ssh'),
      win32.join(profile, '.gnupg'),
      win32.join(profile, '.aws'),
      win32.join(profile, '.azure'),
      win32.join(profile, '.kube'),
      win32.join(profile, '.docker'),
      win32.join(profile, 'NTUSER.DAT')
    ] : [])
  ];
  return [...new Set(candidates.flatMap(candidate => (
    typeof candidate === 'string' && win32.isAbsolute(candidate)
      ? [win32.normalize(candidate).replace(/[\\/]+$/u, '').toLocaleLowerCase('en-US')]
      : []
  )))];
}

function protectedWindowsProfilesRoots(environment: NodeJS.ProcessEnv): string[] {
  const profile = environment.USERPROFILE;
  if (!profile || !win32.isAbsolute(profile)) return [];
  return [win32.dirname(win32.normalize(profile)).toLocaleLowerCase('en-US')];
}

function assertNotProtected(
  candidate: string,
  protectedRoots: readonly string[],
  protectedProfilesRoots: readonly string[]
): void {
  const normalized = win32.normalize(candidate).replace(/[\\/]+$/u, '')
    .toLocaleLowerCase('en-US');
  const hasSensitiveBasename = normalized.split(/[\\/]+/u)
    .some(segment => SENSITIVE_PATH_BASENAMES.has(segment));
  const hasPrivateUserProfilePath = protectedProfilesRoots.some(profilesRoot => {
    const relation = win32.relative(profilesRoot, normalized);
    if (
      relation === ''
      || relation === '..'
      || relation.startsWith('..\\')
      || win32.isAbsolute(relation)
    ) return false;
    const [, ...profileRelativeSegments] = relation.split('\\');
    const profileRelativePath = profileRelativeSegments.join('\\');
    return PRIVATE_USER_PROFILE_RELATIVE_ROOTS.some(privateRoot => {
      const privateRelation = win32.relative(privateRoot, profileRelativePath);
      return privateRelation === '' || (
        privateRelation !== '..'
        && !privateRelation.startsWith('..\\')
        && !win32.isAbsolute(privateRelation)
      );
    });
  });
  const protectedPath = hasSensitiveBasename || hasPrivateUserProfilePath || protectedRoots.some(root => {
    const relation = win32.relative(root, normalized);
    return relation === '' || (
      relation !== '..'
      && !relation.startsWith('..\\')
      && !win32.isAbsolute(relation)
    );
  });
  if (protectedPath) {
    throw new FileToolError('PERMISSION_DENIED', '受保护区域不能作为文件授权范围');
  }
}

export class PathPolicy {
  private constructor(
    private readonly rootReal: string,
    private readonly protectedRoots: readonly string[],
    private readonly protectedProfilesRoots: readonly string[]
  ) {}

  static async create(root: string): Promise<PathPolicy> {
    if (!isAbsolute(root) || !win32.isAbsolute(root)) {
      throw new FileToolError('PATH_INVALID', '授权根目录必须是绝对路径');
    }

    let rootReal: string;
    try {
      rootReal = await realpath(root);
      if (!(await lstat(rootReal)).isDirectory()) {
        throw new FileToolError('ENTRY_TYPE_UNSUPPORTED', '授权根路径不是目录');
      }
    } catch (error) {
      throw mapFileSystemError(error, '授权根目录不存在');
    }
    const protectedRoots = protectedWindowsRoots(process.env);
    const protectedProfilesRoots = protectedWindowsProfilesRoots(process.env);
    assertNotProtected(rootReal, protectedRoots, protectedProfilesRoots);
    return new PathPolicy(rootReal, protectedRoots, protectedProfilesRoots);
  }

  async resolveExisting(input: string): Promise<string> {
    const normalized = normalizeRelativePath(input);
    assertNotProtected(
      join(this.rootReal, normalized),
      this.protectedRoots,
      this.protectedProfilesRoots
    );
    await assertNoLinks(this.rootReal, normalized);

    let candidateReal: string;
    try {
      candidateReal = await realpath(join(this.rootReal, normalized));
    } catch (error) {
      throw mapFileSystemError(error, '条目不存在');
    }
    assertInside(this.rootReal, candidateReal);
    assertNotProtected(candidateReal, this.protectedRoots, this.protectedProfilesRoots);
    return candidateReal;
  }

  async resolveTarget(input: string): Promise<string> {
    const normalized = normalizeRelativePath(input);
    const name = parse(normalized).base;
    if (!name || normalized === '.') {
      throw new FileToolError('PATH_INVALID', '目标路径无效');
    }
    assertNotProtected(
      join(this.rootReal, normalized),
      this.protectedRoots,
      this.protectedProfilesRoots
    );

    const parent = dirname(normalized);
    await assertNoLinks(this.rootReal, parent);

    let parentReal: string;
    try {
      parentReal = await realpath(join(this.rootReal, parent));
      if (!(await lstat(parentReal)).isDirectory()) {
        throw new FileToolError('ENTRY_TYPE_UNSUPPORTED', '目标父路径不是目录');
      }
    } catch (error) {
      throw mapFileSystemError(error, '目标父目录不存在');
    }
    assertInside(this.rootReal, parentReal);

    const target = join(parentReal, name);
    assertNotProtected(target, this.protectedRoots, this.protectedProfilesRoots);
    try {
      await lstat(target);
      throw new FileToolError('TARGET_EXISTS', '目标已经存在');
    } catch (error) {
      if (error instanceof FileToolError) throw error;
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw mapFileSystemError(error, '无法检查目标路径');
      }
    }
    return target;
  }
}
