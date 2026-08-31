import { createHmac, randomUUID } from 'node:crypto';

import type { SubmissionStatus } from '@myself/shared-types';
import {
  adminActionRequestSchema,
  adminActionResponseSchema,
  adminDetailRequestSchema,
  adminDetailResponseSchema,
  adminQueueRequestSchema,
  adminQueueResponseSchema,
  feedbackSubmissionRequestSchema,
  feedbackSubmissionResponseSchema,
  finalizeSubmissionRequestSchema,
  finalizeSubmissionResponseSchema,
  prepareSubmissionRequestSchema,
  prepareSubmissionResponseSchema,
  publicCommunityItemSchema,
  publicCommunityPageSchema,
  publicDetailRequestSchema,
  publicDownloadRequestSchema,
  publicDownloadResponseSchema,
  publicFeedbackListRequestSchema,
  publicFeedbackPageSchema,
  publicLikeRequestSchema,
  publicLikeResponseSchema,
  publicListRequestSchema,
  submissionStatusRequestSchema,
  submissionStatusResponseSchema
} from '@myself/shared-types/website-http';
import { ZodError } from 'zod';

import { CloudBaseAdminIdentityProvider } from '../adapters/cloudbase-auth.js';
import {
  CloudBasePostgresRpcClient,
  CloudBasePostgresStore,
  DEFAULT_RPC_CLIENT_OPTIONS
} from '../adapters/cloudbase-postgres.js';
import { createCloudBaseServerRuntime } from '../adapters/cloudbase-runtime.js';
import type { CloudBaseFunctionContext } from '../adapters/cloudbase-runtime.js';
import { CloudBaseStorage } from '../adapters/cloudbase-storage.js';
import { loadApiConfig } from '../config.js';
import {
  ApiError,
  jsonResponse,
  type CloudBaseHttpResponse
} from '../errors.js';
import type { CloudBaseHttpEvent } from '../http/router.js';
import { AbuseControl } from '../services/abuse-control.js';
import { AdminService } from '../services/admin-service.js';
import {
  PublicContentService,
  type PublicCommunityItem,
  type PublicDownload,
  type PublicFeedbackItem
} from '../services/public-content-service.js';
import {
  SubmissionService,
  type PrepareSubmissionInput
} from '../services/submission-service.js';
import {
  TextSubmissionService,
  type TextSubmissionInput
} from '../services/text-submission-service.js';

export interface ApiHttpEvent extends CloudBaseHttpEvent {
  queryStringParameters?: Record<string, string | undefined>;
  requestContext?: {
    sourceIp?: string;
  };
}

export interface ApiContext {
  requestId?: string;
  sourceIp?: string;
}

interface SubmissionApi {
  prepare(
    input: PrepareSubmissionInput,
    context: { ip: string }
  ): Promise<unknown>;
  finalize(input: { submissionId: string }): Promise<unknown>;
  getStatus(token: string): Promise<unknown>;
}

interface TextSubmissionApi {
  submit(
    input: TextSubmissionInput,
    context: { ip: string }
  ): Promise<unknown>;
}

interface PublicContentApi {
  listCommunity(input: {
    limit: number;
    cursor?: string | null;
  }): Promise<{ items: PublicCommunityItem[]; nextCursor: string | null }>;
  getCommunity(id: string): Promise<PublicCommunityItem>;
  listFeedback(
    kind: 'feedback' | 'suggestion',
    input: { limit: number; cursor?: string | null }
  ): Promise<{ items: PublicFeedbackItem[]; nextCursor: string | null }>;
  setFeedbackLike(
    id: string,
    fingerprint: string,
    desiredLiked: boolean,
    operationId: string
  ): Promise<unknown>;
  setCommunityLike(
    id: string,
    fingerprint: string,
    desiredLiked: boolean,
    operationId: string
  ): Promise<unknown>;
  getDownload(id: string): Promise<PublicDownload>;
}

interface AbuseControlApi {
  consume(scope: string, fingerprint: string): Promise<void>;
}

interface AdminIdentityApi {
  requireAdmin(accessToken: string): Promise<{ uid: string; email: string }>;
}

