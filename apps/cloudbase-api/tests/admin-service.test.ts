import { describe, expect, it, vi } from 'vitest';

import { AdminService } from '../src/services/admin-service.js';
import type {
  AdminModerationResult,
  AdminStore,
  AdminSubmissionDetail
} from '../src/ports.js';

function submission(
  status: AdminSubmissionDetail['status'],
  overrides: Partial<AdminSubmissionDetail> = {}
): AdminSubmissionDetail {
  return {
    id: 'submission-1',
    kind: 'shared_package',
    status,
    statusVersion: 3,
    title: '桌宠资源',
    body: '资源说明',
    riskSummary: {},
    autoRejectionReason: null,
    assets: [{
      role: 'package',
      storageKey: 'private/current-pet.zip',
      fileName: 'pet.zip',
      declaredBytes: 20,
      actualBytes: 20,
      contentType: 'application/zip'
    }],
    moderationResults: [],
    auditLogs: [],
    ...overrides
  };
}

function createService(row = submission('manual_review_pending')) {
  const store = {
    listAdminSubmissions: vi.fn(async () => ({
      items: [row],
      nextCursor: null
    })),
    findAdminSubmission: vi.fn(async () => row),
    applyAdminAction: vi.fn(async (input: {
      nextStatus: string;
    }) => ({
      submission: {
        id: 'submission-1',
        status: input.nextStatus as AdminSubmissionDetail['status'],
        statusVersion: 4
      },
      replayed: false
    }))
  } satisfies AdminStore;
  return {
    service: new AdminService(store),
    store
  };
}

describe('管理员审核服务', () => {
  it('管理员不能批准技术扫描未通过的自动驳回投稿', async () => {
    const { service, store } = createService(submission('auto_rejected', {
      moderationResults: [moderationResult('Block')]
    }));

    await expect(service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      'submission-1',
      {
        action: 'approve',
        version: 3,
        idempotencyKey: 'request-0001',
        reason: '复核通过'
      }
    )).rejects.toMatchObject({ code: 'TECHNICAL_SCAN_REQUIRED' });
    expect(store.applyAdminAction).not.toHaveBeenCalled();
  });

  it('自动驳回转人工后仍不能用任意历史 Pass 绕过当前包门禁', async () => {
    const { service, store } = createService(submission(
      'manual_review_pending',
      {
        moderationResults: [moderationResult('Pass', {
          packageStorageKey: 'private/old-pet.zip',
          packageSizeBytes: 20
        })]
      }
    ));

    await expect(service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      'submission-1',
      {
        action: 'approve',
        version: 3,
        idempotencyKey: 'request-bypass',
        reason: '尝试发布'
      }
    )).rejects.toMatchObject({ code: 'TECHNICAL_SCAN_REQUIRED' });
    expect(store.applyAdminAction).not.toHaveBeenCalled();
  });

  it('技术扫描通过时允许纠正自动驳回并发布', async () => {
    const { service, store } = createService(submission('auto_rejected', {
      moderationResults: [moderationResult('Pass', {
        packageStorageKey: 'private/current-pet.zip',
        packageSizeBytes: 20
      })]
    }));

    await service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      'submission-1',
      {
        action: 'approve',
        version: 3,
        idempotencyKey: 'request-0002',
        reason: '机器误判'
      }
    );

    expect(store.applyAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      adminId: 'uid-admin',
      nextStatus: 'published',
      expectedVersion: 3
    }));
  });

  it('拒绝后进入管理员驳回并使用原子存储写入', async () => {
    const { service, store } = createService();

    await service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      'submission-1',
      {
        action: 'reject',
        version: 3,
        idempotencyKey: 'request-0003',
        reason: '内容违规'
      }
    );

    expect(store.applyAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      nextStatus: 'admin_rejected',
      reason: '内容违规'
    }));
  });

  it('相同幂等请求在状态已变化后仍交给数据库返回原结果', async () => {
    const { service, store } = createService(submission('published', {
      moderationResults: [moderationResult('Pass', {
        packageStorageKey: 'private/current-pet.zip',
        packageSizeBytes: 20
      })]
    }));

    await service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      'submission-1',
      {
        action: 'approve',
        version: 3,
        idempotencyKey: 'request-0005',
        reason: '审核通过'
      }
    );

    expect(store.applyAdminAction).toHaveBeenCalledOnce();
  });

  it('不允许恢复非隔离状态', async () => {
    const { service } = createService();

    await expect(service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      'submission-1',
      {
        action: 'restore',
        version: 3,
        idempotencyKey: 'request-0004',
        reason: '恢复'
      }
    )).rejects.toMatchObject({ code: 'INVALID_ADMIN_ACTION' });
  });
});

function moderationResult(
  suggestion: AdminModerationResult['suggestion'],
  evidence: Record<string, unknown> = {}
): AdminModerationResult {
  return {
    kind: 'package_scan',
    provider: 'isolated-scanner',
    suggestion,
    label: '技术检查',
    score: null,
    evidence,
    createdAt: '2026-07-31T00:00:00.000Z'
  };
}
