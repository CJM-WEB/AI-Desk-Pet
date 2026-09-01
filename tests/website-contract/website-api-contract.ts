import {
  adminActionResponseSchema,
  adminQueueResponseSchema,
  feedbackSubmissionResponseSchema,
  finalizeSubmissionResponseSchema,
  prepareSubmissionResponseSchema,
  publicCommunityItemSchema,
  publicCommunityPageSchema,
  publicDownloadResponseSchema,
  publicFeedbackPageSchema,
  publicLikeResponseSchema,
  submissionStatusResponseSchema,
  websiteHttpEnvelopeSchema,
  type WebsiteHttpEnvelope,
} from '@myself/shared-types/website-http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

export interface ContractRequest {
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ContractResponse {
  status: number;
  envelope: WebsiteHttpEnvelope;
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
  advanceTime(milliseconds: number): Promise<void>;
  close(): Promise<void>;
}

/** 两个 driver 共用同一个严格信封解码边界。 */
export function decodeContractResponse(status: number, body: unknown): ContractResponse {
  return { status, envelope: websiteHttpEnvelopeSchema.parse(body) };
}

function success<T>(
  response: ContractResponse,
  schema: { parse(value: unknown): T },
): T {
  expect(response.status).toBe(200);
  if ('error' in response.envelope) {
    throw new Error(`预期成功信封，实际为 ${response.envelope.error.code}`);
  }
  return schema.parse(response.envelope.data);
}

function failure(response: ContractResponse, status: number, code: string): void {
  expect(response.status).toBe(status);
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

      const downloadOperationId = '00000000-0000-4000-8000-000000000300';
      const downloadRequest = { operationId: downloadOperationId };
      const download = success(await driver.request({
        method: 'POST',
        path: `/api/v1/community/${refs.publicCommunityId}/download`,
        body: downloadRequest,
      }), publicDownloadResponseSchema);
      expect(download.publicationBasis).toBe('standard');
      const downloadReplay = success(await driver.request({
        method: 'POST',
        path: `/api/v1/community/${refs.publicCommunityId}/download`,
        body: downloadRequest,
      }), publicDownloadResponseSchema);
      expect(downloadReplay.publicationBasis).toBe('standard');
      const detailAfterDownloadReplay = success(await driver.request({
        method: 'GET',
        path: `/api/v1/community/${refs.publicCommunityId}`,
      }), publicCommunityItemSchema);
      expect(detailAfterDownloadReplay.downloadCount)
        .toBe(detail.downloadCount + 1);

      const operationId = '00000000-0000-4000-8000-000000000301';
      const likeRequest = { liked: true, operationId };
      const like = success(await driver.request({
        method: 'POST',
        path: `/api/v1/community/${refs.publicCommunityId}/like`,
        body: likeRequest,
      }), publicLikeResponseSchema);
      expect(like).toEqual({ liked: true, likeCount: 1 });
      const replay = success(await driver.request({
        method: 'POST',
        path: `/api/v1/community/${refs.publicCommunityId}/like`,
        body: likeRequest,
      }), publicLikeResponseSchema);
      expect(replay).toEqual(like);
      const sameDesiredState = success(await driver.request({
        method: 'POST',
        path: `/api/v1/community/${refs.publicCommunityId}/like`,
        body: {
          liked: true,
          operationId: '00000000-0000-4000-8000-000000000302',
        },
      }), publicLikeResponseSchema);
      expect(sameDesiredState).toEqual({ liked: true, likeCount: 1 });
      const secondDevice = success(await driver.request({
        method: 'POST',
        path: `/api/v1/community/${refs.publicCommunityId}/like`,
        headers: { 'user-agent': 'website-contract-second-device' },
        body: {
          liked: true,
          operationId: '00000000-0000-4000-8000-000000000303',
        },
      }), publicLikeResponseSchema);
      expect(secondDevice).toEqual({ liked: true, likeCount: 2 });
      failure(await driver.request({
        method: 'POST',
        path: `/api/v1/community/${refs.publicCommunityId}/like`,
        body: { liked: false, operationId },
      }), 409, 'IDEMPOTENCY_CONFLICT');

      const feedback = success(await driver.request({
        method: 'GET',
        path: '/api/v1/feedback?kind=feedback&limit=20',
      }), publicFeedbackPageSchema);
      expect(feedback.items).toContainEqual(expect.objectContaining({
        id: refs.publicFeedbackId,
      }));
    });

    it('点赞 operation UUID 大小写等价且在精确 24 小时后失效', async () => {
      const uppercase = '00000000-0000-4000-8000-00000000ABCD';
      const lowercase = uppercase.toLowerCase();
      const path = `/api/v1/community/${refs.publicCommunityId}/like`;
      const first = success(await driver.request({
        method: 'POST',
        path,
        body: { liked: true, operationId: uppercase },
      }), publicLikeResponseSchema);
      expect(first).toEqual({ liked: true, likeCount: 1 });
      expect(success(await driver.request({
        method: 'POST',
        path,
        body: { liked: true, operationId: lowercase },
      }), publicLikeResponseSchema)).toEqual(first);
      failure(await driver.request({
        method: 'POST',
        path,
        body: { liked: false, operationId: lowercase },
      }), 409, 'IDEMPOTENCY_CONFLICT');

      await driver.advanceTime(24 * 60 * 60 * 1000);

      expect(success(await driver.request({
        method: 'POST',
        path,
        body: { liked: false, operationId: lowercase },
      }), publicLikeResponseSchema)).toEqual({ liked: false, likeCount: 0 });
    });

    it('同 operation 不能跨社区与反馈 endpoint 回放', async () => {
      const operationId = '00000000-0000-4000-8000-00000000bcde';
      const body = { liked: true, operationId };
      expect(success(await driver.request({
        method: 'POST',
        path: `/api/v1/community/${refs.publicCommunityId}/like`,
        body,
      }), publicLikeResponseSchema)).toEqual({ liked: true, likeCount: 1 });

      failure(await driver.request({
        method: 'POST',
        path: `/api/v1/feedback/${refs.publicCommunityId}/like`,
        body,
      }), 409, 'IDEMPOTENCY_CONFLICT');
    });

    it('三条列表只回传 scoped opaque token 且第二页不重复第一项', async () => {
      const first = success(await driver.request({
        method: 'GET',
        path: '/api/v1/community?limit=1',
      }), publicCommunityPageSchema);
      expect(first.items).toHaveLength(1);
      expect(first.items[0]?.id).toBe(refs.publicCommunityId);
      expect(first.nextCursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/u);

      const second = success(await driver.request({
        method: 'GET',
        path: `/api/v1/community?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      }), publicCommunityPageSchema);
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
      expect(second.nextCursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/u);

      const firstFeedback = success(await driver.request({
        method: 'GET',
        path: '/api/v1/feedback?kind=feedback&limit=1',
      }), publicFeedbackPageSchema);
      expect(firstFeedback.nextCursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/u);
      expect(firstFeedback.items[0]?.id).toBe(refs.publicFeedbackId);
      const secondFeedback = success(await driver.request({
        method: 'GET',
        path: `/api/v1/feedback?kind=feedback&limit=1&cursor=${encodeURIComponent(firstFeedback.nextCursor!)}`,
      }), publicFeedbackPageSchema);
      expect(secondFeedback.items[0]?.id).not.toBe(firstFeedback.items[0]?.id);

      const adminHeaders = { 'x-ai-pet-admin-token': refs.adminToken };
      const firstAdmin = success(await driver.request({
        method: 'GET',
        path: '/api/v1/admin/submissions?limit=1',
        headers: adminHeaders,
      }), adminQueueResponseSchema);
      expect(firstAdmin.nextCursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/u);
      const secondAdmin = success(await driver.request({
        method: 'GET',
        path: `/api/v1/admin/submissions?limit=1&cursor=${encodeURIComponent(firstAdmin.nextCursor!)}`,
        headers: adminHeaders,
      }), adminQueueResponseSchema);
      expect(secondAdmin.items[0]?.id).not.toBe(firstAdmin.items[0]?.id);

      failure(await driver.request({
        method: 'GET',
        path: `/api/v1/feedback?kind=feedback&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      }), 400, 'INVALID_CURSOR');
      failure(await driver.request({
        method: 'GET',
        path: `/api/v1/admin/submissions?limit=1&status=system_reviewing&cursor=${encodeURIComponent(firstAdmin.nextCursor!)}`,
        headers: adminHeaders,
      }), 400, 'INVALID_CURSOR');
      failure(await driver.request({
        method: 'GET',
        path: `/api/v1/community?limit=1&cursor=${'x'.repeat(513)}`,
      }), 400, 'INVALID_CURSOR');

      const impossibleDate = Buffer.from(JSON.stringify({
        scope: 'community',
        sortTime: '2026-02-30T03:00:00.000Z',
        id: 'contract-community',
      })).toString('base64url');
      failure(await driver.request({
        method: 'GET',
        path: `/api/v1/community?limit=1&cursor=v1.${impossibleDate}`,
      }), 400, 'INVALID_CURSOR');

      const impossibleOffset = Buffer.from(JSON.stringify({
        scope: 'community',
        sortTime: '2026-08-31T03:00:00+14:01',
        id: 'contract-community',
      })).toString('base64url');
      failure(await driver.request({
        method: 'GET',
        path: `/api/v1/community?limit=1&cursor=v1.${impossibleOffset}`,
      }), 400, 'INVALID_CURSOR');

      const invalidUtf8 = Buffer.concat([
        Buffer.from(`{"scope":"community","sortTime":"2026-07-31T00:00:00.000Z","id":"`),
        Buffer.from([0xff]),
        Buffer.from('"}'),
      ]).toString('base64url');
      failure(await driver.request({
        method: 'GET',
        path: `/api/v1/community?limit=1&cursor=v1.${invalidUtf8}`,
      }), 400, 'INVALID_CURSOR');
    });

    it('社区键集保留 PostgreSQL 微秒顺序并规范化等价 offset', async () => {
      const first = success(await driver.request({
        method: 'GET',
        path: '/api/v1/community?limit=1',
      }), publicCommunityPageSchema);
      expect(first.items.map(item => item.id)).toEqual(['contract-community']);

      const second = success(await driver.request({
        method: 'GET',
        path: `/api/v1/community?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      }), publicCommunityPageSchema);
      expect(second.items.map(item => item.id)).toEqual(['contract-b']);

      const third = success(await driver.request({
        method: 'GET',
        path: `/api/v1/community?limit=1&cursor=${encodeURIComponent(second.nextCursor!)}`,
      }), publicCommunityPageSchema);
      expect(third.items.map(item => item.id)).toEqual(['contract-z']);
      expect(third.nextCursor).toBeNull();
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
