import { describe, expect, it, vi } from 'vitest';

import { ModerationService } from '../src/services/moderation-service.js';
import type {
  ModerationJobStore,
  ModerationRecord,
  ModerationSignal,
  ObjectStorage,
  PackageScanResult,
  SubmissionWithAssets
} from '../src/ports.js';

const now = new Date('2026-07-31T00:00:00.000Z');

function sharedSubmission(
  overrides: Partial<SubmissionWithAssets> = {}
): SubmissionWithAssets {
  return {
    id: 'submission-1',
    kind: 'shared_package',
    title: '桌宠包',
    body: '用于 AI Pet 的资源',
    status: 'system_reviewing',
    statusVersion: 2,
    publicationBasis: null,
    assets: [
      {
        role: 'cover',
        storageKey: 'private/cover.webp',
        fileName: 'cover.webp',
        declaredBytes: 10,
        actualBytes: 10,
        contentType: 'image/webp'
      },
      {
        role: 'package',
        storageKey: 'private/pet.zip',
        fileName: 'pet.zip',
        declaredBytes: 20,
        actualBytes: 20,
        contentType: 'application/zip'
      }
    ],
    ...overrides
  };
}

const safeScan: PackageScanResult = {
  complete: true,
  safe: true,
  code: 'CHARACTER_PACKAGE_SCAN_PASSED',
  protocolVersion: '2026-08-15',
  ruleVersion: 'character-package-2026-08-15',
  submissionId: 'submission-1',
  completedAt: '2026-07-31T00:00:00.000Z',
  archive: {
    sizeBytes: 20,
    sha256: 'a'.repeat(64)
  },
  summary: { fileCount: 2, totalUncompressedBytes: 30 },
  jsonTexts: [{ path: 'manifest.json', text: '桌宠名称' }],
  imageSignals: [{
    path: 'avatar.webp',
    suggestion: 'Pass',
    labels: ['Normal'],
    ocrText: 'AI Pet'
  }]
};

function createStore(submission = sharedSubmission()) {
  return {
    claimModerationJobs: vi.fn().mockResolvedValue([submission]),
    findById: vi.fn().mockResolvedValue(submission),
    applyModerationDecision: vi.fn().mockResolvedValue(true),
    recordLateModerationResult: vi.fn().mockResolvedValue(true),
    recordModerationFailure: vi.fn().mockResolvedValue(undefined)
  } satisfies ModerationJobStore;
}

function createStorage() {
  return {
    createSignedUrl: vi.fn().mockImplementation(async (path: string) => ({
      url: `https://storage.example.com/${path}?sig=1`,
      expiresAt: '2026-07-31T00:05:00.000Z'
    }))
  } as unknown as ObjectStorage;
}

function createService(overrides: {
  signal?: ModerationSignal;
  scan?: PackageScanResult | (() => Promise<PackageScanResult>);
  store?: ReturnType<typeof createStore>;
  reviewText?: (input: { text: string }) => Promise<ModerationSignal>;
} = {}) {
  const store = overrides.store ?? createStore();
  const moderator = {
    reviewText: vi.fn(overrides.reviewText ?? (async (): Promise<ModerationSignal> => (
      overrides.signal ?? { suggestion: 'Pass', label: 'Normal' }
    ))),
    reviewImage: vi.fn().mockResolvedValue(
      overrides.signal ?? { suggestion: 'Pass', label: 'Normal' }
    )
  };
  const scanner = {
    scan: vi.fn(async (input: { submissionId: string }) => (
      typeof overrides.scan === 'function'
        ? overrides.scan()
        : overrides.scan ?? { ...safeScan, submissionId: input.submissionId }
    ))
  };
  const storage = createStorage();
  return {
    store,
    storage,
    moderator,
    scanner,
    service: new ModerationService(
      store,
      storage,
      moderator,
      scanner,
      { now: () => now }
    )
  };
}

