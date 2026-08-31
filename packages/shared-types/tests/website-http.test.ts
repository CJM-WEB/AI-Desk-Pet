import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  adminActionRequestSchema,
  adminActionResponseSchema,
  adminDetailRequestSchema,
  adminDetailResponseSchema,
  adminQueueRequestSchema,
  adminQueueResponseSchema,
  errorEnvelopeSchema,
  feedbackSubmissionRequestSchema,
  feedbackSubmissionResponseSchema,
  finalizeSubmissionRequestSchema,
  finalizeSubmissionResponseSchema,
  prepareSubmissionRequestSchema,
  prepareSubmissionResponseSchema,
  publicCommunityItemSchema,
  publicCommunityPageSchema,
  publicDetailRequestSchema,
  publicDownloadResponseSchema,
  publicDownloadRequestSchema,
  publicFeedbackListRequestSchema,
  publicFeedbackPageSchema,
  publicLikeRequestSchema,
  publicLikeResponseSchema,
  publicListRequestSchema,
  submissionStatusRequestSchema,
  submissionStatusResponseSchema,
  successEnvelopeSchema,
  websiteHttpEnvelopeSchema
} from '../src/website-http';

const requestId = 'request-1';
const statusToken = 'a'.repeat(43);
const dateTime = '2026-08-31T00:00:00.000Z';

describe('网站 HTTP 信封', () => {
  const dataSchema = publicLikeResponseSchema;

  it('成功与错误信封要求 requestId 且 data/error 互斥', () => {
    const success = successEnvelopeSchema(dataSchema);
    expect(success.parse({ requestId, data: { liked: true, likeCount: 1 } }))
      .toEqual({ requestId, data: { liked: true, likeCount: 1 } });
    expect(success.safeParse({ data: { liked: true, likeCount: 1 } }).success).toBe(false);
    expect(successEnvelopeSchema(z.unknown()).safeParse({ requestId }).success).toBe(false);
    expect(successEnvelopeSchema(z.unknown()).safeParse({ requestId, data: undefined }).success)
      .toBe(false);
    expect(success.safeParse({ requestId, data: { liked: true, likeCount: 1 }, error: null }).success)
      .toBe(false);
    expect(success.safeParse({ requestId, data: { liked: true, likeCount: 1 }, privateKey: 'x' }).success)
      .toBe(false);

    expect(errorEnvelopeSchema.parse({
      requestId,
      error: { code: 'RATE_LIMITED', retryAfterSeconds: 30 }
    })).toEqual({ requestId, error: { code: 'RATE_LIMITED', retryAfterSeconds: 30 } });
    expect(errorEnvelopeSchema.safeParse({ error: { code: 'FAILED' } }).success).toBe(false);
    expect(errorEnvelopeSchema.safeParse({ requestId, error: { code: 'FAILED' }, data: null }).success)
      .toBe(false);
    expect(errorEnvelopeSchema.safeParse({ requestId, error: { code: 'FAILED', message: '内部信息' } }).success)
      .toBe(false);
  });

  it('unknown data 联合信封仍复用唯一 requestId 与互斥规则', () => {
    expect(websiteHttpEnvelopeSchema.parse({
      requestId,
      data: { nested: ['任意 endpoint 数据'] }
    })).toEqual({ requestId, data: { nested: ['任意 endpoint 数据'] } });
    expect(websiteHttpEnvelopeSchema.safeParse({
      requestId,
      data: {},
      error: { code: 'FAILED' }
    }).success).toBe(false);
    expect(websiteHttpEnvelopeSchema.safeParse({
      requestId: '含 空格',
      data: {}
    }).success).toBe(false);
  });
});