interface AdminApi {
  listQueue(input: {
    limit: number;
    cursor?: string | null;
    status?: SubmissionStatus;
  }): Promise<unknown>;
  getDetail(id: string): Promise<unknown>;
  applyAction(
    identity: { uid: string; email: string },
    id: string,
    action: ReturnType<typeof adminActionRequestSchema.parse>
  ): Promise<unknown>;
}

export interface ApiDependencies {
  submissions: SubmissionApi;
  textSubmissions: TextSubmissionApi;
  publicContent: PublicContentApi;
  abuseControl: AbuseControlApi;
  adminIdentity: AdminIdentityApi;
  admin: AdminApi;
  fingerprintSecret: string;
}

export type ApiHandler = (
  event: ApiHttpEvent,
  context: ApiContext
) => Promise<CloudBaseHttpResponse>;

/** 创建可注入依赖的公开 API，所有响应都使用稳定且不可缓存的信封。 */
export function createApi(dependencies: ApiDependencies): ApiHandler {
  if (!dependencies.fingerprintSecret) {
    throw new Error('缺少风控指纹配置');
  }

  return async (event, context) => {
    const requestId = safeRequestId(context.requestId);
    try {
      const data = await dispatch(event, context, dependencies);
      return jsonResponse(200, data, null, requestId);
    } catch (error) {
      const apiError = normalizeError(error);
      return jsonResponse(
        apiError.statusCode,
        null,
        apiError,
        error instanceof ZodError ? randomUUID() : requestId
      );
    }
  };
}

