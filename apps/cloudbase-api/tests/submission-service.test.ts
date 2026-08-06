import cloudbase from '@cloudbase/node-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  CloudBaseStorage,
  type CloudBaseStorageBucket
} from '../src/adapters/cloudbase-storage.js';
import { hashStatusToken } from '../src/crypto/status-token.js';
import {
  SubmissionService,
  type PrepareSubmissionInput
} from '../src/services/submission-service.js';

const MiB = 1024 * 1024;

const validInput: PrepareSubmissionInput = {
  kind: 'shared_package',
  title: '云端小助手',
  body: '一个用于测试的共享角色包。',
  packageFile: {
    fileName: 'pet.zip',
    sizeBytes: 100 * MiB,
    contentType: 'application/zip'
  },
  coverFile: {
    fileName: 'cover.webp',
    sizeBytes: 5 * MiB,
    contentType: 'image/webp'
  }
};

class MemorySubmissionStore {
  readonly rows = new Map<string, any>();
  created: any = null;

  async createSubmission(input: any): Promise<any> {
    this.created = structuredClone(input);
    const row = {
      ...structuredClone(input),
      status: 'uploading',
      statusVersion: 0,
      publicReason: null,
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z'
    };
    this.rows.set(input.id, row);
    return row;
  }

  async findById(id: string): Promise<any | null> {
    return this.rows.get(id) ?? null;
  }

  async completeUpload(input: { submissionId: string }): Promise<any> {
    const row = this.rows.get(input.submissionId);
    if (!row) return null;
    if (row.status === 'uploading') row.status = 'system_reviewing';
    return structuredClone(row);
  }

  async findByStatusTokenHash(hash: string): Promise<any | null> {
    const row = [...this.rows.values()]
      .find(candidate => candidate.statusTokenHash === hash);
    if (!row) return null;
    return {
      submissionId: row.id,
      status: row.status,
      publicReason: row.publicReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }
}

class MemoryStorage {
  readonly uploadCalls: Array<{ path: string; options: { upsert: boolean } }> = [];
  readonly infoByPath = new Map<string, {
    path: string;
    size: number;
    contentType: string;
  }>();
  uploadFailurePath: string | null = null;

  async createSignedUploadUrl(
    path: string,
    options: { upsert: boolean }
  ): Promise<{ url: string; expiresAt: string }> {
    this.uploadCalls.push({ path, options });
    if (path === this.uploadFailurePath) {
      throw Object.assign(new Error('签名失败'), { code: 'STORAGE_ERROR' });
    }
    return {
      url: `https://storage.example/${path}`,
      expiresAt: '2026-07-31T01:00:00.000Z'
    };
  }

  async info(path: string): Promise<{
    path: string;
    size: number;
    contentType: string;
  } | null> {
    return this.infoByPath.get(path) ?? null;
  }

  async createSignedUrl(): Promise<never> {
    throw new Error('本测试不会调用下载签名');
  }