describe('自动审核编排', () => {
  it.each([
    [{ suggestion: 'Block', label: 'Abuse' } as ModerationSignal, 'auto_rejected'],
    [{ suggestion: 'Review', label: 'Politics' } as ModerationSignal, 'manual_review_pending'],
    [{ suggestion: 'Pass', label: 'Normal' } as ModerationSignal, 'manual_review_pending']
  ])('把审核建议映射为固定状态', async (signal, expected) => {
    const { service, store } = createService({ signal });

    const result = await service.process('submission-1');

    expect(result.status).toBe(expected);
    expect(store.applyModerationDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionId: 'submission-1',
        expectedVersion: 2,
        nextStatus: expected,
        results: expect.any(Array)
      })
    );
    const decision = store.applyModerationDecision.mock.calls[0]![0];
    expect(decision.results.every(
      (result: ModerationRecord) => result.submissionId === 'submission-1'
    )).toBe(true);
  });

  it('内容审核明确阻断时自动驳回且不伪装成人工待审', async () => {
    const { service, store } = createService({
      signal: { suggestion: 'Block', label: 'Abuse' }
    });

    await expect(service.process('submission-1')).resolves.toEqual(
      expect.objectContaining({ status: 'auto_rejected' })
    );
    expect(store.applyModerationDecision).toHaveBeenCalledWith(
      expect.objectContaining({ nextStatus: 'auto_rejected' })
    );
    const records = store.applyModerationDecision.mock.calls[0]![0].results;
    expect(records.some(
      (record: ModerationRecord) => record.provider === 'local-keyword'
    )).toBe(false);
  });

  it('技术扫描不安全时保留风险证据并自动驳回', async () => {
    const { service, store, moderator } = createService({
      scan: {
        ...safeScan,
        safe: false,
        code: 'CHARACTER_PACKAGE_MALWARE_DETECTED'
      }
    });

    await expect(service.process('submission-1')).resolves.toEqual({
      status: 'auto_rejected',
      applied: true
    });
    expect(moderator.reviewText).not.toHaveBeenCalled();
    expect(store.applyModerationDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        nextStatus: 'auto_rejected'
      })
    );
  });

  it('已领取任务被强制发布后完成危险扫描时只记录后到技术事实', async () => {
    const claimed = sharedSubmission();
    const published = sharedSubmission({
      status: 'published',
      statusVersion: 4,
      publicationBasis: 'admin_override'
    });
    const store = createStore(published);
    store.claimModerationJobs.mockResolvedValue([claimed]);
    const { service } = createService({
      store,
      scan: {
        ...safeScan,
        safe: false,
        code: 'CHARACTER_PACKAGE_MALWARE_DETECTED'
      }
    });

    await expect(service.processNextBatch(1)).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      failed: 0
    });
    expect(store.recordLateModerationResult).toHaveBeenCalledWith({
      submissionId: claimed.id,
      expectedVersion: 2,
      nextStatus: 'auto_rejected',
      results: [expect.objectContaining({
        kind: 'package_scan',
        provider: 'isolated-scanner',
        suggestion: 'Block',
        label: '技术检查：CHARACTER_PACKAGE_MALWARE_DETECTED'
      })],
      riskSummary: {
        blocked: true,
        signalCount: 1,
        blockedLabels: ['技术检查：CHARACTER_PACKAGE_MALWARE_DETECTED']
      },
      autoRejectionReason: '技术检查：CHARACTER_PACKAGE_MALWARE_DETECTED'
    });
    expect(store.applyModerationDecision).not.toHaveBeenCalled();
    expect(store.recordModerationFailure).not.toHaveBeenCalled();
  });

  it('已领取任务被强制发布后完成安全扫描时跳过全部内容审核并保存唯一技术事实', async () => {
    const claimed = sharedSubmission();
    const published = sharedSubmission({
      status: 'published',
      statusVersion: 4,
      publicationBasis: 'admin_override'
    });
    const store = createStore(published);
    store.claimModerationJobs.mockResolvedValue([claimed]);
    const { service, moderator } = createService({
      store,
      scan: safeScan,
      reviewText: async () => {
        throw new Error('后到安全扫描不得调用内容审核');
      }
    });

    await expect(service.processNextBatch(1)).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      failed: 0
    });
    expect(moderator.reviewText).not.toHaveBeenCalled();
    expect(moderator.reviewImage).not.toHaveBeenCalled();
    expect(store.recordLateModerationResult).toHaveBeenCalledWith({
      submissionId: claimed.id,
      expectedVersion: 2,
      nextStatus: 'manual_review_pending',
      results: [expect.objectContaining({
        kind: 'package_scan',
        provider: 'isolated-scanner',
        suggestion: 'Pass',
        label: '技术检查：CHARACTER_PACKAGE_SCAN_PASSED'
      })],
      riskSummary: {
        blocked: false,
        signalCount: 1,
        blockedLabels: []
      },
      autoRejectionReason: null
    });
    expect(store.applyModerationDecision).not.toHaveBeenCalled();
    expect(store.recordModerationFailure).not.toHaveBeenCalled();
  });

  it('初读系统审核后并发强制发布仍提交完整结果交由原子 RPC 筛选', async () => {
    const store = createStore();
    let forcePublishedDuringScan = false;
    const { service } = createService({
      store,
      scan: async () => {
        forcePublishedDuringScan = true;
        return safeScan;
      }
    });

    await expect(service.process('submission-1')).resolves.toEqual({
      status: 'manual_review_pending',
      applied: true
    });
    expect(forcePublishedDuringScan).toBe(true);
    expect(store.findById).toHaveBeenCalledTimes(1);
    const results = store.applyModerationDecision.mock.calls[0]![0].results;
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'package_scan',
        provider: 'isolated-scanner'
      }),
      expect.objectContaining({ kind: 'package_json_text' })
    ]));
    expect(store.recordLateModerationResult).not.toHaveBeenCalled();
  });

  it('技术扫描未完成时保持系统审核并进入持久化重试', async () => {
    const { service, store } = createService({
      scan: { ...safeScan, complete: false, safe: false }
    });

    await expect(service.process('submission-1')).rejects.toThrow(
      'PACKAGE_SCAN_INCOMPLETE'
    );
    expect(store.applyModerationDecision).not.toHaveBeenCalled();
  });

  it('共享包使用五分钟私有 URL 扫描并审核 JSON、OCR 与封面', async () => {
    const { service, storage, scanner, moderator, store } = createService();

    await service.process('submission-1');

    expect(storage.createSignedUrl).toHaveBeenCalledWith(
      'private/pet.zip',
      4 * 60
    );
    expect(scanner.scan).toHaveBeenCalledWith({
      submissionId: 'submission-1',
      downloadUrl: 'https://storage.example.com/private/pet.zip?sig=1',
      expiresAt: '2026-07-31T00:05:00.000Z'
    });
    expect(moderator.reviewText).toHaveBeenCalledWith({ text: '桌宠名称' });
    expect(moderator.reviewText).toHaveBeenCalledWith({ text: 'AI Pet' });
    expect(moderator.reviewImage).toHaveBeenCalledWith({
      imageUrl: 'https://storage.example.com/private/cover.webp?sig=1'
    });
    const technical = store.applyModerationDecision.mock.calls[0]![0].results
      .find((result: ModerationRecord) => result.kind === 'package_scan');
    expect(technical?.evidence).toMatchObject({
      submissionId: 'submission-1',
      packageStorageKey: 'private/pet.zip',
      packageSizeBytes: 20,
      archiveSizeBytes: 20,
      archiveSha256: 'a'.repeat(64),
      protocolVersion: '2026-08-15',
      ruleVersion: 'character-package-2026-08-15',
      completedAt: '2026-07-31T00:00:00.000Z',
      expiresAt: '2026-08-01T00:00:00.000Z',
      submissionStatusVersion: 3,
      scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
    });
  });

  it('技术扫描记录沿用扫描完成时间并与证据时间保持一致', async () => {
    const scanCompletedAt = '2026-07-30T23:59:00.000Z';
    const { service, store } = createService({
      scan: { ...safeScan, completedAt: scanCompletedAt }
    });

    await service.process('submission-1');

    const technical = store.applyModerationDecision.mock.calls[0]![0].results
      .find((result: ModerationRecord) => result.kind === 'package_scan');
    expect(technical).toMatchObject({
      requestedAt: '2026-07-31T00:00:00.000Z',
      completedAt: scanCompletedAt,
      evidence: { completedAt: scanCompletedAt }
    });
  });

  it.each([
    ['归档大小', { archive: { sizeBytes: 19, sha256: 'a'.repeat(64) } }],
    ['投稿身份', { submissionId: 'submission-2' }],
    ['完成时间', { completedAt: 'invalid' }],
    ['TTL 等号边界', { completedAt: '2026-07-30T00:00:00.000Z' }]
  ])('扫描结果的%s不匹配时保持系统审核并重试', async (_name, change) => {
    const { service, store } = createService({
      scan: { ...safeScan, ...change }
    });

    await expect(service.process('submission-1')).rejects.toThrow(
      'PACKAGE_SCAN_EVIDENCE_INVALID'
    );
    expect(store.applyModerationDecision).not.toHaveBeenCalled();
  });

  it('大量 JSON 与 OCR 文本最多并发 32 项并保持证据顺序', async () => {
    let active = 0;
    let maximumActive = 0;
    const jsonTexts = Array.from({ length: 40 }, (_, index) => ({
      path: `${index}.json`,
      text: `JSON-${index}`
    }));
    const imageSignals = Array.from({ length: 40 }, (_, index) => ({
      path: `${index}.webp`,
      suggestion: 'Pass' as const,
      labels: ['Normal'],
      ocrText: `OCR-${index}`
    }));
    const { service, store } = createService({
      scan: { ...safeScan, jsonTexts, imageSignals },
      reviewText: async ({ text }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, 1));
        active -= 1;
        return { suggestion: 'Pass', label: text };
      }
    });

    await service.process('submission-1');

    expect(maximumActive).toBeLessThanOrEqual(32);
    const records = store.applyModerationDecision.mock.calls[0]![0].results;
    expect(records.filter(
      (record: ModerationRecord) => record.kind === 'package_json_text'
    ).map((record: ModerationRecord) => record.label)).toEqual(
      jsonTexts.map(item => item.text)
    );
    expect(records.filter(
      (record: ModerationRecord) => record.kind === 'package_image_ocr'
    ).map((record: ModerationRecord) => record.label)).toEqual(
      imageSignals.map(item => item.ocrText)
    );
  });

  it('反馈只审核作者名、正文与相关性而不调用文件依赖', async () => {
    const submission: SubmissionWithAssets = {
      id: 'feedback-1',
      kind: 'feedback',
      title: '匿名用户',
      body: '希望增加桌宠动作',
      status: 'system_reviewing',
      statusVersion: 0,
      assets: []
    };
    const store = createStore(submission);
    const { service, scanner, moderator } = createService({ store });

    await service.process('feedback-1');

    expect(scanner.scan).not.toHaveBeenCalled();
    expect(moderator.reviewImage).not.toHaveBeenCalled();
    expect(moderator.reviewText).toHaveBeenCalledTimes(2);
  });

  it('批处理中单个失败不阻止其他任务并记录持久化退避', async () => {
    const first = sharedSubmission();
    const second = { ...sharedSubmission(), id: 'submission-2' };
    const store = createStore(first);
    store.claimModerationJobs.mockResolvedValue([first, second]);
    store.findById
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const { service, moderator } = createService({ store });
    moderator.reviewText
      .mockRejectedValueOnce(new Error('TMS_UNAVAILABLE'))
      .mockResolvedValue({ suggestion: 'Pass', label: 'Normal' });

    const result = await service.processNextBatch(3);

    expect(result).toEqual({ claimed: 2, succeeded: 1, failed: 1 });
    expect(store.recordModerationFailure).toHaveBeenCalledWith({
      submissionId: 'submission-1',
      expectedVersion: 2,
      errorSummary: 'TMS_UNAVAILABLE',
      results: expect.any(Array)
    });
    expect(store.applyModerationDecision).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: 'submission-2' })
    );
  });

  it('单个失败记录写入异常也不阻止后续任务', async () => {
    const first = sharedSubmission();
    const second = { ...sharedSubmission(), id: 'submission-2' };
    const store = createStore(first);
    store.claimModerationJobs.mockResolvedValue([first, second]);
    store.findById
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    store.recordModerationFailure.mockRejectedValueOnce(
      new Error('DATABASE_UNAVAILABLE')
    );
    const { service, moderator } = createService({ store });
    moderator.reviewText
      .mockRejectedValueOnce(new Error('TMS_UNAVAILABLE'))
      .mockResolvedValue({ suggestion: 'Pass', label: 'Normal' });

    await expect(service.processNextBatch(3)).resolves.toEqual({
      claimed: 2,
      succeeded: 1,
      failed: 1
    });
  });

  it('每批最多领取三个任务并使用十分钟租约', async () => {
    const { service, store } = createService();
    await service.processNextBatch(99);
    expect(store.claimModerationJobs).toHaveBeenCalledWith(
      3,
      '2026-07-31T00:10:00.000Z'
    );
  });
});
