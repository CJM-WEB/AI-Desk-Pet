import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PathPolicy } from '../src/path-policy';

const temporaryRoots: string[] = [];

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

async function createFixture() {
  const root = await createTemporaryDirectory('myself-policy-');
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'a.txt'), 'hello', 'utf8');
  return { root, policy: await PathPolicy.create(root) };
}

async function createDirectoryLink(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async root => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('PathPolicy.create', () => {
  it('拒绝相对授权根目录', async () => {
    await expect(PathPolicy.create('relative-root')).rejects.toMatchObject({
      code: 'PATH_INVALID'
    });
  });

  it('拒绝不是目录的授权根路径', async () => {
    const root = await createTemporaryDirectory('myself-policy-file-');
    const file = join(root, 'root.txt');
    await writeFile(file, 'not a directory', 'utf8');

    await expect(PathPolicy.create(file)).rejects.toMatchObject({
      code: 'ENTRY_TYPE_UNSUPPORTED'
    });
  });
});

describe('PathPolicy.resolveExisting', () => {
  it('解析授权根目录内已存在的路径', async () => {
    const { policy, root } = await createFixture();

    await expect(policy.resolveExisting('docs/a.txt')).resolves.toBe(
      await realpath(join(root, 'docs', 'a.txt'))
    );
  });

  it('允许使用点号表示授权根目录', async () => {
    const { policy, root } = await createFixture();

    await expect(policy.resolveExisting('.')).resolves.toBe(await realpath(root));
  });

  it.each([
    '',
    '../outside.txt',
    'docs/../../outside.txt',
    'C:/Windows/system.ini',
    'C:\\Windows\\system.ini',
    '\\\\server\\share\\x',
    '\\\\?\\C:\\Windows\\system.ini',
    'docs/\0secret.txt'
  ])('拒绝不安全输入 %j', async relativePath => {
    const { policy } = await createFixture();

    await expect(policy.resolveExisting(relativePath)).rejects.toMatchObject({
      code: 'PATH_INVALID'
    });
  });

  it('为不存在的条目返回稳定错误', async () => {
    const { policy } = await createFixture();

    await expect(policy.resolveExisting('docs/missing.txt')).rejects.toMatchObject({
      code: 'ENTRY_NOT_FOUND'
    });
  });

  it('拒绝通过目录链接逃出授权根目录', async () => {
    const { policy, root } = await createFixture();
    const outside = await createTemporaryDirectory('myself-policy-outside-');
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await createDirectoryLink(outside, join(root, 'outside-link'));

    await expect(policy.resolveExisting('outside-link/secret.txt')).rejects.toMatchObject({
      code: 'LINK_NOT_ALLOWED'
    });
  });

  it('拒绝指向授权根目录内部的目录链接', async () => {
    const { policy, root } = await createFixture();
    await createDirectoryLink(join(root, 'docs'), join(root, 'docs-link'));

    await expect(policy.resolveExisting('docs-link/a.txt')).rejects.toMatchObject({
      code: 'LINK_NOT_ALLOWED'
    });
  });

  it('不会把相似前缀的同级目录视为授权子目录', async () => {
    const parent = await createTemporaryDirectory('myself-policy-prefix-');
    const root = join(parent, 'work');
    const sibling = join(parent, 'workspace-other');
    await mkdir(root);
    await mkdir(sibling);
    await writeFile(join(sibling, 'secret.txt'), 'secret', 'utf8');
    await createDirectoryLink(sibling, join(root, 'sibling-link'));
    const policy = await PathPolicy.create(root);

    expect(relative(root, sibling)).not.toBe('');
    await expect(policy.resolveExisting('sibling-link/secret.txt')).rejects.toMatchObject({
      code: 'LINK_NOT_ALLOWED'
    });
  });
});

describe('PathPolicy.resolveTarget', () => {
  it('解析父目录已存在的新目标', async () => {
    const { policy, root } = await createFixture();
    const target = await policy.resolveTarget('docs/new.txt');

    expect(target).toBe(join(await realpath(join(root, 'docs')), 'new.txt'));
    expect(isAbsolute(target)).toBe(true);
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('要求目标父目录存在', async () => {
    const { policy } = await createFixture();

    await expect(policy.resolveTarget('missing/new.txt')).rejects.toMatchObject({
      code: 'ENTRY_NOT_FOUND'
    });
  });

  it('拒绝将文件作为目标父目录', async () => {
    const { policy } = await createFixture();

    await expect(policy.resolveTarget('docs/a.txt/new.txt')).rejects.toMatchObject({
      code: 'ENTRY_TYPE_UNSUPPORTED'
    });
  });

  it('拒绝已经存在的目标', async () => {
    const { policy } = await createFixture();

    await expect(policy.resolveTarget('docs/a.txt')).rejects.toMatchObject({
      code: 'TARGET_EXISTS'
    });
  });

  it('拒绝以目录链接作为目标父目录', async () => {
    const { policy, root } = await createFixture();
    const outside = await createTemporaryDirectory('myself-policy-target-outside-');
    await createDirectoryLink(outside, join(root, 'target-link'));

    await expect(policy.resolveTarget('target-link/new.txt')).rejects.toMatchObject({
      code: 'LINK_NOT_ALLOWED'
    });
  });
});