async function dispatch(
  event: ApiHttpEvent,
  context: ApiContext,
  dependencies: ApiDependencies
): Promise<unknown> {
  const method = event.httpMethod;
  // CloudBase HTTP 服务会剥离绑定的 `api` 前缀，本地直调仍保留完整路径。
  const path = event.path.startsWith('/v1/')
    ? `/api${event.path}`
    : event.path;

  if (method === 'GET' && path === '/api/v1/admin/submissions') {
    await dependencies.adminIdentity.requireAdmin(requireAdminToken(event));
    return adminQueueResponseSchema.parse(
      await dependencies.admin.listQueue(adminListQuery(event))
    );
  }

  const adminActionId = dynamicId(
    method,
    path,
    'POST',
    '/api/v1/admin/submissions/',
    '/actions'
  );
  if (adminActionId !== null) {
    const identity = await dependencies.adminIdentity.requireAdmin(
      requireAdminToken(event)
    );
    const action = adminActionRequestSchema.safeParse(requestRecord(event));
    if (!action.success) throw invalidRequest();
    return adminActionResponseSchema.parse(
      await dependencies.admin.applyAction(identity, adminActionId, action.data)
    );
  }

  const adminDetailId = dynamicId(
    method,
    path,
    'GET',
    '/api/v1/admin/submissions/',
    ''
  );
  if (adminDetailId !== null) {
    await dependencies.adminIdentity.requireAdmin(requireAdminToken(event));
    const request = adminDetailRequestSchema.safeParse(
      detailRequest(event, adminDetailId)
    );
    if (!request.success) throw invalidRequest();
    return adminDetailResponseSchema.parse(
      await dependencies.admin.getDetail(adminDetailId)
    );
  }

  if (method === 'POST' && path === '/api/v1/submissions/prepare') {
    const body = prepareSubmissionRequestSchema.safeParse(requestRecord(event));
    if (!body.success) throw invalidRequest();
    const ip = requireSourceIp(event, context);
    await dependencies.abuseControl.consume(
      'submission_prepare',
      ipFingerprint(ip, dependencies.fingerprintSecret)
    );
    return prepareSubmissionResponseSchema.parse(
      await dependencies.submissions.prepare(body.data, { ip })
    );
  }

  const finalizeId = dynamicId(
    method,
    path,
    'POST',
    '/api/v1/submissions/',
    '/finalize'
  );
  if (finalizeId !== null) {
    const body = finalizeSubmissionRequestSchema.safeParse(requestRecord(event));
    if (!body.success) throw invalidRequest();
    return finalizeSubmissionResponseSchema.parse(
      await dependencies.submissions.finalize({ submissionId: finalizeId })
    );
  }

  if (method === 'POST' && path === '/api/v1/feedback') {
    const body = feedbackSubmissionRequestSchema.safeParse(requestRecord(event));
    if (!body.success) throw invalidRequest();
    const ip = requireSourceIp(event, context);
    await dependencies.abuseControl.consume(
      'submission_prepare',
      ipFingerprint(ip, dependencies.fingerprintSecret)
    );
    return feedbackSubmissionResponseSchema.parse(
      await dependencies.textSubmissions.submit(body.data, { ip })
    );
  }

  if (method === 'POST' && path === '/api/v1/submission-status') {
    const body = submissionStatusRequestSchema.safeParse(requestRecord(event));
    if (!body.success) throw invalidRequest();
    const ip = requireSourceIp(event, context);
    await dependencies.abuseControl.consume(
      'status_query',
      ipFingerprint(ip, dependencies.fingerprintSecret)
    );
    return submissionStatusResponseSchema.parse(
      await dependencies.submissions.getStatus(body.data.statusToken)
    );
  }

  if (method === 'GET' && path === '/api/v1/community') {
    return publicCommunityPageSchema.parse(
      await dependencies.publicContent.listCommunity(publicListQuery(event))
    );
  }

  if (method === 'GET' && path === '/api/v1/feedback') {
    const query = publicFeedbackListQuery(event);
    return publicFeedbackPageSchema.parse(
      await dependencies.publicContent.listFeedback(query.kind, query.page)
    );
  }

  const feedbackLikeId = dynamicId(
    method,
    path,
    'POST',
    '/api/v1/feedback/',
    '/like'
  );
  if (feedbackLikeId !== null) {
    const body = publicLikeRequestSchema.safeParse(requestRecord(event));
    if (!body.success) throw invalidRequest();
    const deviceHash = deviceFingerprint(
      requireSourceIp(event, context),
      header(event.headers, 'user-agent'),
      dependencies.fingerprintSecret
    );
    await dependencies.abuseControl.consume(`like:${feedbackLikeId}`, deviceHash);
    return publicLikeResponseSchema.parse(
      await dependencies.publicContent.setFeedbackLike(
        feedbackLikeId,
        deviceHash,
        body.data.liked,
        body.data.operationId
      )
    );
  }

  const likeId = dynamicId(
    method,
    path,
    'POST',
    '/api/v1/community/',
    '/like'
  );
  if (likeId !== null) {
    const body = publicLikeRequestSchema.safeParse(requestRecord(event));
    if (!body.success) throw invalidRequest();
    const deviceHash = deviceFingerprint(
      requireSourceIp(event, context),
      header(event.headers, 'user-agent'),
      dependencies.fingerprintSecret
    );
    await dependencies.abuseControl.consume(`like:${likeId}`, deviceHash);
    return publicLikeResponseSchema.parse(
      await dependencies.publicContent.setCommunityLike(
        likeId,
        deviceHash,
        body.data.liked,
        body.data.operationId
      )
    );
  }

  const downloadId = dynamicId(
    method,
    path,
    'POST',
    '/api/v1/community/',
    '/download'
  );
  if (downloadId !== null) {
    const body = publicDownloadRequestSchema.safeParse(requestRecord(event));
    if (!body.success) throw invalidRequest();
    const deviceHash = deviceFingerprint(
      requireSourceIp(event, context),
      header(event.headers, 'user-agent'),
      dependencies.fingerprintSecret
    );
    await dependencies.abuseControl.consume(
      `download:${downloadId}`,
      deviceHash
    );
    return publicDownloadResponseSchema.parse(
      await dependencies.publicContent.getDownload(downloadId)
    );
  }

  const communityId = dynamicId(
    method,
    path,
    'GET',
    '/api/v1/community/',
    ''
  );
  if (communityId !== null) {
    const request = publicDetailRequestSchema.safeParse(
      detailRequest(event, communityId)
    );
    if (!request.success) throw invalidRequest();
    return publicCommunityItemSchema.parse(
      await dependencies.publicContent.getCommunity(communityId)
    );
  }

  throw new ApiError('NOT_FOUND', 404);
}

