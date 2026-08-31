import {
  adminActionResponseSchema,
  adminQueueResponseSchema,
  errorEnvelopeSchema,
  feedbackSubmissionResponseSchema,
  finalizeSubmissionResponseSchema,
  prepareSubmissionResponseSchema,
  publicCommunityItemSchema,
  publicCommunityPageSchema,
  publicDownloadResponseSchema,
  publicFeedbackPageSchema,
  publicLikeResponseSchema,
  submissionStatusResponseSchema,
} from '@myself/shared-types/website-http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

export interface ContractRequest {
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export type ContractEnvelope =
  | { requestId: string; data: unknown }
  | { requestId: string; error: { code: string; retryAfterSeconds?: number } };

export interface ContractResponse {
  status: number;
  envelope: ContractEnvelope;
}

export interface ContractFixtureRefs {
  adminToken: string;
  uploadedSubmissionId: string;
  uploadedStatusToken: string;
  adminSubmissionId: string;
  adminSubmissionVersion: number;
  overrideSubmissionId: string;
  overrideSubmissionVersion: number;
  publicCommunityId: string;
  publicFeedbackId: string;
}

export interface WebsiteApiDriver {
  request(input: ContractRequest): Promise<ContractResponse>;
  reset(): Promise<ContractFixtureRefs>;
  close(): Promise<void>;
}

/** 两个 driver 共用同一个严格信封解码边界。 */
export function decodeContractResponse(status: number, body: unknown): ContractResponse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('合同响应不是 JSON 对象');
  }
  const record = body as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'error')) {
    return { status, envelope: errorEnvelopeSchema.parse(record) };
  }
  if (
    Object.keys(record).sort().join(',') !== 'data,requestId'
    || typeof record.requestId !== 'string'
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(record.requestId)
  ) {
    throw new Error('合同成功信封形状无效');
  }
  return {
    status,
    envelope: { requestId: record.requestId, data: record.data },
  };
}

function success<T>(
  response: ContractResponse,
  schema: { parse(value: unknown): T },
): T {
  expect(response.status).toBe(200);
  expect(response.envelope.requestId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/u);
  if (!('data' in response.envelope)) {
    throw new Error(`预期成功信封，实际为 ${response.envelope.error.code}`);
  }
  return schema.parse(response.envelope.data);
}

function failure(response: ContractResponse, status: number, code: string): void {
  expect(response.status).toBe(status);
  expect(response.envelope.requestId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/u);
  if (!('error' in response.envelope)) throw new Error('预期错误信封');
  expect(response.envelope.error).toEqual({ code });
}

