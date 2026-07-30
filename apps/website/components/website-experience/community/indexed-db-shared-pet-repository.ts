import {
  SHARED_PET_PAGE_SIZE,
  type CreateSharedPetInput,
  type SharedPetDownload,
  type SharedPetErrorCode,
  type SharedPetPackageSummary,
  type SharedPetPage,
  type SharedPetRepository
} from './shared-pet-types';

export const SHARED_PET_DATABASE_NAME = 'ai-pet-community-v1';
export const SHARED_PET_METADATA_STORE = 'sharedPetMetadata';
export const SHARED_PET_FILES_STORE = 'sharedPetFiles';

const SHARED_PET_DATABASE_VERSION = 1;
const CREATED_AT_INDEX = 'createdAt';

interface SharedPetFileRecord {
  id: string;
  file: Blob;
  fileName: string;
  mimeType: string;
}

interface IndexedDbSharedPetRepositoryOptions {
  databaseName?: string;
  createId?: () => string;
  now?: () => string;
  indexedDb?: IDBFactory | null;
}

export class SharedPetRepositoryError extends Error {
  readonly code: SharedPetErrorCode;

  constructor(code: SharedPetErrorCode) {
    super(code);
    this.name = 'SharedPetRepositoryError';
    this.code = code;
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener(
      'error',
      () => reject(request.error ?? new DOMException('IndexedDB 请求失败', 'UnknownError')),
      { once: true }
    );
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (!settled) {
        settled = true;
        action();
      }
    };

    transaction.addEventListener('complete', () => finish(resolve), { once: true });
    transaction.addEventListener(
      'abort',
      () => finish(() => reject(
        transaction.error ?? new DOMException('IndexedDB 事务已中止', 'AbortError')
      )),
      { once: true }
    );
    transaction.addEventListener(
      'error',
      () => finish(() => reject(
        transaction.error ?? new DOMException('IndexedDB 事务失败', 'UnknownError')
      )),
      { once: true }
    );
  });
}

function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // 事务可能已经完成或中止，此时无需重复处理。
  }
}

function mapRepositoryError(
  error: unknown,
  fallbackCode: SharedPetErrorCode
): SharedPetRepositoryError {
  if (error instanceof SharedPetRepositoryError) {
    return error;
  }
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new SharedPetRepositoryError('STORAGE_QUOTA_EXCEEDED');
  }
  return new SharedPetRepositoryError(fallbackCode);
}

function readPageItems(
  index: IDBIndex,
  offset: number,
  pageSize: number
): Promise<SharedPetPackageSummary[]> {
  return new Promise((resolve, reject) => {
    const items: SharedPetPackageSummary[] = [];
    const request = index.openCursor(null, 'prev');
    let movedToPage = offset === 0;

    request.addEventListener('error', () => reject(
      request.error ?? new DOMException('读取分页游标失败', 'UnknownError')
    ), { once: true });
    request.addEventListener('success', () => {
      const cursor = request.result;
      if (!cursor || items.length === pageSize) {
        resolve(items);
        return;
      }
      if (!movedToPage) {
        movedToPage = true;
        cursor.advance(offset);
        return;
      }

      items.push(cursor.value as SharedPetPackageSummary);
      if (items.length === pageSize) {
        resolve(items);
        return;
      }
      cursor.continue();
    });
  });
}

/** 使用两个对象仓库持久化共享包元数据与按需读取的 ZIP 文件。 */
export class IndexedDbSharedPetRepository implements SharedPetRepository {
  private readonly databaseName: string;
  private readonly createId: () => string;
  private readonly now: () => string;
  private readonly indexedDb: IDBFactory | null;
  private readonly listeners = new Set<() => void>();

  constructor(options: IndexedDbSharedPetRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? SHARED_PET_DATABASE_NAME;
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.indexedDb = options.indexedDb === undefined
      ? (globalThis.indexedDB ?? null)
      : options.indexedDb;
  }

