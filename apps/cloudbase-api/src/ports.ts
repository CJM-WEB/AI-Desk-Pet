import type {
  AdminAction,
  AdminActionResult,
  PublicationBasis,
  SubmissionStatus,
  SubmissionStatusView
} from '@myself/shared-types';

export type {
  AdminActionResult,
  SubmissionStatusView
} from '@myself/shared-types';

/** 创建投稿记录所需的最小字段。 */
export interface NewSubmission {
  id: string;
  kind: 'shared_package';
  title: string;
  body: string;
  statusTokenHash: string;
  assets: readonly NewSubmissionAsset[];
}

/** 创建投稿时一并持久化的私有资产声明。 */
export interface NewSubmissionAsset {
  role: 'cover' | 'package';
  storageKey: string;
  fileName: string;
  declaredBytes: number;
  contentType: string;
}

/** 数据库回读同时兼容后续扫描流程产生的派生资产。 */
export interface SubmissionAsset {
  role: 'cover' | 'package' | 'derived';
  storageKey: string;
  fileName: string;
  declaredBytes: number;
  contentType: string;
  actualBytes: number | null;
}

/** 数据库存储的投稿基础视图。 */
export interface SubmissionRow {
  id: string;
  status: SubmissionStatus;
  statusVersion?: number;
  kind?: string;
  title?: string | null;
  body?: string | null;
  purgeAfter?: string | null;
  preQuarantineStatus?: SubmissionStatus | null;
  cleanupStartedAt?: string | null;
  publishedAt?: string | null;
  publicationBasis?: PublicationBasis | null;
  createdAt?: string;
  updatedAt?: string;
}

/** 投稿生命周期读取必须同时返回数据库中的资产声明。 */
export interface SubmissionWithAssets extends SubmissionRow {
  assets: SubmissionAsset[];
}

/** 上传完成后推进审核状态所需字段。 */
export interface CompleteUploadInput {
  submissionId: string;
  assets: readonly {
    role: 'cover' | 'package';
    storageKey: string;
    actualBytes: number;
    contentType: string;
  }[];
}

/** 数据库原子管理员动作的完整输入。 */
export interface AdminActionInput {
  submissionId: string;
  adminId: string;
  action: AdminAction['action'];
  nextStatus: SubmissionStatus;
  expectedVersion: number;
  idempotencyKey: string;
  reason: string;
  riskAcknowledgement?: 'ADMIN_OVERRIDE_ACCEPTED';
}

/** 公开列表使用服务端 opaque 键集游标，限制由仓储统一执行。 */
export interface PublicListQuery {
  limit: number;
  cursor?: string | null;
}

export type TextSubmissionKind = 'feedback' | 'suggestion';

/** 创建纯文本投稿所需的最小持久化字段。 */
export interface NewTextSubmission {
  id: string;
  kind: TextSubmissionKind;
  title: string;
  body: string;
  statusTokenHash: string;
}

/** 数据库原子限流的输入。 */
export interface AbuseLimitInput {
  scope: string;
  fingerprintHash: string;
  maximum: number;
  windowSeconds: number;
}

/** 数据库原子限流的裁剪结果。 */
export interface AbuseLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** 公开互动写入的设备哈希输入。 */
export interface PublicLikeInput {
  submissionId: string;
  fingerprintHash: string;
  desiredLiked: boolean;
  operationId: string;
  endpointKind: 'community' | 'feedback';
}

export interface PublicLikeResult {
  liked: boolean;
  likeCount: number;
}

export interface PublicDownloadResult {
  downloadCount: number;
}

export interface PublicDownloadInput {
  submissionId: string;
  fingerprintHash: string;
  operationId: string;
}

/** 公开读取层使用的资产元数据，不包含审核或私有凭据。 */
export interface PublicAsset {
  role: 'cover' | 'package';
  storageKey: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
}

/** 数据库存储返回的已发布社区记录。 */
export interface PublishedCommunityRecord {
  id: string;
  title: string;
  body: string;
  assets: PublicAsset[];
  likeCount: number;
  downloadCount: number;
  publishedAt: string;
  publicationBasis: PublicationBasis;
}

export interface PublishedFeedbackRecord {
  id: string;
  kind: TextSubmissionKind;
  title: string;
  body: string;
  likeCount: number;
  createdAt: string;
}

export interface PublishedCommunityPage {
  items: PublishedCommunityRecord[];
  nextCursor: string | null;
}

export interface PublishedFeedbackPage {
  items: PublishedFeedbackRecord[];
  nextCursor: string | null;
}

/** 私有对象上传签名的写入策略。 */
export interface SignedUploadOptions {
  upsert: boolean;
}

