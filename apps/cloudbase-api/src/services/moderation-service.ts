import type {
  Clock,
  ContentModerator,
  ModerationJobStore,
  ModerationRecord,
  ModerationSignal,
  ObjectStorage,
  PackageScanner,
  SubmissionWithAssets
} from '../ports.js';

export interface ModerationProcessResult {
  status: 'manual_review_pending' | 'auto_rejected';
  applied: boolean;
}

export interface BatchResult {
  claimed: number;
  succeeded: number;
  failed: number;
}

const leaseMilliseconds = 10 * 60 * 1000;
// 为跨地域请求预留一分钟时钟偏差，避免扫描器把临界的五分钟链接误判为超时。
const signedUrlSeconds = 4 * 60;

class ModerationDependencyError extends Error {
  constructor(
    message: string,
    readonly results: readonly ModerationRecord[]
  ) {
    super(message);
  }
}

/** 编排自动审核依赖；任何依赖失败均由数据库安排重试，禁止失败放行。 */
export class ModerationService {
  constructor(
    private readonly store: ModerationJobStore,
    private readonly storage: ObjectStorage,
    private readonly moderator: ContentModerator,
    private readonly scanner: PackageScanner,
    private readonly clock: Clock
  ) {}

  async process(submissionId: string): Promise<ModerationProcessResult> {
    const submission = await this.store.findById(submissionId);
    if (!submission || submission.status !== 'system_reviewing') {
      throw new Error('MODERATION_JOB_STALE');
    }
    const expectedVersion = submission.statusVersion ?? 0;
    const results: ModerationRecord[] = [];

    try {
      const fileSignals = submission.kind === 'shared_package'
        ? await this.reviewSharedPackage(submission, results)
        : [];
      const technicalBlocked = fileSignals.some(signal => (
        signal.suggestion === 'Block'
        && signal.label.startsWith('技术检查：')
      ));
      if (technicalBlocked) {
        return this.persistDecision(
          submission,
          expectedVersion,
          results,
          fileSignals
        );
      }
      const textSignals = await this.reviewBaseText(submission, results);
      const signals = [...textSignals, ...fileSignals];
      return this.persistDecision(
        submission,
        expectedVersion,
        results,
        signals
      );
    } catch (error) {
      if (error instanceof ModerationDependencyError) throw error;
      throw new ModerationDependencyError(safeErrorSummary(error), results);
    }
  }

  async processNextBatch(limit: number): Promise<BatchResult> {
    const maximum = Math.min(3, Math.max(1, Math.trunc(limit)));
    const leaseUntil = new Date(
      this.clock.now().getTime() + leaseMilliseconds
    ).toISOString();
    const jobs = await this.store.claimModerationJobs(maximum, leaseUntil);
    let succeeded = 0;
    let failed = 0;

    for (const job of jobs) {
      try {
        await this.process(job.id);
        succeeded += 1;
      } catch (error) {
        failed += 1;
        try {
          await this.store.recordModerationFailure({
            submissionId: job.id,
            expectedVersion: job.statusVersion ?? 0,
            errorSummary: safeErrorSummary(error),
            results: error instanceof ModerationDependencyError
              ? error.results
              : []
          });
        } catch {
          // 单项失败记录异常不能阻止本批其他任务，租约到期后可再次处理。
        }
      }
    }
    return { claimed: jobs.length, succeeded, failed };
  }

  private async reviewBaseText(
    submission: SubmissionWithAssets,
    results: ModerationRecord[]
  ): Promise<ModerationSignal[]> {
    const signals: ModerationSignal[] = [];
    for (const [kind, text] of [
      ['title', submission.title ?? ''],
      ['body', submission.body ?? '']
    ] as const) {
      if (!text.trim()) continue;
      const signal = await this.runSignal(
        () => this.moderator.reviewText({ text }),
        results,
        submission.id,
        kind,
        'tencent-tms'
      );
      signals.push(signal);
    }
    return signals;
  }

