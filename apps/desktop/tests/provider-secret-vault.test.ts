import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMain } from 'electron';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { registerSettingsIpc } from '../src/main/ipc/register-ipc';
import {
  SecretStore,
  type SecretEncryptionAdapter
} from '../src/main/storage/secret-store';
import { ipcChannels } from '../src/shared/ipc-channels';

const temporaryDirectories: string[] = [];

function 槽文件路径(file: string, profileId: string): string {
  const digest = createHash('sha256').update(profileId).digest('hex');
  return join(`${file}.profiles`, `${digest}.bin`);
}

function 加密适配器(options?: { failEncryptOnce?: boolean }): SecretEncryptionAdapter {
  let shouldFail = options?.failEncryptOnce ?? false;
  return {
    isEncryptionAvailable: () => true,
    encryptString: async value => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('ENCRYPTION_FAILED');
      }
      return Buffer.from(`encrypted:${value}`, 'utf8');
    },
    decryptString: async value => value.toString('utf8').replace(/^encrypted:/, '')
  };
}

async function 创建密钥库(adapter = 加密适配器()) {
  const directory = await mkdtemp(join(tmpdir(), 'myself-provider-vault-'));
  temporaryDirectories.push(directory);
  const file = join(directory, 'provider-secret.bin');
  return { file, store: new SecretStore(file, adapter) };
}

function 创建IpcMain() {
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>();
  const ipcMain = {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: (event: unknown, input?: unknown) => unknown) => (
      handlers.set(channel, handler)
    )
  } as unknown as IpcMain;
  return { handlers, ipcMain };
}

