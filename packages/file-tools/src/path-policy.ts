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
  if (
    input.length === 0
    || input.includes('\0')
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
  }
}

export class PathPolicy {
  private constructor(private readonly rootReal: string) {}

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
    return new PathPolicy(rootReal);
  }

  async resolveExisting(input: string): Promise<string> {
    const normalized = normalizeRelativePath(input);
    await assertNoLinks(this.rootReal, normalized);

    let candidateReal: string;
    try {
      candidateReal = await realpath(join(this.rootReal, normalized));
    } catch (error) {
      throw mapFileSystemError(error, '条目不存在');
    }
    assertInside(this.rootReal, candidateReal);
    return candidateReal;
  }

  async resolveTarget(input: string): Promise<string> {
    const normalized = normalizeRelativePath(input);
    const name = parse(normalized).base;
    if (!name || normalized === '.') {
      throw new FileToolError('PATH_INVALID', '目标路径无效');
    }

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