function requestRecord(event: ApiHttpEvent): Record<string, unknown> {
  if (typeof event.body !== 'string' || event.body.length > 1024 * 1024) {
    throw invalidRequest();
  }
  try {
    const value: unknown = JSON.parse(event.body);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw invalidRequest();
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalidRequest();
  }
}

function publicListQuery(event: ApiHttpEvent): {
  limit: number;
  cursor?: string | null;
} {
  const query = publicListRequestSchema.safeParse(listQuery(event));
  if (!query.success) throw invalidRequest();
  return query.data.cursor === undefined
    ? { limit: query.data.limit }
    : { limit: query.data.limit, cursor: query.data.cursor };
}

function detailRequest(
  event: ApiHttpEvent,
  id: string
): { path: { id: string }; query: Record<string, unknown>; body: Record<string, unknown> } {
  return {
    path: { id },
    query: { ...(event.queryStringParameters ?? {}) },
    body: event.body === undefined ? {} : requestRecord(event)
  };
}

function publicFeedbackListQuery(event: ApiHttpEvent): {
  kind: 'feedback' | 'suggestion';
  page: { limit: number; cursor?: string };
} {
  const query = publicFeedbackListRequestSchema.safeParse(listQuery(event));
  if (!query.success) throw invalidRequest();
  const page = query.data.cursor === undefined
    ? { limit: query.data.limit }
    : { limit: query.data.limit, cursor: query.data.cursor };
  return { kind: query.data.kind, page };
}

function adminListQuery(event: ApiHttpEvent): {
  limit: number;
  cursor?: string | null;
  status?: SubmissionStatus;
} {
  const query = adminQueueRequestSchema.safeParse(listQuery(event));
  if (!query.success) throw invalidRequest();
  return {
    limit: query.data.limit,
    ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
    ...(query.data.status === undefined ? {} : { status: query.data.status })
  };
}

/** 列表仅把 limit 转成数值；opaque cursor 必须原样进入共享 Schema。 */
function listQuery(event: ApiHttpEvent): Record<string, unknown> {
  const query: Record<string, unknown> = {
    ...(event.queryStringParameters ?? {})
  };
  query.limit = query.limit === undefined ? 20 : Number(query.limit);
  return query;
}

function dynamicId(
  actualMethod: string,
  path: string,
  expectedMethod: string,
  prefix: string,
  suffix: string
): string | null {
  if (
    actualMethod !== expectedMethod
    || !path.startsWith(prefix)
    || !path.endsWith(suffix)
  ) {
    return null;
  }
  const encoded = path.slice(prefix.length, suffix.length === 0
    ? undefined
    : -suffix.length);
  if (!encoded) throw invalidRequest();

  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw invalidRequest();
  }
  if (
    decoded.includes('/')
    || decoded.includes('\\')
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(decoded)
  ) {
    throw invalidRequest();
  }
  return decoded;
}

/** 兼容函数直调与 API 网关，并只信任 CloudBase 强制覆盖的 Envoy 来源头。 */
function requireSourceIp(event: ApiHttpEvent, context: ApiContext): string {
  const ip = context.sourceIp
    ?? event.requestContext?.sourceIp
    ?? header(event.headers, 'x-envoy-external-address');
  if (
    typeof ip !== 'string'
    || ip.trim().length === 0
    || ip.length > 128
    || /[\r\n]/u.test(ip)
  ) {
    throw invalidRequest();
  }
  return ip;
}

function ipFingerprint(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex');
}

function deviceFingerprint(
  ip: string,
  userAgent: string,
  secret: string
): string {
  return createHmac('sha256', secret)
    .update(`${ip}\n${userAgent}`)
    .digest('hex');
}

function header(
  headers: Record<string, string | undefined>,
  name: string
): string {
  const matching = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name);
  const value = matching?.[1] ?? '';
  return value.slice(0, 512);
}