describe('投稿 endpoint 契约', () => {
  const prepareRequest = {
    kind: 'shared_package',
    title: '桌宠',
    body: '说明',
    coverFile: { fileName: 'cover.webp', sizeBytes: 10, contentType: 'image/webp' },
    packageFile: { fileName: 'pet.zip', sizeBytes: 20, contentType: 'application/zip' }
  };

  it('prepare 请求与 uploading+双上传目标响应均严格', () => {
    expect(prepareSubmissionRequestSchema.parse(prepareRequest)).toEqual(prepareRequest);
    expect(prepareSubmissionRequestSchema.safeParse({ ...prepareRequest, extra: true }).success).toBe(false);
    const response = {
      submissionId: 'submission-1', statusToken, statusPath: '/submission-status/', status: 'uploading',
      coverUpload: { path: 'submissions/submission-1/cover.webp', url: 'https://example.test/cover', expiresAt: dateTime },
      packageUpload: { path: 'submissions/submission-1/package.zip', url: 'https://example.test/package', expiresAt: dateTime }
    };
    expect(prepareSubmissionResponseSchema.parse(response)).toEqual(response);
    expect(prepareSubmissionResponseSchema.safeParse({ ...response, status: 'system_reviewing' }).success).toBe(false);
  });

  it('finalize、feedback 与 submission-status 使用精确状态和 strict 请求', () => {
    expect(finalizeSubmissionRequestSchema.parse({})).toEqual({});
    expect(finalizeSubmissionRequestSchema.safeParse({ force: true }).success).toBe(false);
    expect(finalizeSubmissionResponseSchema.parse({ status: 'system_reviewing' }))
      .toEqual({ status: 'system_reviewing' });

    const feedback = { kind: 'feedback', authorName: '匿名用户', content: '建议' };
    expect(feedbackSubmissionRequestSchema.parse(feedback)).toEqual(feedback);
    expect(feedbackSubmissionResponseSchema.parse({
      submissionId: 'feedback-1', statusToken, statusPath: '/submission-status/', status: 'system_reviewing'
    }).status).toBe('system_reviewing');
    expect(feedbackSubmissionResponseSchema.safeParse({
      submissionId: 'feedback-1', statusToken, statusPath: '/submission-status/', status: 'manual_review_pending'
    }).success).toBe(false);

    expect(submissionStatusRequestSchema.parse({ statusToken })).toEqual({ statusToken });
    const publicStatus = {
      submissionId: 'submission-1', status: 'system_reviewing', publicReason: null,
      createdAt: dateTime, updatedAt: dateTime
    };
    expect(submissionStatusResponseSchema.parse(publicStatus)).toEqual(publicStatus);
    expect(submissionStatusResponseSchema.safeParse({ ...publicStatus, moderationEvidence: {} }).success)
      .toBe(false);
  });
});

