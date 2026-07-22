import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

  test('保存桌宠位置时保留其他设置', async () => {
    const { store } = await createStore(true);
    await store.saveProviderMetadata({
      id: 'default',
      displayName: '示例服务',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model'
    });

    await store.savePetPosition({ x: 320, y: 240 });

    await expect(store.getPublic()).resolves.toEqual(expect.objectContaining({
      provider: expect.objectContaining({ id: 'default' }),
      petPosition: { x: 320, y: 240 }
    }));
  });

  test('并发保存提供商与桌宠位置时不会丢失任一字段', async () => {
    const { store } = await createStore(true);
    await store.clearAll();

    await Promise.all([
      store.saveProviderMetadata({
        id: 'default',
        displayName: '示例服务',
        baseUrl: 'https://api.example.com/v1',
        model: 'example-model'
      }),
      store.savePetPosition({ x: 640, y: 480 })
    ]);

    await expect(store.getPublic()).resolves.toEqual(expect.objectContaining({
      provider: expect.objectContaining({ id: 'default' }),
      petPosition: { x: 640, y: 480 }
    }));
  });

  test('并发保存授权目录与桌宠位置时不会丢失任一字段', async () => {
    const { store } = await createStore();
    await store.clearAll();

    await Promise.all([
      store.saveAuthorizedRoot({
        id: 'root-1',
        displayName: '工作目录',
        pathHint: 'D:\\…\\project',
        absolutePath: 'D:\\private\\project'
      }),
      store.savePetPosition({ x: 720, y: 540 })
    ]);

    await expect(store.getPublic()).resolves.toEqual(expect.objectContaining({
      authorizedRoot: expect.objectContaining({ id: 'root-1' }),
      petPosition: { x: 720, y: 540 }
    }));
  });

  test('保存后紧接清除不会复活已清除的数据', async () => {
    const { store } = await createStore(true);

    const save = store.saveProviderMetadata({
      id: 'default',
      displayName: '示例服务',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model'
    });
    const clear = store.clearAll();
    await Promise.all([save, clear]);

    await expect(store.getPublic()).resolves.toEqual({
      version: 1,
      provider: null,
      authorizedRoot: null,
      petPosition: null,
      fileDisclosureAccepted: false
    });
  });

  test('一次写入失败后后续事务仍可执行', async () => {
    const { file, store } = await createStore(true);
    const temporaryFile = `${file}.tmp`;
    await mkdir(temporaryFile, { recursive: true });

    await expect(store.savePetPosition({ x: 10, y: 20 })).rejects.toBeDefined();
    await rm(temporaryFile, { recursive: true, force: true });

    await expect(store.saveProviderMetadata({
      id: 'default',
      displayName: '示例服务',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model'
    })).resolves.toBeUndefined();
    await expect(store.getPublic()).resolves.toEqual(expect.objectContaining({
      provider: expect.objectContaining({ id: 'default' }),
      petPosition: null
    }));
  });

  test('公开读取会等待此前写事务稳定', async () => {
    const { store } = await createStore();
    const save = store.saveAuthorizedRoot({
      id: 'root-1',
      displayName: '工作目录',
      pathHint: 'D:\\…\\project',
      absolutePath: 'D:\\private\\project'
    });

    const [publicSettings, authorizedRootPath] = await Promise.all([
      store.getPublic(),
      store.getAuthorizedRootPath()
    ]);
    await save;

    expect(publicSettings.authorizedRoot).toEqual({
      id: 'root-1',
      displayName: '工作目录',
      pathHint: 'D:\\…\\project'
    });
    expect(authorizedRootPath).toBe('D:\\private\\project');
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
