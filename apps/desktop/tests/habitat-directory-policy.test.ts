import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  HabitatDirectoryPolicy,
  type HabitatDirectoryPolicyErrorCode
} from '../src/main/habitat/habitat-directory-policy';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), `.${name}`));
  temporaryDirectories.push(directory);
  return directory;
}

function expectPolicyError(
  promise: Promise<unknown>,
  code: HabitatDirectoryPolicyErrorCode
): Promise<void> {
  return expect(promise).rejects.toMatchObject({ message: code });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('HabitatDirectoryPolicy', () => {
  test('授权现存普通目录并仅以末级目录名生成有界公开提示', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-policy-');
    const target = join(directory, `${'很长目录'.repeat(40)}-project`);
    await mkdir(target);
    const policy = new HabitatDirectoryPolicy({
      userDataPath: join(directory, 'user-data'),
      characterStoragePath: join(directory, 'characters')
    });

    const record = await policy.authorize(target);

    expect(record.id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u);
    expect(record.absolutePath).toBe(await realpath(target));
    expect(record.identity.dev).toBeTypeOf('number');
    expect(record.identity.ino).toBeTypeOf('number');
    expect(record.displayName.length).toBeLessThanOrEqual(80);
    expect(record.pathHint.length).toBeLessThanOrEqual(80);
    expect(record.pathHint).not.toContain(dirname(target));
    expect(record.enabled).toBe(true);
    expect(await policy.availability(record)).toBe('available');
  });

  test('相同真实目录不能重复添加但名称前缀碰撞不视为同目录', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-duplicate-');
    const project = join(directory, 'project');
    const projectBackup = join(directory, 'project-backup');
    await mkdir(project);
    await mkdir(projectBackup);
    const policy = new HabitatDirectoryPolicy({
      userDataPath: join(directory, 'user-data'),
      characterStoragePath: join(directory, 'characters')
    });
    const first = await policy.authorize(project);

    await expectPolicyError(
      policy.authorize(project, [first]),
      'HABITAT_DIRECTORY_DUPLICATE'
    );
    await expect(policy.authorize(projectBackup, [first])).resolves.toMatchObject({
      displayName: 'project-backup',
      pathHint: 'project-backup'
    });
  });

  test('拒绝文件系统根、受保护配置根和 UNC 路径', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-blocked-');
    const userData = join(directory, 'user-data');
    const characters = join(directory, 'characters');
    await mkdir(userData);
    await mkdir(characters);
    const policy = new HabitatDirectoryPolicy({
      userDataPath: userData,
      characterStoragePath: characters
    });

    await expectPolicyError(policy.authorize(parse(directory).root), 'HABITAT_DIRECTORY_PROTECTED');
    await expectPolicyError(policy.authorize(userData), 'HABITAT_DIRECTORY_PROTECTED');
    await expectPolicyError(policy.authorize(characters), 'HABITAT_DIRECTORY_PROTECTED');
    await expectPolicyError(
      policy.authorize('\\\\server\\share\\pet-home'),
      'HABITAT_DIRECTORY_UNSUPPORTED'
    );
  });

  test.each(['network', 'removable', 'cloud-placeholder'] as const)(
    '拒绝首版不支持的 %s 存储类型',
    async storageKind => {
      const directory = await createTemporaryDirectory('ai-pet-habitat-storage-kind-');
      const target = join(directory, 'target');
      await mkdir(target);
      const policy = new HabitatDirectoryPolicy({
        userDataPath: join(directory, 'user-data'),
        characterStoragePath: join(directory, 'characters')
      }, {
        inspectStorage: async () => storageKind
      });

      await expectPolicyError(
        policy.authorize(target),
        'HABITAT_DIRECTORY_UNSUPPORTED'
      );
    }
  );

  test('拒绝符号链接或 Junction 且不读取或修改链接目标内容', async ({ skip }) => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-link-');
    const target = join(directory, 'target');
    const linked = join(directory, 'linked');
    const marker = join(target, 'marker.txt');
    await mkdir(target);
    await writeFile(marker, '不可修改', 'utf8');
    try {
      await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : '';
      if (code === 'EPERM' || code === 'EACCES') {
        skip();
        return;
      }
      throw error;
    }
    const policy = new HabitatDirectoryPolicy({
      userDataPath: join(directory, 'user-data'),
      characterStoragePath: join(directory, 'characters')
    });

    await expectPolicyError(policy.authorize(linked), 'HABITAT_DIRECTORY_UNSAFE');
    expect(await readFile(marker, 'utf8')).toBe('不可修改');
  });

  test('目录被替换、删除或权限拒绝后不再继续信任', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-replaced-');
    const target = join(directory, 'target');
    await mkdir(target);
    const roots = {
      userDataPath: join(directory, 'user-data'),
      characterStoragePath: join(directory, 'characters')
    };
    const policy = new HabitatDirectoryPolicy(roots);
    const record = await policy.authorize(target);
    await rm(target, { recursive: true });
    await mkdir(target);

    expect(await policy.availability(record)).toBe('unavailable');
    await rm(target, { recursive: true });
    expect(await policy.availability(record)).toBe('unavailable');

    const denied = new HabitatDirectoryPolicy(roots, {
      realpathPath: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
    });
    expect(await denied.availability(record)).toBe('unavailable');
  });

  test('realpath、lstat、stat 两次检查之间身份变化时拒绝授权', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-race-');
    const target = join(directory, 'target');
    await mkdir(target);
    let replaced = false;
    const policy = new HabitatDirectoryPolicy({
      userDataPath: join(directory, 'user-data'),
      characterStoragePath: join(directory, 'characters')
    }, {
      onCheckpoint: async checkpoint => {
        if (checkpoint !== 'after-first-inspection' || replaced) return;
        replaced = true;
        await rm(target, { recursive: true });
        await mkdir(target);
      }
    });

    await expectPolicyError(policy.authorize(target), 'HABITAT_DIRECTORY_CHANGED');
  });

  test('不同真实路径复用同一目录身份时按身份冲突失败关闭', async () => {
    const directory = await createTemporaryDirectory('ai-pet-habitat-identity-');
    const firstPath = join(directory, 'first');
    const secondPath = join(directory, 'second');
    await mkdir(firstPath);
    await mkdir(secondPath);
    const policy = new HabitatDirectoryPolicy({
      userDataPath: join(directory, 'user-data'),
      characterStoragePath: join(directory, 'characters')
    });
    const first = await policy.authorize(firstPath);
    const second = await policy.authorize(secondPath);

    await expectPolicyError(policy.authorize(secondPath, [{
      ...first,
      identity: second.identity
    }]), 'HABITAT_DIRECTORY_IDENTITY_CONFLICT');
  });
});
