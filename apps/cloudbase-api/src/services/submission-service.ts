import { randomUUID } from 'node:crypto';

import type {
  CaptchaProof,
  SubmissionReceipt,
  SubmissionStatusView
} from '@myself/shared-types';

import { ApiError } from '../errors.js';
import { createStatusToken, hashStatusToken } from '../crypto/status-token.js';
import type {
  CaptchaVerifier,
  ObjectStorage,
  SubmissionAsset,
  SubmissionStore
} from '../ports.js';

const MiB = 1024 * 1024;
const maximumPackageBytes = 100 * MiB;
const maximumCoverBytes = 5 * MiB;

type CoverContentType = 'image/png' | 'image/webp' | 'image/jpeg';

export interface PrepareSharedPackageInput {
  kind: 'shared_package';
  title: string;
  body: string;
  captcha: CaptchaProof;
  packageFile: {
    fileName: string;
    sizeBytes: number;
    contentType: 'application/zip';
  };
  coverFile: {
    fileName: string;
    sizeBytes: number;
    contentType: CoverContentType;
  };
}

export type PrepareSubmissionInput = PrepareSharedPackageInput;

export interface RequestContext {
  ip: string;
}

export interface FinalizeSubmissionInput {
  submissionId: string;
}

export interface UploadTarget {
  path: string;
  url: string;
  expiresAt: string;
}

export interface UploadTargets {
  packageUpload: UploadTarget;
  coverUpload: UploadTarget;
}

type CreateId = () => string;

/** 编排匿名投稿准备、上传核对和状态令牌查询。 */
export class SubmissionService {
  constructor(
    private readonly store: SubmissionStore,
    private readonly storage: ObjectStorage,
    private readonly captcha: CaptchaVerifier,
    private readonly createId: CreateId = randomUUID
  ) {}

  async prepare(
    input: PrepareSharedPackageInput,
    context: RequestContext
  ): Promise<SubmissionReceipt & UploadTargets> {
    const normalized = validatePrepareInput(input, context);
    await this.captcha.verify(input.captcha, context.ip);

    const submissionId = this.createId();
    const statusToken = createStatusToken();
    const coverExtension = extensionOf(normalized.coverFile.fileName);
    const coverPath = `submissions/${submissionId}/cover.${coverExtension}`;
    const packagePath = `submissions/${submissionId}/package.zip`;

    await this.store.createSubmission({
      id: submissionId,
      kind: 'shared_package',
      title: normalized.title,
      body: normalized.body,
      statusTokenHash: hashStatusToken(statusToken),
      assets: [
        {
          role: 'cover',
          storageKey: coverPath,
          fileName: normalized.coverFile.fileName,
          declaredBytes: normalized.coverFile.sizeBytes,
          contentType: normalized.coverFile.contentType
        },
        {
          role: 'package',
          storageKey: packagePath,
          fileName: normalized.packageFile.fileName,
          declaredBytes: normalized.packageFile.sizeBytes,
          contentType: normalized.packageFile.contentType
        }
      ]
    });

    const coverUpload = await this.storage.createSignedUploadUrl(
      coverPath,
      { upsert: false }
    );
    const packageUpload = await this.storage.createSignedUploadUrl(
      packagePath,
      { upsert: false }
    );
    return {
      submissionId,
      statusToken,
      statusPath: '/submission-status/',
      status: 'system_reviewing',
      coverUpload: { path: coverPath, ...coverUpload },
      packageUpload: { path: packagePath, ...packageUpload }
    };
  }

  async finalize(
    input: FinalizeSubmissionInput
  ): Promise<{ status: 'system_reviewing' }> {
    const submission = await this.store.findById(input.submissionId);
    if (!submission) throw notFound();
    if (submission.status === 'system_reviewing') {
      return { status: 'system_reviewing' };
    }
    if (submission.status !== 'uploading') throw notFound();

    const cover = requireAsset(submission.assets, 'cover');
    const packageAsset = requireAsset(submission.assets, 'package');
    await this.verifyObject(cover, maximumCoverBytes);
    await this.verifyObject(packageAsset, maximumPackageBytes);

    const completed = await this.store.completeUpload({
      submissionId: submission.id
    });
    if (completed.status !== 'system_reviewing') {
      throw new ApiError('UPLOAD_STATE_CONFLICT', 409);
    }
    return { status: 'system_reviewing' };
  }

  async getStatus(token: string): Promise<SubmissionStatusView> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw notFound();
    const status = await this.store.findByStatusTokenHash(hashStatusToken(token));
    if (!status) throw notFound();
    return status;
  }

  private async verifyObject(
    asset: SubmissionAsset,
    absoluteMaximum: number
  ): Promise<void> {
    const object = await this.storage.info(asset.storageKey);
    if (
      !object
      || object.size > asset.declaredBytes
      || object.size > absoluteMaximum
      || normalizeContentType(object.contentType)
        !== normalizeContentType(asset.contentType)
    ) {
      throw new ApiError('UPLOAD_INCOMPLETE', 400);
    }
  }
}

function validatePrepareInput(
  input: PrepareSharedPackageInput,
  context: RequestContext
): PrepareSharedPackageInput {
  if (
    typeof input !== 'object'
    || input === null
    || typeof context !== 'object'
    || context === null
    || input.kind !== 'shared_package'
    || typeof context.ip !== 'string'
    || context.ip.trim().length === 0
    || typeof input.title !== 'string'
    || typeof input.body !== 'string'
  ) {
    throw new ApiError('INVALID_REQUEST', 400);
  }

  const title = input.title.trim();
  const body = input.body.trim();
  if (title.length === 0 || title.length > 30 || body.length === 0 || body.length > 500) {
    throw new ApiError('INVALID_REQUEST', 400);
  }
  if (
    typeof input.packageFile !== 'object'
    || input.packageFile === null
    || typeof input.coverFile !== 'object'
    || input.coverFile === null
    || !validFileSize(input.packageFile.sizeBytes, maximumPackageBytes)
    || input.packageFile.contentType !== 'application/zip'
    || extensionOf(input.packageFile.fileName) !== 'zip'
    || !validFileSize(input.coverFile.sizeBytes, maximumCoverBytes)
    || !validCover(input.coverFile.fileName, input.coverFile.contentType)
  ) {
    throw new ApiError('INVALID_UPLOAD', 400);
  }

  return { ...input, title, body };
}

function validFileSize(value: unknown, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= maximum;
}

function validCover(fileName: string, contentType: CoverContentType): boolean {
  const expected: Record<string, CoverContentType | undefined> = {
    png: 'image/png',
    webp: 'image/webp',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg'
  };
  return expected[extensionOf(fileName)] === contentType;
}

function extensionOf(fileName: string): string {
  if (typeof fileName !== 'string') return '';
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

function normalizeContentType(value: string): string {
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

function requireAsset(
  assets: readonly SubmissionAsset[],
  role: SubmissionAsset['role']
): SubmissionAsset {
  const matching = assets.filter((asset) => asset.role === role);
  if (matching.length !== 1) throw new ApiError('UPLOAD_INCOMPLETE', 400);
  return matching[0]!;
}

function notFound(): ApiError {
  return new ApiError('NOT_FOUND', 404);
}
