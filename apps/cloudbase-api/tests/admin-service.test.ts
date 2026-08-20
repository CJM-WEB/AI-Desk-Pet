import { describe, expect, it, vi } from 'vitest';

import { AdminService } from '../src/services/admin-service.js';
import type {
  AdminModerationResult,
  AdminStore,
  AdminSubmissionDetail,
  ObjectStorage
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
  const storage = {
    createSignedUploadUrl: vi.fn(),
    info: vi.fn(),
    createSignedUrl: vi.fn(async () => ({
      url: 'https://preview.example/cover.webp',
      expiresAt: '2026-07-31T00:05:00.000Z'
    })),
    delete: vi.fn()
  } satisfies ObjectStorage;
  return {
    service: new AdminService(store, storage),
    store,
    storage
  };
}

describe('管理员审核服务', () => {
  it('详情只为允许的封面图片签发五分钟私有预览', async () => {
    const row = submission('manual_review_pending', {
      assets: [{
        role: 'cover',
        storageKey: 'private/cover.webp',
        fileName: 'cover.webp',
        declaredBytes: 10,
        actualBytes: 10,
        contentType: 'image/webp'
      }]
    });
    const { service, storage } = createService(row);

    await expect(service.getDetail(row.id)).resolves.toMatchObject({
      coverPreview: {
        url: 'https://preview.example/cover.webp',
        expiresAt: '2026-07-31T00:05:00.000Z'
      }
    });
    expect(storage.createSignedUrl).toHaveBeenCalledWith('private/cover.webp', 300);
  });

  it('非封面或非 JPG PNG WebP 资产不签发预览', async () => {
    const row = submission('manual_review_pending', {
      assets: [{
        role: 'cover',
        storageKey: 'private/cover.svg',
        fileName: 'cover.svg',
        declaredBytes: 10,
        actualBytes: 10,
        contentType: 'image/svg+xml'
      }]
    });
    const { service, storage } = createService(row);

    await expect(service.getDetail(row.id)).resolves.toMatchObject({ coverPreview: null });
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });

  it.each([null, 0])('封面实际字节为 %s 时不签发预览', async (actualBytes) => {
    const row = submission('manual_review_pending', {
      assets: [{
        role: 'cover',
        storageKey: 'private/cover.png',
        fileName: 'cover.png',
        declaredBytes: 10,
        actualBytes,
        contentType: 'image/png'
      }]
    });
    const { service, storage } = createService(row);

    await expect(service.getDetail(row.id)).resolves.toMatchObject({ coverPreview: null });
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });

  it('封面签名失败时仍返回正文和扫描详情并降级为空预览', async () => {
    const row = submission('manual_review_pending', {
      body: '必须保留的审核正文',
      assets: [{
        role: 'cover',
        storageKey: 'private/cover.jpg',
        fileName: 'cover.jpg',
        declaredBytes: 10,
        actualBytes: 10,
        contentType: 'image/jpeg'
      }],
      moderationResults: [moderationResult('Review')]
    });
    const { service, storage } = createService(row);
    storage.createSignedUrl.mockRejectedValueOnce(new Error('签名服务不可用'));

    await expect(service.getDetail(row.id)).resolves.toMatchObject({
      body: '必须保留的审核正文',
      coverPreview: null,
      moderationResults: [{ suggestion: 'Review' }]
    });
  });

  it('管理员动作读取内部详情时不额外签发封面预览', async () => {
    const row = submission('manual_review_pending', {
      kind: 'feedback',
      assets: [{
        role: 'cover',
        storageKey: 'private/cover.png',
        fileName: 'cover.png',
        declaredBytes: 10,
        actualBytes: 10,
        contentType: 'image/png'
      }]
    });
    const { service, storage } = createService(row);

    await service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      row.id,
      { action: 'approve', version: 3, idempotencyKey: 'preview-action', reason: '通过' }
    );

    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });

  it('待人工审核共享包缺少当前技术证据时拒绝批准', async () => {
    const { service, store } = createService(submission('manual_review_pending', {
      kind: 'shared_package',
      moderationResults: []
    }));

    await expect(service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      'submission-1',
      {
        action: 'approve',
        version: 3,
        idempotencyKey: 'manual-review-approve',
        reason: '尝试批准'
      }
    )).rejects.toMatchObject({
      code: 'TECHNICAL_SCAN_REQUIRED',
      statusCode: 409
    });

    expect(store.applyAdminAction).not.toHaveBeenCalled();
  });

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

  const staleEvidenceCases = [
    ['对象键变化', {
      submissionId: 'submission-1',
      packageStorageKey: 'private/old-pet.zip',
      packageSizeBytes: 20,
      submissionStatusVersion: 3,
      scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
    }],
    ['实际大小变化', {
      submissionId: 'submission-1',
      packageStorageKey: 'private/current-pet.zip',
      packageSizeBytes: 19,
      submissionStatusVersion: 3,
      scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
    }],
    ['投稿身份变化', {
      submissionId: 'other-submission',
      packageStorageKey: 'private/current-pet.zip',
      packageSizeBytes: 20,
      submissionStatusVersion: 3,
      scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
    }],
    ['状态版本变化', {
      submissionId: 'submission-1',
      packageStorageKey: 'private/current-pet.zip',
      packageSizeBytes: 20,
      submissionStatusVersion: 2,
      scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
    }]
  ] as const;

  it.each(staleEvidenceCases)(
    '待人工审核共享包的%s证据不能批准',
    async (_caseName, evidence) => {
      const { service, store } = createService(submission('manual_review_pending', {
        moderationResults: [moderationResult('Pass', evidence)]
      }));

      await expect(service.applyAction(
        { uid: 'uid-admin', email: 'admin@example.com' },
        'submission-1',
        {
          action: 'approve',
          version: 3,
          idempotencyKey: `stale-evidence-${evidence.submissionId}`,
          reason: '尝试发布'
        }
      )).rejects.toMatchObject({
        code: 'TECHNICAL_SCAN_REQUIRED',
        statusCode: 409
      });
      expect(store.applyAdminAction).not.toHaveBeenCalled();
    }
  );

  it('技术扫描通过时允许纠正自动驳回并发布', async () => {
    const currentEvidence = {
      submissionId: 'submission-1',
      packageStorageKey: 'private/current-pet.zip',
      packageSizeBytes: 20,
      submissionStatusVersion: 3,
      scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
    };
    const { service, store } = createService(submission('auto_rejected', {
      moderationResults: [moderationResult('Pass', currentEvidence)]
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

  it.each(['feedback', 'suggestion'] as const)(
    '待人工审核的%s不依赖角色包扫描证据',
    async kind => {
      const { service, store } = createService(submission('manual_review_pending', {
        kind,
        assets: [],
        moderationResults: []
      }));

      await service.applyAction(
        { uid: 'uid-admin', email: 'admin@example.com' },
        'submission-1',
        {
          action: 'approve',
          version: 3,
          idempotencyKey: `approve-${kind}`,
          reason: '人工审核通过'
        }
      );

      expect(store.applyAdminAction).toHaveBeenCalledWith(expect.objectContaining({
        nextStatus: 'published'
      }));
    }
  );

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

  it.each(['feedback', 'suggestion', 'shared_package'] as const)(
    '管理员可删除已发布的 %s',
    async kind => {
      const { service, store } = createService(submission('published', { kind }));

      await service.applyAction(
        { uid: 'uid-admin', email: 'admin@example.com' },
        'submission-1',
        {
          action: 'delete',
          version: 3,
          idempotencyKey: `delete-${kind}`,
          reason: '管理员下架'
        }
      );

      expect(store.applyAdminAction).toHaveBeenCalledWith(expect.objectContaining({
        action: 'delete',
        nextStatus: 'deleted_quarantined'
      }));
    }
  );

  it('相同幂等请求在状态已变化后仍交给数据库返回原结果', async () => {
    const { service, store } = createService(submission('published', {
      moderationResults: [moderationResult('Pass', {
        packageStorageKey: 'private/current-pet.zip',
        packageSizeBytes: 20,
        scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
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