/** 注册一次行为合同；生产与 Memory 只能提供 driver，不得复制断言。 */
export function runWebsiteApiContract(
  name: string,
  createDriver: () => Promise<WebsiteApiDriver>,
): void {
  describe(name, () => {
    let driver: WebsiteApiDriver;
    let refs: ContractFixtureRefs;

    beforeEach(async () => {
      driver = await createDriver();
      refs = await driver.reset();
    });

    afterEach(async () => {
      await driver.close();
    });

    it('reset 返回完整且稳定的同构 fixture 引用', async () => {
      expect(refs).toEqual({
        adminToken: 'contract-admin-token',
        uploadedSubmissionId: 'contract-uploaded',
        uploadedStatusToken: 'c'.repeat(43),
        adminSubmissionId: 'contract-uploaded',
        adminSubmissionVersion: 1,
        overrideSubmissionId: 'contract-override',
        overrideSubmissionVersion: 2,
        publicCommunityId: 'contract-community',
        publicFeedbackId: 'contract-feedback',
      });
      expect(await driver.reset()).toEqual(refs);
    });

    it('prepare、finalize、feedback 与状态查询保持精确回执', async () => {
      const prepared = success(await driver.request({
        method: 'POST',
        path: '/api/v1/submissions/prepare',
        body: {
          kind: 'shared_package',
          title: '合同投稿',
          body: '合同投稿说明',
          coverFile: { fileName: 'cover.webp', sizeBytes: 12, contentType: 'image/webp' },
          packageFile: { fileName: 'pet.zip', sizeBytes: 24, contentType: 'application/zip' },
        },
      }), prepareSubmissionResponseSchema);
      expect(prepared.status).toBe('uploading');
      expect(prepared.coverUpload.path).toContain(prepared.submissionId);
      expect(prepared.packageUpload.path).toContain(prepared.submissionId);

      const finalized = success(await driver.request({
        method: 'POST',
        path: `/api/v1/submissions/${refs.uploadedSubmissionId}/finalize`,
        body: {},
      }), finalizeSubmissionResponseSchema);
      expect(finalized).toEqual({ status: 'system_reviewing' });

      const feedback = success(await driver.request({
        method: 'POST',
        path: '/api/v1/feedback',
        body: { kind: 'feedback', authorName: '合同用户', content: '合同反馈' },
      }), feedbackSubmissionResponseSchema);
      expect(feedback.status).toBe('system_reviewing');

      const status = success(await driver.request({
        method: 'POST',
        path: '/api/v1/submission-status',
        body: { statusToken: refs.uploadedStatusToken },
      }), submissionStatusResponseSchema);
      expect(status).toMatchObject({
        submissionId: refs.uploadedSubmissionId,
        status: 'system_reviewing',
      });
    });

    it('公开列表、详情、下载、反馈与点赞保留发布依据和计数事实', async () => {
      const list = success(await driver.request({
        method: 'GET',
        path: '/api/v1/community?limit=20',
      }), publicCommunityPageSchema);
      expect(list.items).toContainEqual(expect.objectContaining({
        id: refs.publicCommunityId,
        publicationBasis: 'standard',
      }));

      const detail = success(await driver.request({
        method: 'GET',
        path: `/api/v1/community/${refs.publicCommunityId}`,
      }), publicCommunityItemSchema);
      expect(detail.publicationBasis).toBe('standard');

      const download = success(await driver.request({
        method: 'POST',
        path: `/api/v1/community/${refs.publicCommunityId}/download`,
        body: {},
      }), publicDownloadResponseSchema);
      expect(download.publicationBasis).toBe('standard');

      const like = success(await driver.request({
        method: 'POST',
        path: `/api/v1/community/${refs.publicCommunityId}/like`,
        body: {},
      }), publicLikeResponseSchema);
      expect(like).toEqual({ liked: true, likeCount: 1 });

      const feedback = success(await driver.request({
        method: 'GET',
        path: '/api/v1/feedback?kind=feedback&limit=20',
      }), publicFeedbackPageSchema);
      expect(feedback.items).toContainEqual(expect.objectContaining({
        id: refs.publicFeedbackId,
      }));
    });

    it('管理接口只接受专用令牌并区分 401 与 403', async () => {
      failure(await driver.request({
        method: 'GET',
        path: '/api/v1/admin/submissions?limit=20',
      }), 401, 'UNAUTHORIZED');
      failure(await driver.request({
        method: 'GET',
        path: '/api/v1/admin/submissions?limit=20',
        headers: { authorization: `Bearer ${refs.adminToken}` },
      }), 401, 'UNAUTHORIZED');
      failure(await driver.request({
        method: 'GET',
        path: '/api/v1/admin/submissions?limit=20',
        headers: { 'x-ai-pet-admin-token': 'not-an-admin' },
      }), 403, 'FORBIDDEN');
      success(await driver.request({
        method: 'GET',
        path: '/api/v1/admin/submissions?limit=20',
        headers: { 'x-ai-pet-admin-token': refs.adminToken },
      }), adminQueueResponseSchema);
    });

    it('管理员动作校验版本并保持幂等重放与冲突语义', async () => {
      const path = `/api/v1/admin/submissions/${refs.adminSubmissionId}/actions`;
      const body = {
        action: 'move_to_manual',
        version: refs.adminSubmissionVersion,
        idempotencyKey: 'contract-move-001',
        reason: '进入人工审核',
      };
      const first = success(await driver.request({
        method: 'POST', path, body,
        headers: { 'x-ai-pet-admin-token': refs.adminToken },
      }), adminActionResponseSchema);
      expect(first).toMatchObject({
        replayed: false,
        submission: {
          status: 'manual_review_pending',
          statusVersion: refs.adminSubmissionVersion + 1,
        },
      });

      const replay = success(await driver.request({
        method: 'POST', path, body,
        headers: { 'x-ai-pet-admin-token': refs.adminToken },
      }), adminActionResponseSchema);
      expect(replay.replayed).toBe(true);
      expect(replay.submission.statusVersion).toBe(first.submission.statusVersion);

      failure(await driver.request({
        method: 'POST', path,
        headers: { 'x-ai-pet-admin-token': refs.adminToken },
        body: { ...body, reason: '同键异参' },
      }), 409, 'IDEMPOTENCY_CONFLICT');
      failure(await driver.request({
        method: 'POST', path,
        headers: { 'x-ai-pet-admin-token': refs.adminToken },
        body: { ...body, idempotencyKey: 'contract-move-002' },
      }), 409, 'VERSION_CONFLICT');
    });

    it('强制发布要求精确风险确认并公开 admin_override', async () => {
      const path = `/api/v1/admin/submissions/${refs.overrideSubmissionId}/actions`;
      const base = {
        action: 'force_publish',
        version: refs.overrideSubmissionVersion,
        idempotencyKey: 'contract-force-001',
        reason: '管理员确认风险后发布',
      };
      failure(await driver.request({
        method: 'POST', path,
        headers: { 'x-ai-pet-admin-token': refs.adminToken },
        body: { ...base, riskAcknowledgement: 'WRONG' },
      }), 400, 'INVALID_REQUEST');

      const published = success(await driver.request({
        method: 'POST', path,
        headers: { 'x-ai-pet-admin-token': refs.adminToken },
        body: { ...base, riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED' },
      }), adminActionResponseSchema);
      expect(published).toMatchObject({
        replayed: false,
        submission: { status: 'published', publicationBasis: 'admin_override' },
      });

      const detail = success(await driver.request({
        method: 'GET',
        path: `/api/v1/community/${refs.overrideSubmissionId}`,
      }), publicCommunityItemSchema);
      expect(detail.publicationBasis).toBe('admin_override');
    });
  });
}
