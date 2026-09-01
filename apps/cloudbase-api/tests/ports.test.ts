import { describe, expectTypeOf, it } from 'vitest';

import {
  CloudBasePostgresStore,
  type CloudBaseRdbQuery
} from '../src/adapters/cloudbase-postgres.js';
import { PublicContentService } from '../src/services/public-content-service.js';
import { SubmissionService } from '../src/services/submission-service.js';
import { TextSubmissionService } from '../src/services/text-submission-service.js';
import type {
  AdminIdentityProvider,
  AdminIdentity,
  Clock,
  ObjectStorage,
  OfficialDownloadMetricStore,
  NewSubmission,
  SignedDownload,
  SignedUpload,
  SignedUploadOptions,
  StoredObjectInfo,
  PublicContentStore,
  SubmissionRow,
  SubmissionStatusView,
  SubmissionStore,
  SubmissionWithAssets,
  TextSubmissionStore
} from '../src/ports.js';

describe('CloudBase API 端口', () => {
  it('声明各基础设施边界的最小操作', () => {
    expectTypeOf<{ id: string; status: SubmissionRow['status'] }>()
      .toMatchTypeOf<SubmissionRow>();
    expectTypeOf<SubmissionStore['createSubmission']>()
      .toEqualTypeOf<(input: NewSubmission) => Promise<SubmissionRow>>();
    expectTypeOf<SubmissionStore['findByStatusTokenHash']>()
      .toEqualTypeOf<(hash: string) => Promise<SubmissionStatusView | null>>();
    expectTypeOf<SubmissionStore['findById']>()
      .toEqualTypeOf<(id: string) => Promise<SubmissionWithAssets | null>>();
    expectTypeOf<ObjectStorage['createSignedUploadUrl']>()
      .toEqualTypeOf<(path: string, options: SignedUploadOptions) => Promise<SignedUpload>>();
    expectTypeOf<ObjectStorage['info']>()
      .toEqualTypeOf<(path: string) => Promise<StoredObjectInfo | null>>();
    expectTypeOf<ObjectStorage['createSignedUrl']>()
      .toEqualTypeOf<(path: string, expiresInSeconds: number) => Promise<SignedDownload>>();
    expectTypeOf<ObjectStorage['delete']>()
      .toEqualTypeOf<(path: string) => Promise<void>>();
    expectTypeOf<AdminIdentityProvider['requireAdmin']>()
      .toEqualTypeOf<(accessToken: string) => Promise<AdminIdentity>>();
    expectTypeOf<Clock['now']>().toEqualTypeOf<() => Date>();
    expectTypeOf<OfficialDownloadMetricStore['recordOfficialWindowsDownloadClick']>()
      .toEqualTypeOf<(input: { fingerprintHash: string }) => Promise<void>>();
    expectTypeOf<OfficialDownloadMetricStore['getOfficialWindowsDownloadClickCount']>()
      .toEqualTypeOf<() => Promise<number>>();
  });

  it('业务服务只接收各自所需的最小能力端口', () => {
    expectTypeOf<keyof SubmissionStore>().toEqualTypeOf<
      | 'createSubmission'
      | 'findById'
      | 'completeUpload'
      | 'findByStatusTokenHash'
    >();
    expectTypeOf<keyof TextSubmissionStore>()
      .toEqualTypeOf<'createTextSubmission'>();
    expectTypeOf<keyof PublicContentStore>().toEqualTypeOf<
      | 'listPublicCommunity'
      | 'findPublicCommunity'
      | 'listPublicFeedback'
      | 'setPublicLike'
      | 'recordPublicDownload'
    >();
    expectTypeOf<keyof OfficialDownloadMetricStore>().toEqualTypeOf<
      | 'recordOfficialWindowsDownloadClick'
      | 'getOfficialWindowsDownloadClickCount'
    >();
    expectTypeOf<ConstructorParameters<typeof SubmissionService>[0]>()
      .toEqualTypeOf<SubmissionStore>();
    expectTypeOf<ConstructorParameters<typeof SubmissionService>[1]>()
      .toEqualTypeOf<Pick<ObjectStorage, 'createSignedUploadUrl' | 'info'>>();
    expectTypeOf<ConstructorParameters<typeof TextSubmissionService>[0]>()
      .toEqualTypeOf<TextSubmissionStore>();
    expectTypeOf<ConstructorParameters<typeof PublicContentService>[0]>()
      .toEqualTypeOf<PublicContentStore>();
    expectTypeOf<ConstructorParameters<typeof PublicContentService>[1]>()
      .toEqualTypeOf<Pick<ObjectStorage, 'createSignedUrl'>>();
  });

  it('生产 Store 同时满足最终业务端口且 RDB 查询不暴露死写能力', () => {
    expectTypeOf<CloudBasePostgresStore>().toMatchTypeOf<
      SubmissionStore & TextSubmissionStore & PublicContentStore & OfficialDownloadMetricStore
    >();
    expectTypeOf<Extract<
      keyof CloudBaseRdbQuery,
      | 'insert'
      | 'update'
      | 'upsert'
      | 'lte'
      | 'not'
      | 'limit'
      | 'single'
    >>().toEqualTypeOf<never>();
  });
});
