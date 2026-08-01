import { describe, expect, it, vi } from 'vitest';

import { CleanupService } from '../src/services/cleanup-service.js';
import type {
  CleanupStore,
  SubmissionWithAssets
} from '../src/ports.js';

describe('三天隔离清理服务', () => {
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

    expect(result).toEqual({ claimed: 1, purged: 1, failed: 0 });
    expect(store.claimCleanupJobs).toHaveBeenCalledWith(
      20,
      '2026-08-03T00:10:00.000Z'
    );
    expect(order).toEqual(['object', 'purged']);
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

    expect(result).toEqual({ claimed: 2, purged: 1, failed: 1 });
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
      failed: 1
    });
    expect(store.markPurged).not.toHaveBeenCalled();
  });
});
