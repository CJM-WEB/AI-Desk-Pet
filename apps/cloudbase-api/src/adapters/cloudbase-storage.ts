import { ApiError } from '../errors.js';
import type {
  ObjectStorage,
  SignedDownload,
  SignedUpload,
  SignedUploadOptions,
  StoredObjectInfo
} from '../ports.js';

interface StorageResult<T> {
  data: T | null;
  error: unknown | null;
}

interface CloudBaseObjectInfo {
  name: string;
  size?: number | null;
  contentType?: string | null;
}

/** 已安装 CloudBase JS SDK 的 PG Storage Bucket 最小表面。 */
export interface CloudBaseStorageBucket {
  readonly bucketId: string;
  createSignedUploadUrl(
    path: string,
    options?: { upsert?: boolean }
  ): Promise<StorageResult<{
    fullSignedURL: string;
    token: string;
    path: string;
  }>>;
  info(path: string): Promise<StorageResult<CloudBaseObjectInfo>>;
  createSignedUrl(
    path: string,
    expiresIn: number
  ): Promise<StorageResult<{ fullSignedURL: string }>>;
  remove(paths: string[]): Promise<StorageResult<unknown>>;
}

type Now = () => Date;

const signedUploadLifetimeSeconds = 3600;

/** 把 CloudBase PG Storage 判别联合归一为后端存储端口。 */
export class CloudBaseStorage implements ObjectStorage {
  constructor(
    private readonly bucket: CloudBaseStorageBucket,
    private readonly now: Now = () => new Date()
  ) {
    if (bucket.bucketId !== 'ai-pet-private') {
      throw new ApiError('STORAGE_BUCKET_INVALID', 500);
    }
  }

  async createSignedUploadUrl(
    path: string,
    options: SignedUploadOptions
  ): Promise<SignedUpload> {
    const result = await this.bucket.createSignedUploadUrl(path, {
      upsert: options.upsert
    });
    const data = requireStorageData(result, '签发上传地址失败');
    return {
      url: requireHttpsUrl(data.fullSignedURL),
      expiresAt: this.expiresAt(signedUploadLifetimeSeconds)
    };
  }

  async info(path: string): Promise<StoredObjectInfo | null> {
    const result = await this.bucket.info(path);
    if (result.error) {
      if (isNotFound(result.error)) return null;
      throw storageError('读取对象信息失败');
    }
    if (!result.data) throw storageError('对象信息响应为空');

    const { name, size, contentType } = result.data;
    if (
      name !== path
      || typeof size !== 'number'
      || !Number.isSafeInteger(size)
      || size < 0
      || typeof contentType !== 'string'
      || contentType.length === 0
    ) {
      throw storageError('对象信息格式错误');
    }
    return { path: name, size, contentType };
  }

  async createSignedUrl(
    path: string,
    expiresInSeconds: number
  ): Promise<SignedDownload> {
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1) {
      throw storageError('下载地址有效期无效');
    }
    const result = await this.bucket.createSignedUrl(path, expiresInSeconds);
    const data = requireStorageData(result, '签发下载地址失败');
    return {
      url: requireHttpsUrl(data.fullSignedURL),
      expiresAt: this.expiresAt(expiresInSeconds)
    };
  }

  async delete(path: string): Promise<void> {
    requireStorageData(await this.bucket.remove([path]), '删除对象失败');
  }

  private expiresAt(seconds: number): string {
    return new Date(this.now().getTime() + seconds * 1000).toISOString();
  }
}

function requireStorageData<T>(
  result: StorageResult<T>,
  reason: string
): T {
  if (result.error || !result.data) throw storageError(reason);
  return result.data;
}

function requireHttpsUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return url.toString();
  } catch {}
  throw storageError('签名地址格式错误');
}

function isNotFound(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const error = value as { status?: unknown; statusCode?: unknown };
  return error.status === 404 || error.statusCode === 404;
}

function storageError(reason: string): ApiError {
  return new ApiError('STORAGE_ERROR', 500, reason);
}
