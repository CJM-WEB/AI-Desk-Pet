import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import {
  SecretStore,
  type SecretEncryptionAdapter
} from '../src/main/storage/secret-store';

const temporaryDirectories: string[] = [];

function fakeEncryptionAdapter(available = true): SecretEncryptionAdapter {
  return {
    isEncryptionAvailable: () => available,
    encryptString: async value => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: async value => value.toString('utf8').replace(/^encrypted:/, '')
  };
}

async function createStore(available = true) {
  const directory = await mkdtemp(join(tmpdir(), 'myself-secret-'));
  temporaryDirectories.push(directory);
  const file = join(directory, 'provider-secret.bin');
  return {
    file,
    store: new SecretStore(file, fakeEncryptionAdapter(available))
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('SecretStore', () => {
  test('持久化时只把加密字节写入磁盘', async () => {
    const fixtureSecret = 'sk-persistent-fixture';
    const { file, store } = await createStore();

    await store.save(fixtureSecret, true);

    expect((await readFile(file)).toString('utf8')).toBe(`encrypted:${fixtureSecret}`);
    await expect(store.readForProviderCall()).resolves.toBe(fixtureSecret);
    await expect(store.hasStoredSecret()).resolves.toBe(true);
  });

  test('仅会话密钥不写入磁盘', async () => {
    const { file, store } = await createStore(false);

    await store.save('sk-session-fixture', false);

    await expect(store.readForProviderCall()).resolves.toBe('sk-session-fixture');
    await expect(store.hasStoredSecret()).resolves.toBe(true);
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('改为仅会话存储时删除以前持久化的密文', async () => {
    const { file, store } = await createStore();
    await store.save('sk-old-persistent', true);

    await store.save('sk-current-session', false);

    await expect(store.readForProviderCall()).resolves.toBe('sk-current-session');
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('系统加密不可用时拒绝持久化并返回稳定错误', async () => {
    const { store } = await createStore(false);

    await expect(store.save('sk-rejected-fixture', true)).rejects.toThrow(
      'SECRET_STORAGE_UNAVAILABLE'
    );
  });

  test('清除后内存和磁盘密钥都不可读取', async () => {
    const { store } = await createStore();
    await store.save('sk-clear-fixture', true);
    await store.save('sk-session-fixture', false);

    await store.clear();

    await expect(store.hasStoredSecret()).resolves.toBe(false);
    await expect(store.readForProviderCall()).rejects.toThrow('SECRET_NOT_FOUND');
  });
});
