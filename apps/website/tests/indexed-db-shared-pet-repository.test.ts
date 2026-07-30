import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IndexedDbSharedPetRepository,
  SharedPetRepositoryError,
  SHARED_PET_FILES_STORE,
  SHARED_PET_METADATA_STORE
} from '../components/website-experience/community/indexed-db-shared-pet-repository';

const databaseName = 'ai-pet-community-test';

function validInput(index = 1) {
  return {
    name: `Pet ${index}`,
    description: `Shared package ${index}`,
    packageFile: new File([`zip-${index}`], `pet-${index}.zip`, { type: 'application/zip' }),
    coverFile: new File([`cover-${index}`], `cover-${index}.webp`, { type: 'image/webp' })
  };
}

function deleteDatabase(name = databaseName): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`数据库仍被占用：${name}`));
  });
}

function createRepository(options: {
  databaseName?: string;
  now?: () => string;
} = {}) {
  let nextId = 0;
  return new IndexedDbSharedPetRepository({
    databaseName: options.databaseName ?? databaseName,
    createId: () => `pet-${++nextId}`,
    now: options.now ?? (() => '2026-07-30T00:00:00.000Z')
  });
}

async function repositoryWithEntries(count: number) {
  let index = 0;
  const repository = createRepository({
    now: () => `2026-07-30T00:00:${String(++index).padStart(2, '0')}.000Z`
  });
  for (let item = 1; item <= count; item += 1) {
    await repository.create(validInput(item));
  }
  return repository;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteDatabase();
});

describe('IndexedDB 共享仓库', () => {
  it('在升级事务中创建元数据和文件对象仓库，并在同一读写事务保存投稿', async () => {
    const repository = createRepository();
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
    await repository.create(validInput());

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    expect(database.objectStoreNames.contains(SHARED_PET_METADATA_STORE)).toBe(true);
    expect(database.objectStoreNames.contains(SHARED_PET_FILES_STORE)).toBe(true);
    expect(transaction).toHaveBeenCalledWith(
      [SHARED_PET_METADATA_STORE, SHARED_PET_FILES_STORE],
      'readwrite'
    );
    database.close();
    expect((await repository.listPage(1, 8)).items[0]?.id).toBe('pet-1');
    expect((await repository.getDownload('pet-1')).file.size).toBeGreaterThan(0);
  });

  it('按创建时间倒序分页且列表项不包含 ZIP Blob', async () => {
    const repository = await repositoryWithEntries(9);

    const first = await repository.listPage(1, 8);
    const second = await repository.listPage(2, 8);

    expect(first.items).toHaveLength(8);
    expect(first.items[0]?.id).toBe('pet-9');
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).toBe('pet-1');
    expect(first).toMatchObject({
      page: 1,
      pageSize: 8,
      total: 9,
      totalPages: 2,
      hasPrevious: false,
      hasNext: true
    });
    expect('packageFile' in first.items[0]!).toBe(false);
  });

  it('详情读取只访问元数据仓库', async () => {
    const repository = createRepository();
    await repository.create(validInput());
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');

    expect((await repository.getById('pet-1'))?.name).toBe('Pet 1');
    expect(transaction).toHaveBeenCalledWith(SHARED_PET_METADATA_STORE, 'readonly');
    expect(transaction).not.toHaveBeenCalledWith(SHARED_PET_FILES_STORE, expect.anything());
  });

  it('只在下载请求时读取 ZIP Blob', async () => {
    const repository = createRepository();
    await repository.create(validInput());
    const originalTransaction = IDBDatabase.prototype.transaction;
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');

    await repository.listPage(1, 8);
    expect(transaction).not.toHaveBeenCalledWith(SHARED_PET_FILES_STORE, expect.anything());

    await repository.getDownload('pet-1');
    expect(transaction).toHaveBeenCalledWith(SHARED_PET_FILES_STORE, 'readonly');
    transaction.mockRestore();
    expect(IDBDatabase.prototype.transaction).toBe(originalTransaction);
  });

  it('点赞可切换且计数不会低于零', async () => {
    const repository = createRepository();
    await repository.create(validInput());

    expect((await repository.toggleLike('pet-1')).likeCount).toBe(1);
    expect((await repository.toggleLike('pet-1')).likeCount).toBe(0);
  });

  it('下载计数更新并通知当前仓库实例的订阅者', async () => {
    const repository = createRepository();
    const listener = vi.fn();
    const unsubscribe = repository.subscribe(listener);

    await repository.create(validInput());
    expect((await repository.recordDownload('pet-1')).downloadCount).toBe(1);
    unsubscribe();
    unsubscribe();
    await repository.toggleLike('pet-1');

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('不可用、打开失败和未找到的情况映射为领域错误代码', async () => {
    const unavailable = new IndexedDbSharedPetRepository({ indexedDb: null });
    await expect(unavailable.listPage(1, 8)).rejects.toMatchObject({
      code: 'INDEXED_DB_UNAVAILABLE'
    });

    const failingRequest = new EventTarget() as IDBOpenDBRequest;
    Object.defineProperty(failingRequest, 'error', {
      value: new DOMException('打开失败', 'UnknownError')
    });
    const openFailure = new IndexedDbSharedPetRepository({
      indexedDb: {
        open: () => failingRequest
      } as unknown as IDBFactory
    });
    queueMicrotask(() => failingRequest.dispatchEvent(new Event('error')));
    await expect(openFailure.listPage(1, 8)).rejects.toMatchObject({
      code: 'DATABASE_OPEN_FAILED'
    });

    const repository = createRepository();
    await expect(repository.getDownload('missing')).rejects.toMatchObject({
      code: 'PACKAGE_NOT_FOUND'
    });
    await expect(repository.getDownload('missing')).rejects.toBeInstanceOf(SharedPetRepositoryError);
  });

  it('存储配额异常映射为统一领域错误代码', async () => {
    const repository = createRepository();
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
      throw new DOMException('配额不足', 'QuotaExceededError');
    });

    await expect(repository.create(validInput())).rejects.toMatchObject({
      code: 'STORAGE_QUOTA_EXCEEDED'
    });
  });
});
