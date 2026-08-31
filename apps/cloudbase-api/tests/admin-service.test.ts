import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/errors.js';
import { AdminService } from '../src/services/admin-service.js';
import type {
  AdminActionInput,
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
    applyAdminAction: vi.fn(async (input: AdminActionInput) => ({
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
    service: new AdminService(store, storage, {
      now: () => new Date('2026-07-31T12:00:00.000Z')
    }),
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
      archiveSizeBytes: 20,
      archiveSha256: 'a'.repeat(64),
      protocolVersion: '2026-08-15',
      ruleVersion: 'character-package-2026-08-15',
      completedAt: '2026-07-31T00:00:00.000Z',
      expiresAt: '2026-08-01T00:00:00.000Z',
      submissionStatusVersion: 3,
      scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
    }],
    ['实际大小变化', {
      submissionId: 'submission-1',
      packageStorageKey: 'private/current-pet.zip',
      packageSizeBytes: 19,
      archiveSizeBytes: 19,
      archiveSha256: 'a'.repeat(64),
      protocolVersion: '2026-08-15',
      ruleVersion: 'character-package-2026-08-15',
      completedAt: '2026-07-31T00:00:00.000Z',
      expiresAt: '2026-08-01T00:00:00.000Z',
      submissionStatusVersion: 3,
      scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
    }],
    ['投稿身份变化', {
      submissionId: 'other-submission',
      packageStorageKey: 'private/current-pet.zip',
      packageSizeBytes: 20,
      archiveSizeBytes: 20,
      archiveSha256: 'a'.repeat(64),
      protocolVersion: '2026-08-15',
      ruleVersion: 'character-package-2026-08-15',
      completedAt: '2026-07-31T00:00:00.000Z',
      expiresAt: '2026-08-01T00:00:00.000Z',
      submissionStatusVersion: 3,
      scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
    }],
    ['状态版本变化', {
      submissionId: 'submission-1',
      packageStorageKey: 'private/current-pet.zip',
      packageSizeBytes: 20,
      archiveSizeBytes: 20,
      archiveSha256: 'a'.repeat(64),
      protocolVersion: '2026-08-15',
      ruleVersion: 'character-package-2026-08-15',
      completedAt: '2026-07-31T00:00:00.000Z',
      expiresAt: '2026-08-01T00:00:00.000Z',
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

  it('技术扫描通过时只允许待人工状态发布', async () => {
    const currentEvidence = {
      submissionId: 'submission-1',
      packageStorageKey: 'private/current-pet.zip',
      packageSizeBytes: 20,
      archiveSizeBytes: 20,
      archiveSha256: 'a'.repeat(64),
      protocolVersion: '2026-08-15',
      ruleVersion: 'character-package-2026-08-15',
      completedAt: '2026-07-31T00:00:00.000Z',
      expiresAt: '2026-08-01T00:00:00.000Z',
      submissionStatusVersion: 3,
      scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
    };
    const { service, store } = createService(submission('manual_review_pending', {
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

  it.each([
    ['恰好到期', '2026-07-31T12:00:00.000Z'],
    ['已经过期', '2026-07-31T11:59:59.999Z']
  ])('%s的扫描证据不能批准', async (_name, expiresAt) => {
    const evidence = currentEvidence({ expiresAt });
    const { service, store } = createService(submission('manual_review_pending', {
      moderationResults: [moderationResult('Pass', evidence)]
    }));

    await expect(service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      'submission-1',
      {
        action: 'approve',
        version: 3,
        idempotencyKey: `expired-${expiresAt}`,
        reason: '尝试批准'
      }
    )).rejects.toMatchObject({ code: 'TECHNICAL_SCAN_REQUIRED' });
    expect(store.applyAdminAction).not.toHaveBeenCalled();
  });

  it('自动驳回转人工和隔离共享包恢复都回到系统审核重扫', async () => {
    const autoRejected = submission('auto_rejected');
    const first = createService(autoRejected);
    await first.service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      autoRejected.id,
      {
        action: 'move_to_manual', version: 3,
        idempotencyKey: 'rescan-auto-rejected', reason: '请求复核'
      }
    );
    expect(first.store.applyAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ nextStatus: 'system_reviewing' })
    );

    const quarantined = submission('deleted_quarantined', {
      preQuarantineStatus: 'published'
    });
    const second = createService(quarantined);
    await second.service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      quarantined.id,
      {
        action: 'restore', version: 3,
        idempotencyKey: 'rescan-restored-package', reason: '恢复并重扫'
      }
    );
    expect(second.store.applyAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ nextStatus: 'system_reviewing' })
    );
  });

  it.each([
    {
      name: '共享包转人工',
      action: 'move_to_manual' as const,
      initial: submission('auto_rejected'),
      changed: submission('system_reviewing', { statusVersion: 4 })
    },
    {
      name: '共享包恢复',
      action: 'restore' as const,
      initial: submission('deleted_quarantined', { preQuarantineStatus: 'published' }),
      changed: submission('system_reviewing', { statusVersion: 4, preQuarantineStatus: null })
    },
    {
      name: '文本恢复',
      action: 'restore' as const,
      initial: submission('deleted_quarantined', {
        kind: 'feedback',
        assets: [],
        preQuarantineStatus: 'manual_review_pending'
      }),
      changed: submission('manual_review_pending', {
        kind: 'feedback',
        assets: [],
        statusVersion: 4,
        preQuarantineStatus: null
      })
    },
    {
      name: '文本恢复到已发布',
      action: 'restore' as const,
      initial: submission('deleted_quarantined', {
        kind: 'feedback',
        assets: [],
        preQuarantineStatus: 'published'
      }),
      changed: submission('published', {
        kind: 'feedback',
        assets: [],
        statusVersion: 4,
        preQuarantineStatus: null
      })
    }
  ])('$name 首次成功后相同请求交给数据库回放且新 key 仍被拒绝', async ({
    action,
    initial,
    changed
  }) => {
    const idempotencyKey = `replay-${action}-${initial.kind}`;
    const { service, store } = createService(initial);
    store.findAdminSubmission
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(changed);
    store.applyAdminAction.mockImplementation(async input => {
      if (input.idempotencyKey !== idempotencyKey) {
        throw new ApiError('INVALID_ADMIN_ACTION', 409);
      }
      return {
        submission: {
          id: initial.id,
          status: changed.status,
          statusVersion: 4
        },
        replayed: store.applyAdminAction.mock.calls.length > 1
      };
    });
    const request = {
      action,
      version: 3,
      idempotencyKey,
      reason: '保持原请求'
    };

    await expect(service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      initial.id,
      request
    )).resolves.toMatchObject({ replayed: false });
    await expect(service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      initial.id,
      request
    )).resolves.toMatchObject({ replayed: true });
    await expect(service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      initial.id,
      { ...request, idempotencyKey: `${idempotencyKey}-new` }
    )).rejects.toMatchObject({ code: 'INVALID_ADMIN_ACTION' });
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

function currentEvidence(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    submissionId: 'submission-1',
    packageStorageKey: 'private/current-pet.zip',
    packageSizeBytes: 20,
    archiveSizeBytes: 20,
    archiveSha256: 'a'.repeat(64),
    protocolVersion: '2026-08-15',
    ruleVersion: 'character-package-2026-08-15',
    scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED',
    completedAt: '2026-07-31T00:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
    submissionStatusVersion: 3,
    ...overrides
  };
}
