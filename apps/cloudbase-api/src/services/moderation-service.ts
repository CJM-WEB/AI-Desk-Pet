import {
  TECHNICAL_SCAN_PROTOCOL_VERSION,
  TECHNICAL_SCAN_RULE_VERSION,
  technicalScanEvidenceSchema
} from '@myself/shared-types';

import type {
  Clock,
  ContentModerator,
  ModerationJobStore,
  ModerationRecord,
  ModerationSignal,
  ObjectStorage,
  PackageScanner,
  PackageScanResult,
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
const technicalEvidenceTtlMilliseconds = 24 * 60 * 60 * 1000;
// 已领取版本只允许经过“转人工、强制发布”两个审计动作后进入后到结果分支。
const adminOverridePublicationVersionAdvances = 2;

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

  async process(
    submissionId: string,
    claimedVersion?: number
  ): Promise<ModerationProcessResult> {
    const submission = await this.store.findById(submissionId);
    const lateResult = submission !== null
      && submission.kind === 'shared_package'
      && submission.status === 'published'
      && submission.publicationBasis === 'admin_override'
      && claimedVersion !== undefined
      && submission.statusVersion
        === claimedVersion + adminOverridePublicationVersionAdvances;
    if (!submission || (submission.status !== 'system_reviewing' && !lateResult)) {
      throw new Error('MODERATION_JOB_STALE');
    }
    const expectedVersion = lateResult
      ? claimedVersion
      : submission.statusVersion ?? 0;
    const results: ModerationRecord[] = [];

    try {
      const fileSignals = submission.kind === 'shared_package'
        ? await this.reviewSharedPackage(submission, results, lateResult)
        : [];
      const technicalBlocked = fileSignals.some(signal => (
        signal.suggestion === 'Block'
        && signal.label.startsWith('技术检查：')
      ));
      if (lateResult || technicalBlocked) {
        return this.persistDecision(
          submission,
          expectedVersion,
          results,
          fileSignals,
          lateResult
        );
      }
      const textSignals = await this.reviewBaseText(submission, results);
      const signals = [...textSignals, ...fileSignals];
      return this.persistDecision(
        submission,
        expectedVersion,
        results,
        signals,
        lateResult
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
        await this.process(job.id, job.statusVersion ?? 0);
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
    results: ModerationRecord[],
    technicalOnly = false
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
    const technicalEvidence = scan.safe
      ? this.createTechnicalPassEvidence(submission, packageAsset, scan)
      : {
          fileCount: scan.summary.fileCount,
          totalUncompressedBytes: scan.summary.totalUncompressedBytes,
          scanCode: scan.code
        };
    results.push(this.record(
      submission.id,
      'package_scan',
      'isolated-scanner',
      technicalSignal,
      technicalEvidence,
      scan.safe ? scan.ruleVersion : '2026-07-31',
      scan.safe ? scan.completedAt : undefined
    ));
    signals.push(technicalSignal);
    if (!scan.safe || technicalOnly) return signals;

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

  private createTechnicalPassEvidence(
    submission: SubmissionWithAssets,
    packageAsset: SubmissionWithAssets['assets'][number],
    scan: Extract<PackageScanResult, { complete: true; safe: true }>
  ): Record<string, unknown> {
    const completedAt = new Date(scan.completedAt ?? '');
    const expiresAt = new Date(
      completedAt.getTime() + technicalEvidenceTtlMilliseconds
    );
    const evidence = {
      submissionId: scan.submissionId,
      packageStorageKey: packageAsset.storageKey,
      packageSizeBytes: packageAsset.actualBytes,
      archiveSizeBytes: scan.archive?.sizeBytes,
      archiveSha256: scan.archive?.sha256,
      protocolVersion: scan.protocolVersion,
      ruleVersion: scan.ruleVersion,
      scanCode: scan.code,
      completedAt: scan.completedAt,
      expiresAt: Number.isFinite(expiresAt.getTime())
        ? expiresAt.toISOString()
        : undefined,
      // 决策事务成功后状态版本加一，证据直接绑定该最终版本。
      submissionStatusVersion: (submission.statusVersion ?? 0) + 1
    };
    const parsed = technicalScanEvidenceSchema.safeParse(evidence);
    if (
      !parsed.success
      || parsed.data.submissionId !== submission.id
      || parsed.data.packageSizeBytes !== parsed.data.archiveSizeBytes
      || parsed.data.packageSizeBytes !== packageAsset.actualBytes
      || parsed.data.protocolVersion !== TECHNICAL_SCAN_PROTOCOL_VERSION
      || parsed.data.ruleVersion !== TECHNICAL_SCAN_RULE_VERSION
      || completedAt.getTime() > this.clock.now().getTime()
      || expiresAt.getTime() <= this.clock.now().getTime()
    ) {
      throw new ModerationDependencyError(
        'PACKAGE_SCAN_EVIDENCE_INVALID',
        []
      );
    }
    return {
      fileCount: scan.summary.fileCount,
      totalUncompressedBytes: scan.summary.totalUncompressedBytes,
      ...parsed.data
    };
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
    evidence: Record<string, unknown> = {},
    ruleVersion = '2026-07-31',
    completedAt?: string
  ): ModerationRecord {
    const timestamp = this.clock.now().toISOString();
    return {
      submissionId,
      kind: kind.slice(0, 100),
      provider: provider.slice(0, 100),
      ruleVersion,
      suggestion: signal.suggestion,
      label: signal.label.slice(0, 100),
      score: null,
      evidence,
      requestedAt: timestamp,
      completedAt: completedAt ?? timestamp,
      errorMessage: null
    };
  }

  private async persistDecision(
    submission: SubmissionWithAssets,
    expectedVersion: number,
    results: readonly ModerationRecord[],
    signals: readonly ModerationSignal[],
    lateResult = false
  ): Promise<ModerationProcessResult> {
    const blocked = signals.some(signal => signal.suggestion === 'Block');
    const status = blocked ? 'auto_rejected' as const : 'manual_review_pending' as const;
    const blockedLabels = signals
      .filter(signal => signal.suggestion === 'Block')
      .map(signal => signal.label)
      .slice(0, 20);
    const input = {
      submissionId: submission.id,
      expectedVersion,
      nextStatus: status,
      results,
      riskSummary: {
        blocked,
        signalCount: results.length,
        blockedLabels
      },
      autoRejectionReason: blockedLabels[0] ?? null
    };
    const applied = lateResult
      ? await this.store.recordLateModerationResult(input)
      : await this.store.applyModerationDecision(input);
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