  private async reviewSharedPackage(
    submission: SubmissionWithAssets,
    results: ModerationRecord[]
  ): Promise<ModerationSignal[]> {
    const packageAsset = submission.assets.find(asset => asset.role === 'package');
    const coverAsset = submission.assets.find(asset => asset.role === 'cover');
    if (!packageAsset || !coverAsset) {
      throw new ModerationDependencyError('MODERATION_ASSET_MISSING', results);
    }

    const packageUrl = await this.dependency(
      () => this.storage.createSignedUrl(
        packageAsset.storageKey,
        signedUrlSeconds
      ),
      results
    );
    const scan = await this.dependency(
      () => this.scanner.scan({
        submissionId: submission.id,
        downloadUrl: packageUrl.url,
        expiresAt: packageUrl.expiresAt
      }),
      results
    );
    if (!scan.complete) {
      throw new ModerationDependencyError('PACKAGE_SCAN_INCOMPLETE', results);
    }

    const signals: ModerationSignal[] = [];
    const technicalSignal: ModerationSignal = scan.safe
      ? { suggestion: 'Pass', label: `技术检查：${scan.code}` }
      : { suggestion: 'Block', label: `技术检查：${scan.code}` };
    results.push(this.record(submission.id, 'package_scan', 'isolated-scanner', technicalSignal, {
      fileCount: scan.summary.fileCount,
      totalUncompressedBytes: scan.summary.totalUncompressedBytes,
      packageStorageKey: packageAsset.storageKey,
      packageSizeBytes: packageAsset.actualBytes,
      scanCode: scan.code
    }));
    signals.push(technicalSignal);
    if (!scan.safe) return signals;

    const jsonReviews = await this.dependency(
      () => mapConcurrentOrdered(
        scan.jsonTexts,
        32,
        async jsonText => ({
          signal: await this.moderator.reviewText({ text: jsonText.text }),
          path: jsonText.path
        })
      ),
      results
    );
    for (const review of jsonReviews) {
      results.push(this.record(
        submission.id,
        'package_json_text',
        'tencent-tms',
        review.signal,
        { path: review.path.slice(0, 1024) }
      ));
      signals.push(review.signal);
    }
    for (const imageSignal of scan.imageSignals) {
      const signal: ModerationSignal = {
        suggestion: imageSignal.suggestion,
        label: imageSignal.labels.join(',').slice(0, 100) || 'Unknown'
      };
      results.push(this.record(
        submission.id,
        'package_image',
        'scanner-tencent-ims',
        signal,
        { path: imageSignal.path.slice(0, 1024) }
      ));
      signals.push(signal);
    }
    const ocrInputs = scan.imageSignals.filter(
      (signal): signal is typeof signal & { ocrText: string } =>
        Boolean(signal.ocrText?.trim())
    );
    const ocrReviews = await this.dependency(
      () => mapConcurrentOrdered(
        ocrInputs,
        32,
        async imageSignal => ({
          signal: await this.moderator.reviewText({
            text: imageSignal.ocrText
          }),
          path: imageSignal.path
        })
      ),
      results
    );
    for (const review of ocrReviews) {
      results.push(this.record(
        submission.id,
        'package_image_ocr',
        'tencent-tms',
        review.signal,
        { path: review.path.slice(0, 1024) }
      ));
      signals.push(review.signal);
    }

    const coverUrl = await this.dependency(
      () => this.storage.createSignedUrl(
        coverAsset.storageKey,
        signedUrlSeconds
      ),
      results
    );
    const coverSignal = await this.runSignal(
      () => this.moderator.reviewImage({ imageUrl: coverUrl.url }),
      results,
      submission.id,
      'cover_image',
      'tencent-ims'
    );
    signals.push(coverSignal);
    return signals;
  }

  private async runSignal(
    operation: () => Promise<ModerationSignal>,
    results: ModerationRecord[],
    submissionId: string,
    kind: string,
    provider: string,
    evidence: Record<string, unknown> = {}
  ): Promise<ModerationSignal> {
    const signal = await this.dependency(operation, results);
    results.push(this.record(submissionId, kind, provider, signal, evidence));
    return signal;
  }

  private async dependency<T>(
    operation: () => Promise<T>,
    results: ModerationRecord[]
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new ModerationDependencyError(safeErrorSummary(error), results);
    }
  }

  private record(
    submissionId: string,
    kind: string,
    provider: string,
    signal: ModerationSignal,
    evidence: Record<string, unknown> = {}
  ): ModerationRecord {
    const timestamp = this.clock.now().toISOString();
    return {
      submissionId,
      kind: kind.slice(0, 100),
      provider: provider.slice(0, 100),
      ruleVersion: '2026-07-31',
      suggestion: signal.suggestion,
      label: signal.label.slice(0, 100),
      score: null,
      evidence,
      requestedAt: timestamp,
      completedAt: timestamp,
      errorMessage: null
    };
  }

  private async persistDecision(
    submission: SubmissionWithAssets,
    expectedVersion: number,
    results: readonly ModerationRecord[],
    signals: readonly ModerationSignal[]
  ): Promise<ModerationProcessResult> {
    // 自动检查只保留风险证据，发布与驳回统一由管理员决定。
    const blocked = signals.some(signal => signal.suggestion === 'Block');
    const status = 'manual_review_pending' as const;
    const blockedLabels = signals
      .filter(signal => signal.suggestion === 'Block')
      .map(signal => signal.label)
      .slice(0, 20);
    const applied = await this.store.applyModerationDecision({
      submissionId: submission.id,
      expectedVersion,
      nextStatus: status,
      results,
      riskSummary: {
        blocked,
        signalCount: results.length,
        blockedLabels
      },
      autoRejectionReason: null
    });
    return { status, applied };
  }
}

/** 只保留稳定错误码或裁剪消息，避免密钥和供应商响应落库。 */
function safeErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : 'MODERATION_FAILED';
  return /^[A-Z][A-Z0-9_]{2,100}$/u.test(message)
    ? message
    : 'MODERATION_DEPENDENCY_FAILED';
}

async function mapConcurrentOrdered<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failure: unknown;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (failure === undefined && nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await operation(values[index]!, index);
        } catch (error) {
          failure = error;
        }
      }
    }
  );
  await Promise.all(workers);
  if (failure !== undefined) throw failure;
  return results;
}