  async listPage(
    page: number,
    pageSize: typeof SHARED_PET_PAGE_SIZE = SHARED_PET_PAGE_SIZE
  ): Promise<SharedPetPage> {
    const selectedPage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;

    try {
      return await this.withDatabase(async (database) => {
        const transaction = database.transaction(SHARED_PET_METADATA_STORE, 'readonly');
        const completed = transactionCompletion(transaction);
        const store = transaction.objectStore(SHARED_PET_METADATA_STORE);
        const totalRequest = requestResult(store.count());
        const itemsRequest = readPageItems(
          store.index(CREATED_AT_INDEX),
          (selectedPage - 1) * pageSize,
          pageSize
        );
        const [total, items] = await Promise.all([totalRequest, itemsRequest]);
        await completed;
        const totalPages = Math.ceil(total / pageSize);

        return {
          items,
          page: selectedPage,
          pageSize,
          total,
          totalPages,
          hasPrevious: selectedPage > 1 && totalPages > 0,
          hasNext: selectedPage < totalPages
        };
      });
    } catch (error) {
      throw mapRepositoryError(error, 'FILE_READ_FAILED');
    }
  }

  async create(input: CreateSharedPetInput): Promise<SharedPetPackageSummary> {
    const createdAt = this.now();
    const metadata: SharedPetPackageSummary = {
      id: this.createId(),
      name: input.name,
      description: input.description,
      packageFileName: input.packageFile.name,
      packageSizeBytes: input.packageFile.size,
      coverFileName: input.coverFile.name,
      coverMimeType: input.coverFile.type,
      coverSizeBytes: input.coverFile.size,
      coverFile: input.coverFile,
      likeCount: 0,
      downloadCount: 0,
      createdAt,
      updatedAt: createdAt,
      likedByCurrentUser: false
    };
    const fileRecord: SharedPetFileRecord = {
      id: metadata.id,
      file: input.packageFile,
      fileName: input.packageFile.name,
      mimeType: input.packageFile.type
    };

    try {
      await this.withDatabase(async (database) => {
        const transaction = database.transaction(
          [SHARED_PET_METADATA_STORE, SHARED_PET_FILES_STORE],
          'readwrite'
        );
        const completed = transactionCompletion(transaction);
        try {
          const metadataRequest = requestResult(
            transaction.objectStore(SHARED_PET_METADATA_STORE).add(metadata)
          );
          const fileRequest = requestResult(
            transaction.objectStore(SHARED_PET_FILES_STORE).add(fileRecord)
          );
          await Promise.all([metadataRequest, fileRequest, completed]);
        } catch (error) {
          abortTransaction(transaction);
          await completed.catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      throw mapRepositoryError(error, 'DATABASE_OPEN_FAILED');
    }

    this.notify();
    return metadata;
  }

  async getById(id: string): Promise<SharedPetPackageSummary | null> {
    try {
      return await this.withDatabase(async (database) => {
        const transaction = database.transaction(SHARED_PET_METADATA_STORE, 'readonly');
        const completed = transactionCompletion(transaction);
        const metadata = await requestResult<SharedPetPackageSummary | undefined>(
          transaction.objectStore(SHARED_PET_METADATA_STORE).get(id)
        );
        await completed;
        return metadata ?? null;
      });
    } catch (error) {
      throw mapRepositoryError(error, 'FILE_READ_FAILED');
    }
  }

  async toggleLike(id: string): Promise<SharedPetPackageSummary> {
    const metadata = await this.updateMetadata(id, (current) => {
      const likedByCurrentUser = !current.likedByCurrentUser;
      return {
        ...current,
        likedByCurrentUser,
        likeCount: Math.max(0, current.likeCount + (likedByCurrentUser ? 1 : -1)),
        updatedAt: this.now()
      };
    }, 'DATABASE_OPEN_FAILED');
    this.notify();
    return metadata;
  }

  async getDownload(id: string): Promise<SharedPetDownload> {
    try {
      return await this.withDatabase(async (database) => {
        const transaction = database.transaction(SHARED_PET_FILES_STORE, 'readonly');
        const completed = transactionCompletion(transaction);
        const record = await requestResult<SharedPetFileRecord | undefined>(
          transaction.objectStore(SHARED_PET_FILES_STORE).get(id)
        );
        await completed;
        if (!record) {
          throw new SharedPetRepositoryError('PACKAGE_NOT_FOUND');
        }
        return {
          file: record.file,
          fileName: record.fileName,
          mimeType: record.mimeType
        };
      });
    } catch (error) {
      throw mapRepositoryError(error, 'FILE_READ_FAILED');
    }
  }

  async recordDownload(id: string): Promise<SharedPetPackageSummary> {
    const metadata = await this.updateMetadata(id, (current) => ({
      ...current,
      downloadCount: Math.max(0, current.downloadCount) + 1,
      updatedAt: this.now()
    }), 'DOWNLOAD_FAILED');
    this.notify();
    return metadata;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async openDatabase(): Promise<IDBDatabase> {
    if (!this.indexedDb) {
      throw new SharedPetRepositoryError('INDEXED_DB_UNAVAILABLE');
    }

    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.indexedDb!.open(this.databaseName, SHARED_PET_DATABASE_VERSION);
      } catch {
        reject(new SharedPetRepositoryError('DATABASE_OPEN_FAILED'));
        return;
      }

      request.addEventListener('upgradeneeded', () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(SHARED_PET_METADATA_STORE)) {
          const metadataStore = database.createObjectStore(
            SHARED_PET_METADATA_STORE,
            { keyPath: 'id' }
          );
          metadataStore.createIndex(CREATED_AT_INDEX, CREATED_AT_INDEX);
        }
        if (!database.objectStoreNames.contains(SHARED_PET_FILES_STORE)) {
          database.createObjectStore(SHARED_PET_FILES_STORE, { keyPath: 'id' });
        }
      });
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener(
        'error',
        () => reject(new SharedPetRepositoryError('DATABASE_OPEN_FAILED')),
        { once: true }
      );
      request.addEventListener(
        'blocked',
        () => reject(new SharedPetRepositoryError('DATABASE_OPEN_FAILED')),
        { once: true }
      );
    });
  }

  private async withDatabase<T>(
    operation: (database: IDBDatabase) => Promise<T>
  ): Promise<T> {
    const database = await this.openDatabase();
    try {
      return await operation(database);
    } finally {
      database.close();
    }
  }

  /** 元数据计数更新统一在单个读写事务中完成，缺失记录映射为领域错误。 */
  private async updateMetadata(
    id: string,
    update: (metadata: SharedPetPackageSummary) => SharedPetPackageSummary,
    fallbackCode: SharedPetErrorCode
  ): Promise<SharedPetPackageSummary> {
    try {
      return await this.withDatabase(async (database) => {
        const transaction = database.transaction(SHARED_PET_METADATA_STORE, 'readwrite');
        const completed = transactionCompletion(transaction);
        try {
          const store = transaction.objectStore(SHARED_PET_METADATA_STORE);
          const current = await requestResult<SharedPetPackageSummary | undefined>(store.get(id));
          if (!current) {
            transaction.abort();
            await completed.catch(() => undefined);
            throw new SharedPetRepositoryError('PACKAGE_NOT_FOUND');
          }

          const next = update(current);
          await Promise.all([requestResult(store.put(next)), completed]);
          return next;
        } catch (error) {
          abortTransaction(transaction);
          await completed.catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      throw mapRepositoryError(error, fallbackCode);
    }
  }

  /** 单个监听器失败不得改变已提交事务对其他监听器的通知结果。 */
  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        continue;
      }
    }
  }
}