describe('公开 endpoint 契约', () => {
  const community = {
    id: 'pet-1', name: '桌宠', description: '说明',
    cover: { url: 'https://example.test/cover', expiresAt: dateTime },
    packageFileName: 'pet.zip', packageSizeBytes: 1024, likeCount: 1,
    downloadCount: 2, publishedAt: dateTime, publicationBasis: 'admin_override'
  };

  it('社区列表、详情与下载严格保留 publicationBasis', () => {
    expect(publicCommunityItemSchema.parse(community)).toEqual(community);
    expect(publicCommunityPageSchema.parse({ items: [community], nextCursor: null }).items).toHaveLength(1);
    for (const invalid of [
      { ...community, publicationBasis: undefined },
      { ...community, publicationBasis: 'scanner_pass' },
      { ...community, privateStorageKey: 'private/key' }
    ]) expect(publicCommunityItemSchema.safeParse(invalid).success).toBe(false);

    const download = { url: 'https://example.test/download', expiresAt: dateTime, publicationBasis: 'standard' };
    expect(publicDownloadResponseSchema.parse(download)).toEqual(download);
    expect(publicDownloadResponseSchema.safeParse({ ...download, storageKey: 'private/key' }).success)
      .toBe(false);
  });

  it('反馈列表与点赞响应拒绝多余字段', () => {
    const page = {
      items: [{ id: 'feedback-1', kind: 'feedback', authorName: '匿名用户', content: '建议', likeCount: 1, createdAt: dateTime }],
      nextCursor: null
    };
    expect(publicFeedbackPageSchema.parse(page)).toEqual(page);
    expect(publicFeedbackPageSchema.safeParse({ ...page, internalCursor: 'x' }).success).toBe(false);
    expect(publicLikeResponseSchema.safeParse({ liked: true, likeCount: 1, fingerprint: 'x' }).success)
      .toBe(false);
  });

  it('公开与管理员路径、query 和空 body 请求拒绝额外字段', () => {
    expect(publicListRequestSchema.parse({ limit: 8, cursor: 'v1.abc' }).cursor)
      .toBe('v1.abc');
    expect(publicListRequestSchema.safeParse({ limit: 8, cursor: 8 }).success)
      .toBe(false);
    expect(publicListRequestSchema.parse({ limit: 8, cursor: '' }).cursor).toBe('');
    expect(publicListRequestSchema.parse({ limit: 8, cursor: 'x'.repeat(513) }).cursor)
      .toHaveLength(513);
    expect(publicListRequestSchema.safeParse({ limit: 20, private: true }).success).toBe(false);
    expect(publicFeedbackListRequestSchema.parse({ kind: 'feedback', limit: 20 })).toEqual({ kind: 'feedback', limit: 20 });
    expect(publicDetailRequestSchema.parse({
      path: { id: 'pet-1' },
      query: {},
      body: {}
    })).toEqual({ path: { id: 'pet-1' }, query: {}, body: {} });
    expect(publicDetailRequestSchema.safeParse({
      path: { id: 'pet-1' },
      query: { extra: true },
      body: {}
    }).success).toBe(false);
    expect(publicLikeRequestSchema.safeParse({ force: true }).success).toBe(false);
    expect(publicDownloadRequestSchema.safeParse({ token: 'private' }).success).toBe(false);
    expect(adminQueueRequestSchema.safeParse({ limit: 20, status: 'system_reviewing', extra: true }).success).toBe(false);
    expect(adminQueueRequestSchema.parse({
      limit: 20,
      cursor: 'v1.admin',
      status: 'system_reviewing'
    }).cursor).toBe('v1.admin');
    expect(adminDetailRequestSchema.safeParse({
      path: { id: 'submission-1' },
      query: {},
      body: { extra: true }
    }).success).toBe(false);
  });
});

describe('管理员 endpoint 契约', () => {
  it('动作请求直接复用共享严格联合', () => {
    const normal = { action: 'approve', version: 1, idempotencyKey: 'action-key', reason: '通过' };
    expect(adminActionRequestSchema.parse(normal)).toEqual(normal);
    expect(adminActionRequestSchema.safeParse({ ...normal, riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED' }).success)
      .toBe(false);
    expect(adminActionRequestSchema.safeParse({
      action: 'force_publish', version: 1, idempotencyKey: 'action-key', reason: '接受风险'
    }).success).toBe(false);
    expect(adminActionRequestSchema.parse({
      action: 'force_publish', version: 1, idempotencyKey: 'action-key', reason: '接受风险',
      riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED'
    }).action).toBe('force_publish');
  });

  it('队列、详情与动作响应都是 strict', () => {
    expect(adminQueueResponseSchema.parse({ items: [], nextCursor: 'v1.next' }))
      .toEqual({ items: [], nextCursor: 'v1.next' });
    expect(adminQueueResponseSchema.safeParse({ items: [], nextCursor: 20 }).success)
      .toBe(false);
    expect(adminQueueResponseSchema.safeParse({ items: [], nextCursor: null, adminEmail: 'secret' }).success)
      .toBe(false);
    expect(adminDetailResponseSchema.safeParse({ id: 'submission-1', adminEmail: 'secret' }).success)
      .toBe(false);
    expect(adminActionResponseSchema.safeParse({
      submission: { id: 'submission-1', status: 'published', statusVersion: 2, publicationBasis: 'standard' },
      replayed: true,
      adminEmail: 'secret'
    }).success).toBe(false);
  });
});
