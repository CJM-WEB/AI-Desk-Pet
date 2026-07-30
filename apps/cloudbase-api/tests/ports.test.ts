import { describe, expectTypeOf, it } from 'vitest';

import type {
  AdminIdentityProvider,
  AdminIdentity,
  CaptchaVerifier,
  Clock,
  ContentModerator,
  CaptchaProof,
  ModerationImageInput,
  ModerationSignal,
  ModerationTextInput,
  ObjectStorage,
  NewSubmission,
  PackageScanResult,
  ScanPackageInput,
  PackageScanner,
  RelevanceInput,
  RelevanceClassifier,
  RelevanceSuggestion,
  SignedDownload,
  SignedUpload,
  SignedUploadOptions,
  StoredObjectInfo,
  SubmissionRow,
  SubmissionStatusView,
  SubmissionStore
} from '../src/ports.js';

describe('审核 API 端口', () => {
  it('声明各基础设施边界的最小操作', () => {
    expectTypeOf<SubmissionStore['createSubmission']>()
      .toEqualTypeOf<(input: NewSubmission) => Promise<SubmissionRow>>();
    expectTypeOf<SubmissionStore['findByStatusTokenHash']>()
      .toEqualTypeOf<(hash: string) => Promise<SubmissionStatusView | null>>();
    expectTypeOf<ObjectStorage['createSignedUploadUrl']>()
      .toEqualTypeOf<(path: string, options: SignedUploadOptions) => Promise<SignedUpload>>();
    expectTypeOf<ObjectStorage['info']>()
      .toEqualTypeOf<(path: string) => Promise<StoredObjectInfo | null>>();
    expectTypeOf<ObjectStorage['createSignedUrl']>()
      .toEqualTypeOf<(path: string, expiresInSeconds: number) => Promise<SignedDownload>>();
    expectTypeOf<ObjectStorage['delete']>()
      .toEqualTypeOf<(path: string) => Promise<void>>();
    expectTypeOf<CaptchaVerifier['verify']>()
      .toEqualTypeOf<(proof: CaptchaProof, ip: string) => Promise<void>>();
    expectTypeOf<ContentModerator['reviewText']>()
      .toEqualTypeOf<(input: ModerationTextInput) => Promise<ModerationSignal>>();
    expectTypeOf<ContentModerator['reviewImage']>()
      .toEqualTypeOf<(input: ModerationImageInput) => Promise<ModerationSignal>>();
    expectTypeOf<RelevanceClassifier['classify']>()
      .toEqualTypeOf<(input: RelevanceInput) => Promise<RelevanceSuggestion>>();
    expectTypeOf<PackageScanner['scan']>()
      .toEqualTypeOf<(input: ScanPackageInput) => Promise<PackageScanResult>>();
    expectTypeOf<AdminIdentityProvider['requireAdmin']>()
      .toEqualTypeOf<() => Promise<AdminIdentity>>();
    expectTypeOf<Clock['now']>().toEqualTypeOf<() => Date>();
  });
});
