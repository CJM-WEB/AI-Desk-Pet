import type {
  AdminAction,
  CaptchaProof,
  SubmissionStatus,
  SubmissionStatusView
} from '@myself/shared-types';

export type { CaptchaProof, SubmissionStatusView } from '@myself/shared-types';

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
  moderationLeaseUntil?: string | null;
  purgeAfter?: string | null;
  publishedAt?: string | null;
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
}

/** 单次系统审核结果的持久化记录。 */
export interface ModerationRecord {
  submissionId: string;
  kind: string;
  provider: string;
  ruleVersion: string;
  suggestion: ModerationSignal['suggestion'];
  label: string;
  score: number | null;
  evidence: Record<string, unknown>;
  requestedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
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
}

/** 管理员动作结果会标识是否为幂等重放。 */
export interface AdminActionResult {
  submission: SubmissionRow;
  replayed: boolean;
}

/** 公开列表允许返回的裁剪字段。 */
export interface PublicSubmission {
  id: string;
  title: string | null;
  body: string | null;
  publishedAt: string;
}

/** 公开列表使用零基偏移游标，限制由仓储统一执行。 */
export interface PublicListQuery {
  limit: number;
  cursor?: number | null;
}

/** 公开投稿分页结果。 */
export interface PublicSubmissionPage {
  items: PublicSubmission[];
  nextCursor: number | null;
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

/** CAPTCHA 票据哈希的原子消费输入。 */
export interface CaptchaTicketInput {
  ticketHash: string;
  expiresAt: string;
}

/** 公开互动写入的设备哈希输入。 */
export interface PublicLikeInput {
  submissionId: string;
  fingerprintHash: string;
}

export interface PublicLikeResult {
  liked: boolean;
  likeCount: number;
}

export interface PublicDownloadResult {
  downloadCount: number;
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
  nextCursor: number | null;
}

export interface PublishedFeedbackPage {
  items: PublishedFeedbackRecord[];
  nextCursor: number | null;
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

/** 文本审核输入。 */
export interface ModerationTextInput {
  text: string;
}

/** 图片审核输入。 */
export interface ModerationImageInput {
  imageUrl: string;
}

/** 内容审核服务归一化后的建议。 */
export interface ModerationSignal {
  suggestion: 'Pass' | 'Review' | 'Block';
  label: string;
}

/** AI Pet 相关性判定输入。 */
export interface RelevanceInput {
  title: string;
  body: string;
}

/** AI Pet 相关性判定结果。 */
export type RelevanceSuggestion = 'pass' | 'review' | 'reject';

/** 隔离扫描服务输入。 */
export interface ScanPackageInput {
  submissionId: string;
  archivePath: string;
}

/** 隔离扫描服务的最小安全结论。 */
export interface PackageScanResult {
  complete: boolean;
  safe: boolean;
  signals: readonly ModerationSignal[];
}

/** 管理员身份的最小声明。 */
export interface AdminIdentity {
  uid: string;
  email: string;
}

/** 投稿存储边界。 */
export interface SubmissionStore {
  createSubmission(input: NewSubmission): Promise<SubmissionRow>;
  findById(id: string): Promise<SubmissionWithAssets | null>;
  completeUpload(input: CompleteUploadInput): Promise<SubmissionRow>;
  findByStatusTokenHash(hash: string): Promise<SubmissionStatusView | null>;
  claimModerationJobs(limit: number, leaseUntil: string): Promise<SubmissionRow[]>;
  recordModerationResult(result: ModerationRecord): Promise<void>;
  applyAdminAction(input: AdminActionInput): Promise<AdminActionResult>;
  listPublished(input: PublicListQuery): Promise<PublicSubmissionPage>;
  listPurgeCandidates(now: string, limit: number): Promise<SubmissionRow[]>;
}

/** 多实例共享的 CAPTCHA 防重放与限流存储。 */
export interface SecurityStore {
  consumeCaptchaTicket(input: CaptchaTicketInput): Promise<boolean>;
  consumeAbuseLimit(input: AbuseLimitInput): Promise<AbuseLimitResult>;
}

/** 文本投稿和公开互动的持久化边界。 */
export interface PublicInteractionStore {
  createTextSubmission(input: NewTextSubmission): Promise<SubmissionRow>;
  listPublicCommunity(input: PublicListQuery): Promise<PublishedCommunityPage>;
  findPublicCommunity(id: string): Promise<PublishedCommunityRecord | null>;
  listPublicFeedback(
    kind: TextSubmissionKind,
    input: PublicListQuery
  ): Promise<PublishedFeedbackPage>;
  togglePublicLike(input: PublicLikeInput): Promise<PublicLikeResult>;
  recordPublicDownload(submissionId: string): Promise<PublicDownloadResult>;
}

/** 私有对象存储边界。 */
export interface ObjectStorage {
  createSignedUploadUrl(path: string, options: SignedUploadOptions): Promise<SignedUpload>;
  info(path: string): Promise<StoredObjectInfo | null>;
  createSignedUrl(path: string, expiresInSeconds: number): Promise<SignedDownload>;
  delete(path: string): Promise<void>;
}

/** 服务端 CAPTCHA 验票边界。 */
export interface CaptchaVerifier {
  verify(proof: CaptchaProof, ip: string): Promise<void>;
}

/** 文本与图片审核边界。 */
export interface ContentModerator {
  reviewText(input: ModerationTextInput): Promise<ModerationSignal>;
  reviewImage(input: ModerationImageInput): Promise<ModerationSignal>;
}

/** AI Pet 相关性判定边界。 */
export interface RelevanceClassifier {
  classify(input: RelevanceInput): Promise<RelevanceSuggestion>;
}

/** 隔离扫描服务客户端边界。 */
export interface PackageScanner {
  scan(input: ScanPackageInput): Promise<PackageScanResult>;
}

/** 管理员身份提供者边界。 */
export interface AdminIdentityProvider {
  requireAdmin(): Promise<AdminIdentity>;
}

/** 业务时间来源边界。 */
export interface Clock {
  now(): Date;
}
