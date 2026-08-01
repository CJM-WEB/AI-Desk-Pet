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

function sharedSubmission(): SubmissionWithAssets {
  return {
    id: 'submission-1',
    kind: 'shared_package',
    title: '桌宠包',
    body: '用于 AI Pet 的资源',
    status: 'system_reviewing',
    statusVersion: 2,
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
    ]
  };
}

const safeScan: PackageScanResult = {
  complete: true,
  safe: true,
  code: 'CHARACTER_PACKAGE_SCAN_PASSED',
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
  scan?: PackageScanResult;
  relevance?: 'pass' | 'review' | 'reject';
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
    scan: vi.fn().mockResolvedValue(overrides.scan ?? safeScan)
  };
  const relevance = {
    classify: vi.fn().mockResolvedValue(overrides.relevance ?? 'pass')
  };
  return {
    store,
    moderator,
    scanner,
    relevance,
    service: new ModerationService(
      store,
      createStorage(),
      moderator,
      relevance,
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

  it('相关性拒绝时自动驳回', async () => {
    const { service } = createService({ relevance: 'reject' });
    await expect(service.process('submission-1')).resolves.toEqual(
      expect.objectContaining({ status: 'auto_rejected' })
    );
  });

  it.each([
    ['pass' as const, 'Pass', 'AI_PET_PASS'],
    ['review' as const, 'Review', 'AI_PET_REVIEW']
  ])('记录本地关键词审核来源和版本：%s', async (
    relevanceSuggestion,
    signalSuggestion,
    label
  ) => {
    const { service, store } = createService({
      relevance: relevanceSuggestion
    });

    await service.process('submission-1');

    const records = store.applyModerationDecision.mock.calls[0]![0].results;
    expect(records.find(
      (record: ModerationRecord) => record.kind === 'relevance'
    )).toMatchObject({
      provider: 'local-keyword',
      ruleVersion: 'keyword-relevance-2026-08-01',
      suggestion: signalSuggestion,
      label
    });
    expect(store.applyModerationDecision).toHaveBeenCalledWith(
      expect.objectContaining({ nextStatus: 'manual_review_pending' })
    );
  });

  it('技术扫描明确不安全后直接原子驳回且不被后续依赖故障拖延', async () => {
    const { service, store, moderator, relevance } = createService({
      scan: {
        ...safeScan,
        safe: false,
        code: 'CHARACTER_PACKAGE_MALWARE_DETECTED'
      }
    });
    relevance.classify.mockRejectedValue(new Error('RELEVANCE_UNAVAILABLE'));

    await expect(service.process('submission-1')).resolves.toEqual({
      status: 'auto_rejected',
      applied: true
    });
    expect(relevance.classify).not.toHaveBeenCalled();
    expect(moderator.reviewText).not.toHaveBeenCalled();
    expect(store.applyModerationDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        nextStatus: 'auto_rejected',
        autoRejectionReason:
          '技术检查：CHARACTER_PACKAGE_MALWARE_DETECTED'
      })
    );
  });

  it('技术扫描未完成时保持系统审核并进入持久化重试', async () => {
    const { service, store } = createService({
      scan: { ...safeScan, complete: false }
    });

    await expect(service.process('submission-1')).rejects.toThrow(
      'PACKAGE_SCAN_INCOMPLETE'
    );
    expect(store.applyModerationDecision).not.toHaveBeenCalled();
  });

  it('共享包使用五分钟私有 URL 扫描并审核 JSON、OCR 与封面', async () => {
    const { service, scanner, moderator, store } = createService();

    await service.process('submission-1');

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
      packageStorageKey: 'private/pet.zip',
      packageSizeBytes: 20,
      scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED'
    });
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
    const { service, scanner, moderator, relevance } = createService({ store });

    await service.process('feedback-1');

    expect(scanner.scan).not.toHaveBeenCalled();
    expect(moderator.reviewImage).not.toHaveBeenCalled();
    expect(moderator.reviewText).toHaveBeenCalledTimes(2);
    expect(relevance.classify).toHaveBeenCalledWith({
      title: '匿名用户',
      body: '希望增加桌宠动作'
    });
  });

  it('批处理中单个失败不阻止其他任务并记录持久化退避', async () => {
    const first = sharedSubmission();
    const second = { ...sharedSubmission(), id: 'submission-2' };
    const store = createStore(first);
    store.claimModerationJobs.mockResolvedValue([first, second]);
    store.findById
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const { service, relevance } = createService({ store });
    relevance.classify
      .mockRejectedValueOnce(new Error('RELEVANCE_UNAVAILABLE'))
      .mockResolvedValueOnce('pass');

    const result = await service.processNextBatch(3);

    expect(result).toEqual({ claimed: 2, succeeded: 1, failed: 1 });
    expect(store.recordModerationFailure).toHaveBeenCalledWith({
      submissionId: 'submission-1',
      expectedVersion: 2,
      errorSummary: 'RELEVANCE_UNAVAILABLE',
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
    const { service, relevance } = createService({ store });
    relevance.classify
      .mockRejectedValueOnce(new Error('RELEVANCE_UNAVAILABLE'))
      .mockResolvedValueOnce('pass');

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
