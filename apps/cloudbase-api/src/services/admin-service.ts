import {
  TECHNICAL_SCAN_PROTOCOL_VERSION,
  TECHNICAL_SCAN_RULE_VERSION,
  technicalScanEvidenceSchema
} from '@myself/shared-types';
import type { AdminAction, SubmissionStatus } from '@myself/shared-types';

import { ApiError } from '../errors.js';
import type {
  AdminActionResult,
  AdminIdentity,
  AdminQueuePage,
  AdminQueueQuery,
  AdminStore,
  AdminSubmissionDetail,
  AdminSubmissionDetailView,
  Clock,
  ObjectStorage
} from '../ports.js';

const technicalEvidenceTtlMilliseconds = 24 * 60 * 60 * 1000;

/** 管理员审核服务统一执行状态转换和技术扫描门禁。 */
export class AdminService {
  constructor(
    private readonly store: AdminStore,
    private readonly storage: Pick<ObjectStorage, 'createSignedUrl'>,
    private readonly clock: Clock
  ) {}

  listQueue(query: AdminQueueQuery): Promise<AdminQueuePage> {
    return this.store.listAdminSubmissions(query);
  }

  async getDetail(id: string): Promise<AdminSubmissionDetailView> {
    const detail = await this.store.findAdminSubmission(id);
    if (!detail) throw new ApiError('SUBMISSION_NOT_FOUND', 404);
    const cover = detail.assets.find(asset => (
      asset.role === 'cover'
      && ['image/jpeg', 'image/png', 'image/webp'].includes(asset.contentType)
      && asset.actualBytes !== null
      && asset.actualBytes > 0
    ));
    const packageAsset = detail.assets.find(asset => (
      asset.role === 'package'
      && asset.contentType === 'application/zip'
      && asset.actualBytes !== null
      && asset.actualBytes > 0
    ));
    return {
      ...detail,
      coverPreview: cover ? await safeSignedDownload(this.storage, cover.storageKey) : null,
      packageDownload: packageAsset
        ? await safeSignedDownload(this.storage, packageAsset.storageKey)
        : null
    };
  }

  async applyAction(
    identity: AdminIdentity,
    id: string,
    action: AdminAction
  ): Promise<AdminActionResult> {
    const submission = await this.store.findAdminSubmission(id);
    if (!submission) throw new ApiError('SUBMISSION_NOT_FOUND', 404);
    if (
      action.action === 'force_publish'
      && action.riskAcknowledgement !== 'ADMIN_OVERRIDE_ACCEPTED'
    ) {
      throw new ApiError('INVALID_ADMIN_ACTION', 409);
    }
    const nextStatus = nextStatusFor(
      submission,
      action.action,
      action.version,
      this.clock.now()
    );
    return this.store.applyAdminAction({
      submissionId: id,
      adminId: identity.uid,
      action: action.action,
      nextStatus,
      expectedVersion: action.version,
      idempotencyKey: action.idempotencyKey,
      reason: action.reason,
      ...(action.action === 'force_publish' ? {
        riskAcknowledgement: action.riskAcknowledgement
      } : {})
    });
  }
}

/** 短期下载只辅助管理员观察；签名失败不得暴露私有路径或阻断审核动作。 */
async function safeSignedDownload(
  storage: Pick<ObjectStorage, 'createSignedUrl'>,
  storageKey: string
): Promise<Awaited<ReturnType<ObjectStorage['createSignedUrl']>> | null> {
  try {
    return await storage.createSignedUrl(storageKey, 300);
  } catch {
    // 部署诊断由平台错误监控门禁补齐，此处不输出私有路径或签名错误。
    return null;
  }
}

function nextStatusFor(
  submission: AdminSubmissionDetail,
  action: AdminAction['action'],
  requestedVersion: number,
  now: Date
): SubmissionStatus {
  const status = submission.status;
  if (action === 'approve') {
    if (
      submission.kind === 'shared_package'
      && status !== 'published'
      && !hasCurrentTechnicalPass(submission, now)
    ) {
      throw new ApiError('TECHNICAL_SCAN_REQUIRED', 409);
    }
    if (status === 'manual_review_pending') return 'published';
    if (status === 'published') return 'published';
  }
  if (action === 'force_publish') {
    if (
      submission.kind === 'shared_package'
      && submission.statusVersion !== requestedVersion
    ) {
      // 版本已变化时只重建首次请求目标，由数据库在生命周期变化前裁定幂等回放。
      return 'published';
    }
    if (
      submission.kind === 'shared_package'
      && status === 'manual_review_pending'
    ) {
      return 'published';
    }
    throw new ApiError('INVALID_ADMIN_ACTION', 409);
  }
  if (
    action === 'reject'
    && (status === 'manual_review_pending' || status === 'admin_rejected')
  ) {
    return 'admin_rejected';
  }
  if (
    action === 'move_to_manual'
    && (
      status === 'system_reviewing'
      || status === 'auto_rejected'
      || status === 'manual_review_pending'
    )
  ) {
    return 'manual_review_pending';
  }
  if (action === 'delete' && status !== 'purged') {
    return 'deleted_quarantined';
  }
  if (action === 'restore') {
    if (submission.statusVersion !== requestedVersion) {
      // 版本已变化时只派生稳定合法目标，数据库用管理员原始输入裁定旧 key 或新请求。
      return submission.kind === 'shared_package'
        ? 'manual_review_pending'
        : status;
    }
    if (submission.preQuarantineStatus) {
      return submission.kind === 'shared_package'
        ? 'manual_review_pending'
        : submission.preQuarantineStatus;
    }
    throw new ApiError('INVALID_ADMIN_ACTION', 409);
  }
  throw new ApiError('INVALID_ADMIN_ACTION', 409);
}

function hasCurrentTechnicalPass(
  submission: AdminSubmissionDetail,
  now: Date
): boolean {
  const packageAsset = submission.assets.find(asset => asset.role === 'package');
  if (!packageAsset || packageAsset.actualBytes === null) return false;
  return submission.moderationResults.some(result => {
    if (
      result.kind !== 'package_scan'
      || result.provider !== 'isolated-scanner'
      || result.suggestion !== 'Pass'
    ) {
      return false;
    }
    const parsed = technicalScanEvidenceSchema.safeParse(result.evidence);
    if (!parsed.success) return false;
    const evidence = parsed.data;
    const completedAt = new Date(evidence.completedAt).getTime();
    const expiresAt = new Date(evidence.expiresAt).getTime();
    return evidence.submissionId === submission.id
      && evidence.packageStorageKey === packageAsset.storageKey
      && evidence.packageSizeBytes === packageAsset.actualBytes
      && evidence.archiveSizeBytes === packageAsset.actualBytes
      && evidence.protocolVersion === TECHNICAL_SCAN_PROTOCOL_VERSION
      && evidence.ruleVersion === TECHNICAL_SCAN_RULE_VERSION
      && evidence.submissionStatusVersion === submission.statusVersion
      && expiresAt - completedAt === technicalEvidenceTtlMilliseconds
      && expiresAt > now.getTime();
  });
}
