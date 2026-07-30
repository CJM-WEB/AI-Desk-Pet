import type {
  CaptchaProof,
  SubmissionStatus,
  SubmissionStatusView
} from '@myself/shared-types';

export type { CaptchaProof, SubmissionStatusView } from '@myself/shared-types';

/** 创建投稿记录所需的最小字段。 */
export interface NewSubmission {
  id: string;
  statusTokenHash: string;
}

/** 数据库存储的投稿基础视图。 */
export interface SubmissionRow {
  id: string;
  status: SubmissionStatus;
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
  findByStatusTokenHash(hash: string): Promise<SubmissionStatusView | null>;
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