  async delete(): Promise<void> {}
}

function createFixture(): {
  store: MemorySubmissionStore;
  storage: MemoryStorage;
  service: SubmissionService;
} {
  const store = new MemorySubmissionStore();
  const storage = new MemoryStorage();
  return {
    store,
    storage,
    service: new SubmissionService(
      store as never,
      storage,
      () => 'submission-1'
    )
  };
}

describe('投稿服务', () => {
  it('prepare 只返回私有单次上传目标和一次性状态令牌', async () => {
    const { service, store, storage } = createFixture();

    const receipt = await service.prepare(validInput, { ip: '203.0.113.8' });
    expect(receipt).toMatchObject({
      submissionId: 'submission-1',
      status: 'uploading',
      statusPath: '/submission-status/',
      coverUpload: {
        path: 'submissions/submission-1/cover.webp',
        url: 'https://storage.example/submissions/submission-1/cover.webp'
      },
      packageUpload: {
        path: 'submissions/submission-1/package.zip',
        url: 'https://storage.example/submissions/submission-1/package.zip'
      }
    });
    expect(receipt.statusToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.created.statusTokenHash).toBe(hashStatusToken(receipt.statusToken));
    expect(store.created.statusTokenHash).not.toBe(receipt.statusToken);
    expect(storage.uploadCalls).toEqual([
      {
        path: 'submissions/submission-1/cover.webp',
        options: { upsert: false }
      },
      {
        path: 'submissions/submission-1/package.zip',
        options: { upsert: false }
      }
    ]);
  });

  it.each([
    ['共享包', {
      packageFile: {
        ...validInput.packageFile,
        sizeBytes: 100 * MiB + 1
      }
    }],
    ['封面', {
      coverFile: { ...validInput.coverFile, sizeBytes: 5 * MiB + 1 }
    }]
  ])('%s 超过边界时不创建投稿', async (_name, change) => {
    const { service, store } = createFixture();

    await expect(service.prepare(
      { ...validInput, ...change } as PrepareSubmissionInput,
      { ip: '203.0.113.8' }
    )).rejects.toMatchObject({ code: 'INVALID_UPLOAD' });
    expect(store.created).toBeNull();
  });

  it.each([
    ['共享包', {
      packageFile: { ...validInput.packageFile, sizeBytes: 0 }
    }],
    ['封面', {
      coverFile: { ...validInput.coverFile, sizeBytes: 0 }
    }]
  ])('%s 声明为零字节时拒绝准备上传', async (_name, change) => {
    const { service, store } = createFixture();

    await expect(service.prepare(
      { ...validInput, ...change } as PrepareSubmissionInput,
      { ip: '203.0.113.8' }
    )).rejects.toMatchObject({ code: 'INVALID_UPLOAD' });
    expect(store.created).toBeNull();
  });

  it.each([
    [
      '共享包 MIME',
      { packageFile: { ...validInput.packageFile, contentType: 'image/png' } }
    ],
    [
      '封面扩展名',
      {
        coverFile: {
          ...validInput.coverFile,
          fileName: 'cover.gif',
          contentType: 'image/png'
        }
      }
    ]
  ])('%s 不在允许集合时拒绝准备上传', async (_name, change) => {
    const { service } = createFixture();

    await expect(service.prepare(
      { ...validInput, ...change } as PrepareSubmissionInput,
      { ip: '203.0.113.8' }
    )).rejects.toMatchObject({ code: 'INVALID_UPLOAD' });
  });

  it.each([
    ['标题为空', { title: '  ' }],
    ['正文超过五百字', { body: '字'.repeat(501) }]
  ])('%s 时在写入前拒绝请求', async (_name, change) => {
    const { service } = createFixture();

    await expect(service.prepare(
      { ...validInput, ...change },
      { ip: '203.0.113.8' }
    )).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('缺少文件声明时返回受控请求错误', async () => {
    const { service } = createFixture();

    await expect(service.prepare(
      { ...validInput, packageFile: null } as unknown as PrepareSubmissionInput,
      { ip: '203.0.113.8' }
    )).rejects.toMatchObject({ code: 'INVALID_UPLOAD' });
    await expect(service.prepare(
      null as unknown as PrepareSubmissionInput,
      { ip: '203.0.113.8' }
    )).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('签名阶段失败时不返回部分上传目标并保留隐藏记录供清理', async () => {
    const { service, store, storage } = createFixture();
    storage.uploadFailurePath = 'submissions/submission-1/package.zip';

    await expect(service.prepare(validInput, { ip: '203.0.113.8' }))
      .rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(store.rows.get('submission-1')).toMatchObject({ status: 'uploading' });
  });

  it('finalize 核对两个对象后推进到系统审核且重复调用幂等', async () => {
    const { service, store, storage } = createFixture();
    await service.prepare(validInput, { ip: '203.0.113.8' });
    storage.infoByPath.set('submissions/submission-1/cover.webp', {
      path: 'submissions/submission-1/cover.webp',
      size: 5 * MiB,
      contentType: 'image/webp'
    });
    storage.infoByPath.set('submissions/submission-1/package.zip', {
      path: 'submissions/submission-1/package.zip',
      size: 100 * MiB,
      contentType: 'application/zip'
    });

    await expect(service.finalize({ submissionId: 'submission-1' }))
      .resolves.toEqual({ status: 'system_reviewing' });
    await expect(service.finalize({ submissionId: 'submission-1' }))
      .resolves.toEqual({ status: 'system_reviewing' });
    expect(store.rows.get('submission-1')).toMatchObject({
      status: 'system_reviewing'
    });
  });

  it.each([
    ['对象缺失', null],
    ['大小超过声明', {
      path: 'submissions/submission-1/package.zip',
      size: 100 * MiB + 1,
      contentType: 'application/zip'
    }],
    ['大小短于声明', {
      path: 'submissions/submission-1/package.zip',
      size: 100 * MiB - 1,
      contentType: 'application/zip'
    }],
    ['MIME 不符', {
      path: 'submissions/submission-1/package.zip',
      size: 100 * MiB,
      contentType: 'application/octet-stream'
    }]
  ])('finalize 遇到%s时保持隐藏', async (_name, packageInfo) => {
    const { service, store, storage } = createFixture();
    await service.prepare(validInput, { ip: '203.0.113.8' });
    storage.infoByPath.set('submissions/submission-1/cover.webp', {
      path: 'submissions/submission-1/cover.webp',
      size: 5 * MiB,
      contentType: 'image/webp'
    });
    if (packageInfo) {
      storage.infoByPath.set('submissions/submission-1/package.zip', packageInfo);
    }

    await expect(service.finalize({ submissionId: 'submission-1' }))
      .rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' });
    expect(store.rows.get('submission-1')).toMatchObject({ status: 'uploading' });
  });

  it('finalize 即使数据库声明异常也保留共享包绝对上限', async () => {
    const { service, store, storage } = createFixture();
    await service.prepare(validInput, { ip: '203.0.113.8' });
    const packageAsset = store.rows.get('submission-1').assets
      .find((asset: any) => asset.role === 'package');
    packageAsset.declaredBytes = 100 * MiB + 10;
    storage.infoByPath.set('submissions/submission-1/cover.webp', {
      path: 'submissions/submission-1/cover.webp',
      size: 5 * MiB,
      contentType: 'image/webp'
    });
    storage.infoByPath.set('submissions/submission-1/package.zip', {
      path: 'submissions/submission-1/package.zip',
      size: 100 * MiB + 1,
      contentType: 'application/zip'
    });

    await expect(service.finalize({ submissionId: 'submission-1' }))
      .rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' });
    expect(store.rows.get('submission-1')).toMatchObject({ status: 'uploading' });
  });

  it('状态查询只把原始令牌转换为哈希后访问仓储', async () => {
    const { service, store } = createFixture();
    const receipt = await service.prepare(validInput, { ip: '203.0.113.8' });
    const query = vi.spyOn(store, 'findByStatusTokenHash');

    await expect(service.getStatus(receipt.statusToken)).resolves.toMatchObject({
      submissionId: 'submission-1',
      status: 'uploading'
    });
    expect(query).toHaveBeenCalledWith(hashStatusToken(receipt.statusToken));
  });

  it('无效或未知状态令牌统一返回不存在', async () => {
    const { service } = createFixture();

    await expect(service.getStatus('not-a-token'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.getStatus('a'.repeat(43)))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('CloudBase PG Storage 适配器', () => {
  it('已安装 SDK 的真实 Bucket 方法兼容薄适配层', () => {
    const app = cloudbase.init({ env: 'env-test' }) as unknown as {
      storage: { from(bucketId: string): CloudBaseStorageBucket };
    };

    expect(typeof app.storage.from).toBe('function');
  });

  it('映射真实 SDK 返回字段并保留签名参数', async () => {
    const bucket = {
      bucketId: 'ai-pet-private',
      createSignedUploadUrl: vi.fn(async () => ({
        data: {
          fullSignedURL: 'https://storage.example/v1/storages/v1/storages/upload',
          token: 'upload-token',
          path: 'submissions/submission-1/package.zip'
        },
        error: null
      })),
      info: vi.fn(async (path: string) => ({
        data: {
          id: 'object-1',
          name: path,
          bucketId: 'ai-pet-private',
          size: 1024,
          contentType: 'application/zip'
        },
        error: null
      })),
      createSignedUrl: vi.fn(async () => ({
        data: { fullSignedURL: 'https://storage.example/download' },
        error: null
      })),
      remove: vi.fn(async () => ({
        data: [],
        error: null
      }))
    };
    const storage = new CloudBaseStorage(
      bucket,
      () => new Date('2026-07-31T00:00:00.000Z')
    );

    await expect(storage.createSignedUploadUrl(
      'submissions/submission-1/package.zip',
      { upsert: false }
    )).resolves.toEqual({
      url: 'https://storage.example/v1/storages/upload?token=upload-token',
      expiresAt: '2026-07-31T01:00:00.000Z'
    });
    await expect(storage.info('submissions/submission-1/package.zip'))
      .resolves.toEqual({
        path: 'submissions/submission-1/package.zip',
        size: 1024,
        contentType: 'application/zip'
      });
    await expect(storage.createSignedUrl(
      'submissions/submission-1/package.zip',
      300
    )).resolves.toEqual({
      url: 'https://storage.example/download',
      expiresAt: '2026-07-31T00:05:00.000Z'
    });
    await storage.delete('submissions/submission-1/package.zip');

    expect(bucket.createSignedUploadUrl).toHaveBeenCalledWith(
      'submissions/submission-1/package.zip',
      { upsert: false }
    );
    expect(bucket.createSignedUrl).toHaveBeenCalledWith(
      'submissions/submission-1/package.zip',
      300
    );
    expect(bucket.remove).toHaveBeenCalledWith([
      'submissions/submission-1/package.zip'
    ]);
  });

  it('存储错误失败关闭且不存在对象只映射为 null', async () => {
    const notFound = Object.assign(new Error('missing'), { status: 404 });
    const bucket = {
      bucketId: 'ai-pet-private',
      createSignedUploadUrl: vi.fn(async () => ({
        data: null,
        error: new Error('sign failed')
      })),
      info: vi.fn(async () => ({ data: null, error: notFound })),
      createSignedUrl: vi.fn(async () => ({
        data: null,
        error: new Error('sign failed')
      })),
      remove: vi.fn(async () => ({
        data: null,
        error: new Error('remove failed')
      }))
    };
    const storage = new CloudBaseStorage(bucket);

    await expect(storage.info('missing')).resolves.toBeNull();
    await expect(storage.createSignedUploadUrl('path', { upsert: false }))
      .rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    await expect(storage.createSignedUrl('path', 300))
      .rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    await expect(storage.delete('path'))
      .rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });

  it('拒绝把公开或错误 Bucket 注入私有存储适配器', () => {
    const bucket = {
      bucketId: 'public-bucket',
      createSignedUploadUrl: vi.fn(),
      info: vi.fn(),
      createSignedUrl: vi.fn(),
      remove: vi.fn()
    };

    expect(() => new CloudBaseStorage(bucket as never))
      .toThrow(expect.objectContaining({ code: 'STORAGE_BUCKET_INVALID' }));
  });
});
