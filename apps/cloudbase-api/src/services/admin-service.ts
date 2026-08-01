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
  ObjectStorage
} from '../ports.js';

/** 管理员审核服务统一执行状态转换和技术扫描门禁。 */
export class AdminService {
  constructor(
    private readonly store: AdminStore,
    private readonly storage: ObjectStorage
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
    return {
      ...detail,
      coverPreview: cover ? await safeCoverPreview(this.storage, cover.storageKey) : null
    };
  }

  async applyAction(
    identity: AdminIdentity,
    id: string,
    action: AdminAction
  ): Promise<AdminActionResult> {
    const submission = await this.store.findAdminSubmission(id);
    if (!submission) throw new ApiError('SUBMISSION_NOT_FOUND', 404);
    const nextStatus = nextStatusFor(submission, action.action);
    return this.store.applyAdminAction({
      submissionId: id,
      adminId: identity.uid,
      action: action.action,
      nextStatus,
      expectedVersion: action.version,
      idempotencyKey: action.idempotencyKey,
      reason: action.reason
    });
  }
}

/** 预览属于辅助信息；签名失败不得阻断审核正文、证据和动作。 */
async function safeCoverPreview(
  storage: ObjectStorage,
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
  action: AdminAction['action']
): SubmissionStatus {
  const status = submission.status;
  if (action === 'approve') {
    if (
      submission.kind === 'shared_package'
      && !hasCurrentTechnicalPass(submission)
    ) {
      throw new ApiError('TECHNICAL_SCAN_REQUIRED', 409);
    }
    if (status === 'manual_review_pending') return 'published';
    if (status === 'auto_rejected') {
      return 'published';
    }
    if (status === 'published') return 'published';
  }
  if (
    action === 'reject'
    && (status === 'manual_review_pending' || status === 'admin_rejected')
  ) {
    return 'admin_rejected';
  }
  if (
    action === 'move_to_manual'
    && (status === 'auto_rejected' || status === 'manual_review_pending')
  ) {
    return 'manual_review_pending';
  }
  if (action === 'delete' && status !== 'purged') {
    return 'deleted_quarantined';
  }
  if (action === 'restore') {
    if (submission.preQuarantineStatus) return submission.preQuarantineStatus;
    throw new ApiError('INVALID_ADMIN_ACTION', 409);
  }
  throw new ApiError('INVALID_ADMIN_ACTION', 409);
}

function hasCurrentTechnicalPass(
  submission: AdminSubmissionDetail
): boolean {
  const packageAsset = submission.assets.find(asset => asset.role === 'package');
  if (!packageAsset || packageAsset.actualBytes === null) return false;
  return submission.moderationResults.some(result => (
    result.kind === 'package_scan'
    && result.provider === 'isolated-scanner'
    && result.suggestion === 'Pass'
    && result.evidence.packageStorageKey === packageAsset.storageKey
    && result.evidence.packageSizeBytes === packageAsset.actualBytes
    && result.evidence.scanCode === 'CHARACTER_PACKAGE_SCAN_PASSED'
  ));
}
