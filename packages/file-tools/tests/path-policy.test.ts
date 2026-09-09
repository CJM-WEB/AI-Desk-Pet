import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, win32 } from 'node:path';
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

  it.runIf(process.platform === 'win32')('拒绝 Windows 系统目录作为授权根', async () => {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    expect(systemRoot).toBeTruthy();
    await expect(PathPolicy.create(systemRoot!)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED'
    });
  });
});

describe.runIf(process.platform === 'win32')('PathPolicy 受保护子目录', () => {
  it('磁盘根授权也不能访问 Windows 系统目录', async () => {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    expect(systemRoot).toBeTruthy();
    const driveRoot = win32.parse(systemRoot!).root;
    const policy = await PathPolicy.create(driveRoot);

    await expect(policy.resolveExisting(win32.relative(driveRoot, systemRoot!)))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('个人目录授权仍拒绝常见凭据和 Agent 私有路径', async () => {
    const profile = process.env.USERPROFILE;
    expect(profile).toBeTruthy();
    const policy = await PathPolicy.create(profile!);

    for (const relativePath of ['.codex', '.npmrc', '.git-credentials']) {
      await expect(policy.resolveTarget(relativePath))
        .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
  });

  it('应用数据父目录授权仍拒绝浏览器配置和桌宠私有目录', async () => {
    const roaming = process.env.APPDATA;
    const local = process.env.LOCALAPPDATA;
    expect(roaming).toBeTruthy();
    expect(local).toBeTruthy();

    const roamingPolicy = await PathPolicy.create(roaming!);
    const localPolicy = await PathPolicy.create(local!);
    for (const relativePath of ['Mozilla', 'AI Pet', '@myself']) {
      await expect(roamingPolicy.resolveTarget(relativePath))
        .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(localPolicy.resolveTarget(relativePath))
        .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
  });

  it.each([
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
    win32.join('AppData', 'Local', 'AI Pet'),
    win32.join('AppData', 'Local', '@myself'),
    win32.join('AppData', 'Roaming', 'AI Pet'),
    win32.join('AppData', 'Roaming', '@myself')
  ])('用户目录父级授权也拒绝其他用户的私有路径 %s', async privatePath => {
    const profile = process.env.USERPROFILE;
    expect(profile).toBeTruthy();
    const profilesRoot = win32.dirname(profile!);
    const otherProfile = win32.join(profilesRoot, '__ai_pet_other_user__');
    const policy = await PathPolicy.create(profilesRoot);

    await expect(policy.resolveTarget(
      win32.relative(profilesRoot, win32.join(otherProfile, privatePath))
    )).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it.each([
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
    win32.join('AppData', 'Local', 'AI Pet'),
    win32.join('AppData', 'Local', '@myself'),
    win32.join('AppData', 'Roaming', 'AI Pet'),
    win32.join('AppData', 'Roaming', '@myself')
  ])('磁盘根授权也拒绝其他用户的私有路径 %s', async privatePath => {
    const profile = process.env.USERPROFILE;
    expect(profile).toBeTruthy();
    const profilesRoot = win32.dirname(profile!);
    const driveRoot = win32.parse(profilesRoot).root;
    const otherProfile = win32.join(profilesRoot, '__ai_pet_other_user__');
    const policy = await PathPolicy.create(driveRoot);

    await expect(policy.resolveTarget(
      win32.relative(driveRoot, win32.join(otherProfile, privatePath))
    )).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('不误封普通项目中的同名凭据、浏览器和应用目录', async () => {
    const root = await createTemporaryDirectory('myself-policy-same-name-');
    const sameNamePaths = [
      '.ssh',
      '.gnupg',
      '.aws',
      '.azure',
      '.kube',
      '.docker',
      'NTUSER.DAT',
      join('AppData', 'Local', 'Microsoft', 'Credentials'),
      join('AppData', 'Local', 'Microsoft', 'Vault'),
      join('AppData', 'Roaming', 'Microsoft', 'Credentials'),
      join('AppData', 'Roaming', 'Microsoft', 'Protect'),
      join('AppData', 'Roaming', 'Microsoft', 'SystemCertificates', 'My', 'Keys'),
      join('AppData', 'Local', 'Google', 'Chrome', 'User Data'),
      join('AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
      join('AppData', 'Local', 'Mozilla'),
      join('AppData', 'Roaming', 'Mozilla'),
      join('AppData', 'Local', 'AI Pet'),
      join('AppData', 'Local', '@myself')
    ];
    for (const sameNamePath of sameNamePaths) {
      await mkdir(join(root, 'project', sameNamePath), { recursive: true });
    }
    const policy = await PathPolicy.create(root);

    for (const sameNamePath of sameNamePaths) {
      await expect(policy.resolveTarget(join('project', sameNamePath, 'notes.txt')))
        .resolves.toBe(join(await realpath(join(root, 'project', sameNamePath)), 'notes.txt'));
    }
  });

  it('不误封普通项目的 .git 和普通隐藏目录', async () => {
    const root = await createTemporaryDirectory('myself-policy-hidden-');
    await mkdir(join(root, '.git'));
    await mkdir(join(root, '.hidden'));
    await writeFile(join(root, '.git', 'config'), 'repository config', 'utf8');
    await writeFile(join(root, '.hidden', 'notes.txt'), 'notes', 'utf8');
    const policy = await PathPolicy.create(root);

    await expect(policy.resolveExisting('.git/config')).resolves.toBe(
      await realpath(join(root, '.git', 'config'))
    );
    await expect(policy.resolveExisting('.hidden/notes.txt')).resolves.toBe(
      await realpath(join(root, '.hidden', 'notes.txt'))
    );
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
    'docs/a.txt::$DATA',
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

  it('拒绝用 NTFS ADS 语法创建替代数据流', async () => {
    const { policy } = await createFixture();

    await expect(policy.resolveTarget('docs/new.txt::$DATA')).rejects.toMatchObject({
      code: 'PATH_INVALID'
    });
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