/** 私有对象的限时上传地址。 */
export interface SignedUpload {
  url: string;
  expiresAt: string;
}

/** 私有对象元信息。 */
export interface StoredObjectInfo {
  path: string;
  size: number;
  contentType: string;
}

/** 私有对象的限时下载地址。 */
export interface SignedDownload {
  url: string;
  expiresAt: string;
}

/** 管理员身份的最小声明。 */
export interface AdminIdentity {
  uid: string;
  email: string;
}

/** 管理员队列的分页和状态筛选。 */
export interface AdminQueueQuery {
  limit: number;
  cursor?: string | null;
  status?: SubmissionStatus;
}

/** 管理员队列额外暴露已有的有限风险摘要，公开 DTO 不复用此类型。 */
export interface AdminSubmissionSummary extends SubmissionRow {
  riskSummary: Record<string, unknown>;
  autoRejectionReason: string | null;
}

export interface AdminQueuePage {
  items: AdminSubmissionSummary[];
  nextCursor: string | null;
}

/** 管理员详情只保留审核所需字段，不向公开接口复用。 */
export interface AdminModerationResult {
  kind: string;
  provider: string;
  suggestion: 'Pass' | 'Review' | 'Block';
  label: string;
  score: number | null;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface AdminAuditLog {
  action: AdminAction['action'];
  beforeStatus: SubmissionStatus;
  afterStatus: SubmissionStatus;
  reason: string;
  createdAt: string;
}

export interface AdminSubmissionDetail extends SubmissionWithAssets {
  riskSummary: Record<string, unknown>;
  autoRejectionReason: string | null;
  moderationResults: AdminModerationResult[];
  auditLogs: AdminAuditLog[];
}

/** 管理员详情视图只携带审核所需的短期签名地址，不把私有路径变为公开字段。 */
export interface AdminSubmissionDetailView extends AdminSubmissionDetail {
  coverPreview: SignedDownload | null;
  packageDownload: SignedDownload | null;
}

/** 管理员服务使用的原子读写边界。 */
export interface AdminStore {
  listAdminSubmissions(query: AdminQueueQuery): Promise<AdminQueuePage>;
  findAdminSubmission(id: string): Promise<AdminSubmissionDetail | null>;
  applyAdminAction(input: AdminActionInput): Promise<AdminActionResult>;
}

export interface MarkPurgedInput {
  submissionId: string;
  expectedVersion: number;
}

/** 清理任务使用租约领取，避免多实例重复删除同一对象。 */
export interface CleanupStore {
  purgeExpiredPublicInteractionOperations(limit: number): Promise<number>;
  claimCleanupJobs(
    limit: number,
    leaseUntil: string
  ): Promise<SubmissionWithAssets[]>;
  markPurged(input: MarkPurgedInput): Promise<boolean>;
}

/** 投稿存储边界。 */
export interface SubmissionStore {
  createSubmission(input: NewSubmission): Promise<SubmissionRow>;
  findById(id: string): Promise<SubmissionWithAssets | null>;
  completeUpload(input: CompleteUploadInput): Promise<SubmissionRow>;
  findByStatusTokenHash(hash: string): Promise<SubmissionStatusView | null>;
}

/** 多实例共享的请求限流存储。 */
export interface SecurityStore {
  consumeAbuseLimit(input: AbuseLimitInput): Promise<AbuseLimitResult>;
}

/** 纯文本投稿创建的最小持久化边界。 */
export interface TextSubmissionStore {
  createTextSubmission(input: NewTextSubmission): Promise<SubmissionRow>;
}

/** 公开读取与幂等互动的持久化边界。 */
export interface PublicContentStore {
  listPublicCommunity(input: PublicListQuery): Promise<PublishedCommunityPage>;
  findPublicCommunity(id: string): Promise<PublishedCommunityRecord | null>;
  listPublicFeedback(
    kind: TextSubmissionKind,
    input: PublicListQuery
  ): Promise<PublishedFeedbackPage>;
  setPublicLike(input: PublicLikeInput): Promise<PublicLikeResult>;
  recordPublicDownload(input: PublicDownloadInput): Promise<PublicDownloadResult>;
}

/** 私有对象存储边界。 */
export interface ObjectStorage {
  createSignedUploadUrl(path: string, options: SignedUploadOptions): Promise<SignedUpload>;
  info(path: string): Promise<StoredObjectInfo | null>;
  createSignedUrl(path: string, expiresInSeconds: number): Promise<SignedDownload>;
  delete(path: string): Promise<void>;
}

/** 管理员身份提供者边界。 */
export interface AdminIdentityProvider {
  requireAdmin(accessToken: string): Promise<AdminIdentity>;
}

/** 业务时间来源边界。 */
export interface Clock {
  now(): Date;
}
