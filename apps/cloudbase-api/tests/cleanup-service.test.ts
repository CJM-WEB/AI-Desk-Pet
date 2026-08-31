import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createProductionWorker,
  main as productionMain
} from '../src/functions/cleanup.js';
import { CleanupService } from '../src/services/cleanup-service.js';
import type {
  CleanupStore,
  SubmissionWithAssets
} from '../src/ports.js';
import {
  createFakeRuntime,
  stubCleanupConfig
} from './support/cloudbase-production.js';

const functionContext = { eventID: 'cleanup-event' };

const productionSdk = vi.hoisted(() => ({
  createRuntime: vi.fn()
}));

vi.mock('../src/adapters/cloudbase-runtime.js', () => ({
  createCloudBaseServerRuntime: productionSdk.createRuntime
}));

beforeEach(() => {
  productionSdk.createRuntime.mockReturnValue(createFakeRuntime());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('三天隔离清理服务', () => {
  it('使用有效 Bucket 创建共享运行时组合', () => {
    stubCleanupConfig();

    const worker = createProductionWorker(functionContext);

    expect(productionSdk.createRuntime).toHaveBeenCalledTimes(1);
    expect(productionSdk.createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ envId: 'env-test' }),
      functionContext
    );
    expect(worker).toBeTypeOf('function');
  });

  it('main 把本次函数 context 传给 V3 运行时', async () => {
    stubCleanupConfig();
    vi.stubGlobal('fetch', vi.fn(async (input: string) => new Response(
      JSON.stringify(input.includes('purge_expired_public_interaction_operations') ? 0 : []),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )));

    await expect(productionMain({}, functionContext)).resolves.toEqual({
      claimed: 0,
      purged: 0,
      failed: 0,
      expiredOperationsPurged: 0
    });

    expect(productionSdk.createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ envId: 'env-test' }),
      functionContext
    );
  });

  it('只处理存储层领取的到期记录并先删对象后清正文', async () => {
    const order: string[] = [];
    const jobs: SubmissionWithAssets[] = [{
      id: 'submission-1',
      status: 'admin_rejected',
      statusVersion: 4,
      assets: [{
        role: 'package',
        storageKey: 'submissions/submission-1/package.zip',
        fileName: 'pet.zip',
        declaredBytes: 20,
        contentType: 'application/zip',
        actualBytes: 20
      }]
    }];
    const store: CleanupStore = {
      purgeExpiredPublicInteractionOperations: vi.fn(async () => {
        order.push('expired-operations');
        return 4;
      }),
      claimCleanupJobs: vi.fn(async () => jobs),
      markPurged: vi.fn(async () => {
        order.push('purged');
        return true;
      })
    };
    const storage = {
      delete: vi.fn(async () => {
        order.push('object');
      })
    };
    const service = new CleanupService(store, storage, {
      now: () => new Date('2026-08-03T00:00:00.000Z')
    });

    const result = await service.purgeDue(20);

    expect(result).toEqual({
      claimed: 1,
      purged: 1,
      failed: 0,
      expiredOperationsPurged: 4
    });
    expect(store.purgeExpiredPublicInteractionOperations).toHaveBeenCalledWith(500);
    expect(store.claimCleanupJobs).toHaveBeenCalledWith(
      20,
      '2026-08-03T00:10:00.000Z'
    );
    expect(order).toEqual(['expired-operations', 'object', 'purged']);
    expect(store.markPurged).toHaveBeenCalledWith({
      submissionId: 'submission-1',
      expectedVersion: 4
    });
  });

  it('对象删除失败时不清正文且继续处理下一条记录', async () => {
    const jobs: SubmissionWithAssets[] = [
        {
          id: 'submission-1',
          status: 'admin_rejected',
          statusVersion: 1,
          assets: [{
            role: 'package',
            storageKey: 'submissions/submission-1/one.zip',
            fileName: 'one.zip',
            declaredBytes: 1,
            contentType: 'application/zip',
            actualBytes: 1
          }]
        },
        {
          id: 'submission-2',
          status: 'uploading',
          statusVersion: 2,
          assets: []
        }
      ];
    const store: CleanupStore = {
      purgeExpiredPublicInteractionOperations: vi.fn(async () => 0),
      claimCleanupJobs: vi.fn(async () => jobs),
      markPurged: vi.fn(async () => true)
    };
    const storage = {
      delete: vi.fn(async (path: string) => {
        if (path.endsWith('one.zip')) throw new Error('存储异常');
      })
    };
    const service = new CleanupService(store, storage, {
      now: () => new Date('2026-08-03T00:00:00.000Z')
    });

    const result = await service.purgeDue(20);

    expect(result).toEqual({
      claimed: 2,
      purged: 1,
      failed: 1,
      expiredOperationsPurged: 0
    });
    expect(store.markPurged).toHaveBeenCalledOnce();
    expect(store.markPurged).toHaveBeenCalledWith({
      submissionId: 'submission-2',
      expectedVersion: 2
    });
  });

  it('对象删除超过边界时间时保持隔离且不清正文', async () => {
    const jobs: SubmissionWithAssets[] = [{
      id: 'submission-timeout',
      status: 'deleted_quarantined',
      statusVersion: 8,
      cleanupStartedAt: '2026-08-03T00:00:00.000Z',
      assets: [{
        role: 'package',
        storageKey: 'submissions/submission-timeout/pet.zip',
        fileName: 'pet.zip',
        declaredBytes: 1,
        contentType: 'application/zip',
        actualBytes: 1
      }]
    }];
    const store: CleanupStore = {
      purgeExpiredPublicInteractionOperations: vi.fn(async () => 0),
      claimCleanupJobs: vi.fn(async () => jobs),
      markPurged: vi.fn(async () => true)
    };
    const service = new CleanupService(
      store,
      { delete: vi.fn(() => new Promise<void>(() => {})) },
      { now: () => new Date('2026-08-03T00:00:00.000Z') },
      5
    );

    await expect(service.purgeDue(20)).resolves.toEqual({
      claimed: 1,
      purged: 0,
      failed: 1,
      expiredOperationsPurged: 0
    });
    expect(store.markPurged).not.toHaveBeenCalled();
  });

  it('互动账本清理失败时整轮失败且不吞数据库异常', async () => {
    const databaseError = new Error('数据库清理失败');
    const store: CleanupStore = {
      purgeExpiredPublicInteractionOperations: vi.fn(async () => {
        throw databaseError;
      }),
      claimCleanupJobs: vi.fn(async () => []),
      markPurged: vi.fn(async () => true)
    };
    const service = new CleanupService(
      store,
      { delete: vi.fn(async () => undefined) },
      { now: () => new Date('2026-08-03T00:00:00.000Z') }
    );

    await expect(service.purgeDue(20)).rejects.toBe(databaseError);
    expect(store.claimCleanupJobs).not.toHaveBeenCalled();
  });
});
