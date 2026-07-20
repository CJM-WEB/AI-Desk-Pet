import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import { SettingsStore } from '../src/main/storage/settings-store';

const temporaryDirectories: string[] = [];

async function createStore(hasStoredSecret = false) {
  const directory = await mkdtemp(join(tmpdir(), 'myself-settings-'));
  temporaryDirectories.push(directory);
  const file = join(directory, 'settings.json');
  return {
    directory,
    file,
    store: new SettingsStore(file, async () => hasStoredSecret)
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('SettingsStore', () => {
  test('首次读取返回版本化的安全默认值', async () => {
    const { store } = await createStore();

    await expect(store.getPublic()).resolves.toEqual({
      version: 1,
      provider: null,
      authorizedRoot: null,
      petPosition: null,
      fileDisclosureAccepted: false
    });
  });

  test('原子保存提供商元数据且绝不把密钥写入设置文件', async () => {
    const fixtureSecret = 'sk-task-five-fixture-never-persist';
    const { file, store } = await createStore(true);

    await store.saveProviderMetadata({
      id: 'openai-compatible',
      displayName: 'OpenAI Compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model',
      secret: fixtureSecret
    });

    const serialized = await readFile(file, 'utf8');
    expect(serialized).toContain('"version": 1');
    expect(serialized).not.toContain(fixtureSecret);
    await expect(store.getPublic()).resolves.toEqual(expect.objectContaining({
      provider: {
        id: 'openai-compatible',
        displayName: 'OpenAI Compatible',
        baseUrl: 'https://api.example.com/v1',
        model: 'example-model',
        hasStoredSecret: true
      }
    }));
  });

  test('授权目录完整路径仅在 Main 存储中可读', async () => {
    const { store } = await createStore();

    await store.saveAuthorizedRoot({
      id: 'root-1',
      displayName: '工作目录',
      pathHint: 'D:\\…\\project',
      absolutePath: 'D:\\private\\project'
    });

    await expect(store.getPublic()).resolves.toEqual(expect.objectContaining({
      authorizedRoot: {
        id: 'root-1',
        displayName: '工作目录',
        pathHint: 'D:\\…\\project'
      }
    }));
    await expect(store.getAuthorizedRootPath()).resolves.toBe('D:\\private\\project');
  });

  test('损坏设置被隔离并回退到安全默认值', async () => {
    const { directory, file, store } = await createStore();
    await writeFile(file, '{broken-json', 'utf8');

    await expect(store.getPublic()).resolves.toEqual(expect.objectContaining({
      version: 1,
      provider: null
    }));
    const files = await readdir(directory);
    expect(files.some(name => name.startsWith('settings.json.corrupt-'))).toBe(true);
  });

  test('清除全部设置会移除 Provider、授权目录和窗口状态', async () => {
    const { store } = await createStore(true);
    await store.saveProviderMetadata({
      id: 'default',
      displayName: '示例服务',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model'
    });
    await store.saveAuthorizedRoot({
      id: 'root-1',
      displayName: '工作目录',
      pathHint: 'D:\\…\\project',
      absolutePath: 'D:\\private\\project'
    });

    await store.clearAll();

    await expect(store.getPublic()).resolves.toEqual({
      version: 1,
      provider: null,
      authorizedRoot: null,
      petPosition: null,
      fileDisclosureAccepted: false
    });
    await expect(store.getAuthorizedRootPath()).resolves.toBeNull();
  });
});