function 公开设置(hasStoredSecret: boolean) {
  return {
    version: 1 as const,
    provider: {
      id: 'default',
      displayName: '示例服务',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model',
      hasStoredSecret
    },
    authorizedRoot: null,
    petPosition: null,
    fileDisclosureAccepted: false
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('按档案隔离的密钥库', () => {
  test('不同档案不能读取对方密钥，槽文件使用安全摘要名称', async () => {
    const { file, store } = await 创建密钥库();
    const 危险档案Id = '../alpha:profile';

    await store.save(危险档案Id, 'sk-alpha', true);
    await store.save('beta', 'sk-beta', false);

    await expect(store.readForProviderCall(危险档案Id)).resolves.toBe('sk-alpha');
    await expect(store.readForProviderCall('beta')).resolves.toBe('sk-beta');
    await expect(store.readForProviderCall('other')).rejects.toThrow('SECRET_NOT_FOUND');
    expect(await readdir(`${file}.profiles`)).toEqual([
      `${createHash('sha256').update(危险档案Id).digest('hex')}.bin`
    ]);
    await expect(readFile(槽文件路径(file, 危险档案Id))).resolves.toEqual(
      Buffer.from('encrypted:sk-alpha')
    );
  });

  test('替换一个档案的持久化和会话密钥不会影响其他档案', async () => {
    const { store } = await 创建密钥库();
    await store.save('alpha', 'sk-alpha-persistent', true);
    await store.save('beta', 'sk-beta-session', false);

    await store.save('alpha', 'sk-alpha-session', false);
    await expect(store.readForProviderCall('alpha')).resolves.toBe('sk-alpha-session');
    await expect(store.readForProviderCall('beta')).resolves.toBe('sk-beta-session');

    await store.save('beta', 'sk-beta-persistent', true);
    await expect(store.readForProviderCall('alpha')).resolves.toBe('sk-alpha-session');
    await expect(store.readForProviderCall('beta')).resolves.toBe('sk-beta-persistent');
  });

  test('清除单个档案不会清除其他档案，全部清除才移除所有密钥', async () => {
    const { file, store } = await 创建密钥库();
    const providerSlotFile = 槽文件路径(file, 'provider-main');
    const mcpSlotFile = 槽文件路径(file, 'mcp:remote-tools');
    await store.save('provider-main', 'provider-secret', true);
    await store.save('mcp:remote-tools', 'mcp-secret', true);
    await store.save('beta', 'sk-beta-session', false);
    const beforeMcpSlot = await readFile(mcpSlotFile);

    await store.clear('provider-main');

    const afterMcpSlot = await readFile(mcpSlotFile);
    expect(afterMcpSlot.equals(beforeMcpSlot)).toBe(true);
    await expect(store.readForProviderCall('provider-main')).rejects.toThrow('SECRET_NOT_FOUND');
    await expect(store.readForProviderCall('mcp:remote-tools')).resolves.toBe('mcp-secret');
    await expect(store.readForProviderCall('beta')).resolves.toBe('sk-beta-session');

    await store.save('provider-main', 'provider-secret-restored', true);
    await expect(readFile(providerSlotFile)).resolves.toBeInstanceOf(Buffer);
    await expect(readFile(mcpSlotFile)).resolves.toBeInstanceOf(Buffer);
    await store.clearAll();
    await expect(readFile(providerSlotFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(mcpSlotFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.hasStoredSecret('beta')).resolves.toBe(false);
    await expect(store.readForProviderCall('beta')).rejects.toThrow('SECRET_NOT_FOUND');
  });

  test('默认档案首次读取时原子迁移旧密钥文件，且不写入明文', async () => {
    const { file, store } = await 创建密钥库();
    await writeFile(file, Buffer.from('encrypted:sk-legacy', 'utf8'));

    await expect(store.readForProviderCall('default')).resolves.toBe('sk-legacy');
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(槽文件路径(file, 'default'))).resolves.toEqual(
      Buffer.from('encrypted:sk-legacy')
    );
  });

  test('旧密钥迁移失败时保留旧文件并继续读取', async () => {
    const { file, store } = await 创建密钥库();
    await writeFile(file, Buffer.from('encrypted:sk-legacy', 'utf8'));
    await writeFile(`${file}.profiles`, '阻止创建槽目录');

    await expect(store.readForProviderCall('default')).resolves.toBe('sk-legacy');
    await expect(readFile(file)).resolves.toEqual(Buffer.from('encrypted:sk-legacy'));
  });

  test('空白档案标识返回稳定错误，失败队列不会阻塞后续写入', async () => {
    const { store } = await 创建密钥库(加密适配器({ failEncryptOnce: true }));

    await expect(store.save('   ', 'sk-invalid', true)).rejects.toThrow('INVALID_PROFILE_ID');
    await expect(store.save('alpha', 'sk-failed', true)).rejects.toThrow('ENCRYPTION_FAILED');
    await expect(store.save('beta', 'sk-after-failure', true)).resolves.toBeUndefined();
    await expect(store.readForProviderCall('beta')).resolves.toBe('sk-after-failure');
  });

  test('重叠入队的跨档案保存和清除不会留下临时文件或互相覆盖', async () => {
    const { file, store } = await 创建密钥库();

    await Promise.all([
      store.save('alpha', 'sk-alpha-old', true),
      store.save('beta', 'sk-beta', true),
      store.clear('alpha'),
      store.save('alpha', 'sk-alpha-final', true)
    ]);

    await expect(store.readForProviderCall('alpha')).resolves.toBe('sk-alpha-final');
    await expect(store.readForProviderCall('beta')).resolves.toBe('sk-beta');
    expect(await readdir(`${file}.profiles`)).toEqual(expect.arrayContaining([
      `${createHash('sha256').update('alpha').digest('hex')}.bin`,
      `${createHash('sha256').update('beta').digest('hex')}.bin`
    ]));
    const entries = await readdir(`${file}.profiles`);
    expect(entries.some(name => name.endsWith('.tmp'))).toBe(false);
  });
});

describe('密钥 IPC 边界', () => {
  test('保存和单槽清除传递档案标识，回包不泄漏密钥', async () => {
    const { handlers, ipcMain } = 创建IpcMain();
    const settings = {
      getPublic: vi.fn(async () => 公开设置(true)),
      saveProviderMetadata: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    const secrets = {
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    };
    registerSettingsIpc(ipcMain, settings, secrets);

    const result = await handlers.get(ipcChannels.settingsSaveProvider)?.({}, {
      profileId: 'alpha',
      displayName: '示例服务',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model',
      secret: 'sk-ipc-secret',
      persistSecret: true
    });
    await handlers.get(ipcChannels.settingsClearLocalData)?.({}, {
      scope: 'secret',
      profileId: 'provider-main'
    });

    expect(secrets.save).toHaveBeenCalledWith('alpha', 'sk-ipc-secret', true);
    expect(secrets.clear).toHaveBeenCalledWith('provider-main');
    expect(secrets.clearAll).not.toHaveBeenCalled();
    expect(settings.clearAll).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('sk-ipc-secret');
  });
});
