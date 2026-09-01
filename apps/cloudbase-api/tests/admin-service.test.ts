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
        kind: row.kind ?? 'shared_package',
        status: input.nextStatus as AdminSubmissionDetail['status'],
        statusVersion: 4,
        publicationBasis: input.nextStatus === 'published'
          ? (input.action === 'force_publish'
              ? 'admin_override' as const
              : 'standard' as const)
          : null,
        publicReason: null,
        publishedAt: input.nextStatus === 'published'
          ? '2026-07-31T12:00:00.000Z'
          : null,
        rejectedAt: null,
        quarantinedAt: null,
        createdAt: '2026-07-30T12:00:00.000Z',
        updatedAt: '2026-07-31T12:00:00.000Z'
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
  it('详情只为当前有效的私有 ZIP 签发五分钟待审下载', async () => {
    const row = submission('manual_review_pending');
    const { service, storage } = createService(row);

    await expect(service.getDetail(row.id)).resolves.toMatchObject({
      packageDownload: {
        url: 'https://preview.example/cover.webp',
        expiresAt: '2026-07-31T00:05:00.000Z'
      }
    });
    expect(storage.createSignedUrl).toHaveBeenCalledWith('private/current-pet.zip', 300);
  });

  it.each([
    ['反馈投稿', submission('manual_review_pending', { kind: 'feedback', assets: [] })],
    ['非 ZIP 包', submission('manual_review_pending', {
      assets: [{
        role: 'package', storageKey: 'private/current-pet.tar', fileName: 'pet.tar',
        declaredBytes: 20, actualBytes: 20, contentType: 'application/x-tar'
      }]
    })],
    ['空 ZIP', submission('manual_review_pending', {
      assets: [{
        role: 'package', storageKey: 'private/empty.zip', fileName: 'empty.zip',
        declaredBytes: 0, actualBytes: 0, contentType: 'application/zip'
      }]
    })]
  ])('%s 不签发待审 ZIP', async (_name, row) => {
    const { service, storage } = createService(row);

    await expect(service.getDetail(row.id)).resolves.toMatchObject({ packageDownload: null });
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });

  it('待审 ZIP 签名失败时降级为空且不泄露存储错误', async () => {
    const row = submission('manual_review_pending');
    const { service, storage } = createService(row);
    storage.createSignedUrl.mockRejectedValueOnce(new Error('private/current-pet.zip'));

    await expect(service.getDetail(row.id)).resolves.toMatchObject({
      body: '资源说明',
      packageDownload: null
    });
  });

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

  it('隔离共享包恢复只回到人工审核', async () => {
    const quarantined = submission('deleted_quarantined', {
      preQuarantineStatus: 'published'
    });
    const { service, store } = createService(quarantined);
    await service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      quarantined.id,
      {
        action: 'restore', version: 3,
        idempotencyKey: 'manual-restored-package', reason: '恢复后人工复核'
      }
    );
    expect(store.applyAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ nextStatus: 'manual_review_pending' })
    );
  });

  it.each(['feedback', 'suggestion', 'shared_package'] as const)(
    'system_reviewing 的 %s 转人工统一进入 manual_review_pending',
    async kind => {
      const row = submission('system_reviewing', {
        kind,
        assets: kind === 'shared_package' ? submission('system_reviewing').assets : []
      });
      const { service, store } = createService(row);

      await service.applyAction(
        { uid: 'uid-admin', email: 'admin@example.com' },
        row.id,
        {
          action: 'move_to_manual',
          version: 3,
          idempotencyKey: `move-system-${kind}`,
          reason: '管理员要求人工复核'
        }
      );

      expect(store.applyAdminAction).toHaveBeenCalledWith(expect.objectContaining({
        action: 'move_to_manual',
        nextStatus: 'manual_review_pending'
      }));
    }
  );

  it('自动驳回的共享包转人工时不重写扫描事实', async () => {
    const row = submission('auto_rejected', {
      moderationResults: [moderationResult('Block', { scanCode: 'MALWARE_DETECTED' })]
    });
    const { service, store } = createService(row);

    await service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      row.id,
      {
        action: 'move_to_manual',
        version: 3,
        idempotencyKey: 'move-rejected-package',
        reason: '保留危险结论并人工复核'
      }
    );

    expect(store.applyAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      nextStatus: 'manual_review_pending'
    }));
  });

  it('缺少当前通过证据的待审共享包可携带精确确认值强制发布', async () => {
    const row = submission('manual_review_pending', { moderationResults: [] });
    const { service, store } = createService(row);

    await expect(service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      row.id,
      {
        action: 'force_publish',
        version: 3,
        idempotencyKey: 'force-publish-package',
        reason: '管理员接受未通过扫描的风险',
        riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED'
      }
    )).resolves.toMatchObject({
      submission: {
        status: 'published',
        publicationBasis: 'admin_override'
      }
    });
    expect(store.applyAdminAction).toHaveBeenCalledWith({
      submissionId: row.id,
      adminId: 'uid-admin',
      action: 'force_publish',
      nextStatus: 'published',
      expectedVersion: 3,
      idempotencyKey: 'force-publish-package',
      reason: '管理员接受未通过扫描的风险',
      riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED'
    });
  });

  it.each([
    ['资产归档 SHA 与证据不一致', (row: AdminSubmissionDetail) => {
      Object.assign(row.assets[0]!, { sha256: 'b'.repeat(64) });
    }],
    ['审核行规则版本与证据不一致', (row: AdminSubmissionDetail) => {
      Object.assign(row.moderationResults[0]!, {
        ruleVersion: 'character-package-legacy'
      });
    }],
    ['审核行完成时间与证据不一致', (row: AdminSubmissionDetail) => {
      Object.assign(row.moderationResults[0]!, {
        completedAt: '2026-07-31T00:00:01.000Z'
      });
    }]
  ] as const)('伪完整证据的%s必须交给数据库原子裁决', async (_name, mismatch) => {
    const row = submission('manual_review_pending', {
      moderationResults: [moderationResult('Pass', currentEvidence())]
    });
    mismatch(row);
    const { service, store } = createService(row);

    await expect(service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      row.id,
      {
        action: 'force_publish',
        version: 3,
        idempotencyKey: `force-db-evidence-${_name}`,
        reason: '由数据库核对真实证据行',
        riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED'
      }
    )).resolves.toMatchObject({
      submission: { publicationBasis: 'admin_override' }
    });
    expect(store.applyAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'force_publish',
      nextStatus: 'published'
    }));
  });

  it('真正有效证据由数据库拒绝强制发布并保持既有错误契约', async () => {
    const row = submission('manual_review_pending', {
      moderationResults: [moderationResult('Pass', currentEvidence())]
    });
    const { service, store } = createService(row);
    store.applyAdminAction.mockRejectedValueOnce(
      new ApiError('INVALID_ADMIN_ACTION', 409)
    );

    await expect(service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      row.id,
      {
        action: 'force_publish',
        version: 3,
        idempotencyKey: 'force-publish-scanned-package',
        reason: '不应覆盖标准发布依据',
        riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED'
      }
    )).rejects.toMatchObject({ code: 'INVALID_ADMIN_ACTION', statusCode: 409 });
    expect(store.applyAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'force_publish',
      nextStatus: 'published'
    }));
  });

  it.each([
    ['反馈投稿', submission('manual_review_pending', { kind: 'feedback', assets: [] })],
    ['系统审核中的共享包', submission('system_reviewing')],
    ['自动驳回的共享包', submission('auto_rejected')]
  ])('%s不能一步强制发布', async (_name, row) => {
    const { service, store } = createService(row);

    await expect(service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      row.id,
      {
        action: 'force_publish',
        version: 3,
        idempotencyKey: `invalid-force-${row.kind}-${row.status}`,
        reason: '不满足强制发布前置状态',
        riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED'
      }
    )).rejects.toMatchObject({ code: 'INVALID_ADMIN_ACTION', statusCode: 409 });
    expect(store.applyAdminAction).not.toHaveBeenCalled();
  });

  it('服务边界对绕过 Schema 的错误风险确认继续失败关闭', async () => {
    const row = submission('manual_review_pending');
    const { service, store } = createService(row);

    await expect(service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      row.id,
      {
        action: 'force_publish',
        version: 3,
        idempotencyKey: 'invalid-force-acknowledgement',
        reason: '确认值错误',
        riskAcknowledgement: 'WRONG_VALUE'
      } as never
    )).rejects.toMatchObject({ code: 'INVALID_ADMIN_ACTION', statusCode: 409 });
    expect(store.applyAdminAction).not.toHaveBeenCalled();
  });

  it.each([
    ['后到危险扫描', submission('published', {
      statusVersion: 4,
      publicationBasis: 'admin_override',
      moderationResults: [moderationResult('Block', {
        scanCode: 'CHARACTER_PACKAGE_MALWARE_DETECTED'
      })]
    })],
    ['删除隔离', submission('deleted_quarantined', {
      statusVersion: 5,
      publicationBasis: null,
      preQuarantineStatus: 'published'
    })],
    ['永久清理', submission('purged', {
      statusVersion: 6,
      publicationBasis: null,
      assets: []
    })]
  ])('强制发布后发生%s仍把同键请求交给数据库回放', async (name, changed) => {
    const initial = submission('manual_review_pending');
    const idempotencyKey = `force-replay-${name}`;
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
          kind: 'shared_package',
          status: 'published',
          statusVersion: 4,
          publicationBasis: 'admin_override',
          publicReason: null,
          publishedAt: '2026-07-31T12:00:00.000Z',
          rejectedAt: null,
          quarantinedAt: null,
          createdAt: '2026-07-30T12:00:00.000Z',
          updatedAt: '2026-07-31T12:00:00.000Z'
        },
        replayed: store.applyAdminAction.mock.calls.length > 1
      };
    });
    const request = {
      action: 'force_publish' as const,
      version: 3,
      idempotencyKey,
      reason: '保持首次强制发布请求',
      riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED' as const
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

  it.each([
    {
      name: '共享包转人工',
      action: 'move_to_manual' as const,
      initial: submission('auto_rejected'),
      changed: submission('manual_review_pending', { statusVersion: 4 })
    },
    {
      name: '共享包恢复',
      action: 'restore' as const,
      initial: submission('deleted_quarantined', { preQuarantineStatus: 'published' }),
      changed: submission('manual_review_pending', { statusVersion: 4, preQuarantineStatus: null })
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
          kind: initial.kind ?? 'shared_package',
          status: changed.status,
          statusVersion: 4,
          publicationBasis: changed.status === 'published'
            ? 'standard' as const
            : null,
          publicReason: null,
          publishedAt: changed.status === 'published'
            ? '2026-07-31T12:00:00.000Z'
            : null,
          rejectedAt: null,
          quarantinedAt: null,
          createdAt: '2026-07-30T12:00:00.000Z',
          updatedAt: '2026-07-31T12:00:00.000Z'
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

  it.each([
    {
      name: '共享包再次强制发布',
      initial: submission('deleted_quarantined', { preQuarantineStatus: 'published' }),
      changed: submission('published', {
        statusVersion: 5,
        publicationBasis: 'admin_override',
        preQuarantineStatus: null
      }),
      firstStatus: 'manual_review_pending',
      replayNextStatus: 'manual_review_pending'
    },
    {
      name: '共享包永久清理',
      initial: submission('deleted_quarantined', { preQuarantineStatus: 'published' }),
      changed: submission('purged', {
        statusVersion: 8,
        assets: [],
        preQuarantineStatus: null
      }),
      firstStatus: 'manual_review_pending',
      replayNextStatus: 'manual_review_pending'
    },
    {
      name: '反馈再次驳回',
      initial: submission('deleted_quarantined', {
        kind: 'feedback', assets: [], preQuarantineStatus: 'manual_review_pending'
      }),
      changed: submission('admin_rejected', {
        kind: 'feedback', assets: [], statusVersion: 5, preQuarantineStatus: null
      }),
      firstStatus: 'manual_review_pending',
      replayNextStatus: 'admin_rejected'
    },
    {
      name: '建议永久清理',
      initial: submission('deleted_quarantined', {
        kind: 'suggestion', assets: [], preQuarantineStatus: 'published'
      }),
      changed: submission('purged', {
        kind: 'suggestion', assets: [], statusVersion: 8, preQuarantineStatus: null
      }),
      firstStatus: 'published',
      replayNextStatus: 'purged'
    }
  ] as const)('$name 后旧 restore key 仍到达数据库并回放首次快照', async ({
    name,
    initial,
    changed,
    firstStatus,
    replayNextStatus
  }) => {
    const idempotencyKey = `restore-lifecycle-${name}`;
    const requestedVersion = 3;
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
          kind: initial.kind ?? 'shared_package',
          status: firstStatus,
          statusVersion: requestedVersion + 1,
          publicationBasis: firstStatus === 'published' ? 'standard' as const : null,
          publicReason: null,
          publishedAt: firstStatus === 'published'
            ? '2026-07-31T12:00:00.000Z'
            : null,
          rejectedAt: null,
          quarantinedAt: null,
          createdAt: '2026-07-30T12:00:00.000Z',
          updatedAt: '2026-07-31T12:00:00.000Z'
        },
        replayed: store.applyAdminAction.mock.calls.length > 1
      };
    });
    const request = {
      action: 'restore' as const,
      version: requestedVersion,
      idempotencyKey,
      reason: '保持首次恢复请求'
    };

    await expect(service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      initial.id,
      request
    )).resolves.toMatchObject({
      submission: { status: firstStatus },
      replayed: false
    });
    await expect(service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      initial.id,
      request
    )).resolves.toMatchObject({
      submission: { status: firstStatus },
      replayed: true
    });
    expect(store.applyAdminAction.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      nextStatus: replayNextStatus,
      expectedVersion: requestedVersion
    }));

    await expect(service.applyAction(
      { uid: 'uid-admin', email: 'admin@example.com' },
      initial.id,
      { ...request, idempotencyKey: `${idempotencyKey}-new` }
    )).rejects.toMatchObject({ code: 'INVALID_ADMIN_ACTION' });
    expect(store.applyAdminAction).toHaveBeenCalledTimes(3);
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