/** 管理接口使用专用头传递短期令牌，避免 CloudBase 网关抢先消费 Authorization。 */
function requireAdminToken(event: ApiHttpEvent): string {
  const token = Object.entries(event.headers)
    .find(([key]) => key.toLowerCase() === 'x-ai-pet-admin-token')?.[1];
  if (
    typeof token !== 'string'
    || token.length === 0
    || token.length > 16_384
    || /\s/u.test(token)
  ) {
    throw new ApiError('UNAUTHORIZED', 401);
  }
  return token;
}

function safeRequestId(value: string | undefined): string {
  return typeof value === 'string'
    && /^[A-Za-z0-9._:-]{1,128}$/u.test(value)
    ? value
    : randomUUID();
}

/** 仅公开调用方可稳定处理的 code/status 组合，内部适配器错误统一收敛。 */
const publicErrorStatuses: Readonly<Record<string, number>> = {
  INVALID_REQUEST: 400,
  INVALID_UPLOAD: 400,
  UPLOAD_INCOMPLETE: 400,
  INVALID_LIMIT: 400,
  INVALID_CURSOR: 400,
  INVALID_STATUS_TOKEN_HASH: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SUBMISSION_NOT_FOUND: 404,
  INVALID_ADMIN_ACTION: 409,
  TECHNICAL_SCAN_REQUIRED: 409,
  UPLOAD_STATE_CONFLICT: 409,
  UPLOAD_FINALIZE_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  AUTH_SERVICE_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
  SHARED_PACKAGE_SUBMISSIONS_PAUSED: 503
};

function normalizeError(error: unknown): ApiError {
  if (typeof error === 'object' && error !== null) {
    const value = error as Record<string, unknown>;
    const expectedStatus = typeof value.code === 'string'
      ? publicErrorStatuses[value.code]
      : undefined;
    if (
      expectedStatus !== undefined
      && value.statusCode === expectedStatus
    ) {
      if (value.code === 'RATE_LIMITED') {
        if (
          Number.isSafeInteger(value.retryAfterSeconds)
          && (value.retryAfterSeconds as number) > 0
        ) {
          return new ApiError(
            value.code,
            expectedStatus,
            '受控错误',
            value.retryAfterSeconds as number
          );
        }
      } else if (value.retryAfterSeconds === undefined) {
        return new ApiError(value.code as string, expectedStatus, '受控错误');
      }
    }
  }
  return new ApiError('INTERNAL_ERROR', 500);
}

function invalidRequest(): ApiError {
  return new ApiError('INVALID_REQUEST', 400);
}

/** CloudBase 函数入口；初始化失败同样返回稳定的失败关闭信封。 */
export async function main(
  event: ApiHttpEvent,
  context: ApiContext & CloudBaseFunctionContext
): Promise<CloudBaseHttpResponse> {
  try {
    return await createProductionHandler(context)(event, context);
  } catch {
    const error = new ApiError('SERVICE_UNAVAILABLE', 503);
    return jsonResponse(
      error.statusCode,
      null,
      error,
      safeRequestId(context.requestId)
    );
  }
}

/** 组合公开 API 的生产依赖；每次调用绑定本次临时身份。 */
export function createProductionHandler(
  context: CloudBaseFunctionContext
): ApiHandler {
  const config = loadApiConfig(process.env);
  const runtime = createCloudBaseServerRuntime(config, context);
  const store = new CloudBasePostgresStore(
    runtime.rdb,
    new CloudBasePostgresRpcClient(config.envId, config.cloudbaseApiKey, {
      ...DEFAULT_RPC_CLIENT_OPTIONS,
      timeoutMs: config.cloudbaseSdkTimeoutMs
    })
  );
  const storage = new CloudBaseStorage(runtime.bucket);
  return createApi({
    submissions: new SubmissionService(store, storage, {
      sharedPackageSubmissionsEnabled:
        config.sharedPackageSubmissionsEnabled
    }),
    textSubmissions: new TextSubmissionService(store),
    publicContent: new PublicContentService(store, storage),
    abuseControl: new AbuseControl(store),
    adminIdentity: new CloudBaseAdminIdentityProvider(
      config.envId,
      config.adminEmail,
      config.cloudbaseSdkTimeoutMs
    ),
    admin: new AdminService(store, storage, { now: () => new Date() }),
    fingerprintSecret: config.abuseHmacSecret
  });
}
