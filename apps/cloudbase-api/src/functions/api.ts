import { createHmac, randomUUID } from 'node:crypto';

import cloudbaseWeb from '@cloudbase/js-sdk';
import cloudbaseNode from '@cloudbase/node-sdk';
import {
  captchaProofSchema,
  submissionStatusViewSchema
} from '@myself/shared-types';

import {
  CloudBasePostgresRpcClient,
  CloudBasePostgresStore
} from '../adapters/cloudbase-postgres.js';
import { CloudBaseStorage } from '../adapters/cloudbase-storage.js';
import {
  createTencentCaptchaClient,
  TencentCaptchaVerifier
} from '../adapters/tencent-captcha.js';
import { loadCloudConfig } from '../config.js';
import {
  ApiError,
  jsonResponse,
  type CloudBaseHttpResponse
} from '../errors.js';
import type { CloudBaseHttpEvent } from '../http/router.js';
import { AbuseControl } from '../services/abuse-control.js';
import {
  PublicContentService,
  type PublicCommunityItem,
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
    cursor?: number | null;
  }): Promise<{ items: PublicCommunityItem[]; nextCursor: number | null }>;
  getCommunity(id: string): Promise<PublicCommunityItem>;
  listFeedback(
    kind: 'feedback' | 'suggestion',
    input: { limit: number; cursor?: number | null }
  ): Promise<{ items: PublicFeedbackItem[]; nextCursor: number | null }>;
  toggleLike(id: string, fingerprint: string): Promise<unknown>;
  getDownload(id: string): Promise<unknown>;
}

interface AbuseControlApi {
  consume(scope: string, fingerprint: string): Promise<void>;
}

export interface ApiDependencies {
  submissions: SubmissionApi;
  textSubmissions: TextSubmissionApi;
  publicContent: PublicContentApi;
  abuseControl: AbuseControlApi;
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
      return jsonResponse(apiError.statusCode, null, apiError, requestId);
    }
  };
}

async function dispatch(
  event: ApiHttpEvent,
  context: ApiContext,
  dependencies: ApiDependencies
): Promise<unknown> {
  const method = event.httpMethod;
  const path = event.path;

  if (method === 'POST' && path === '/api/v1/submissions/prepare') {
    const body = requestRecord(event);
    if (!captchaProofSchema.safeParse(body.captcha).success) {
      throw invalidRequest();
    }
    const ip = requireSourceIp(context);
    await dependencies.abuseControl.consume(
      'submission_prepare',
      ipFingerprint(ip, dependencies.fingerprintSecret)
    );
    return dependencies.submissions.prepare(
      body as unknown as PrepareSubmissionInput,
      { ip }
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
    requestRecord(event);
    return dependencies.submissions.finalize({ submissionId: finalizeId });
  }

  if (method === 'POST' && path === '/api/v1/feedback') {
    const body = requestRecord(event);
    if (!captchaProofSchema.safeParse(body.captcha).success) {
      throw invalidRequest();
    }
    const ip = requireSourceIp(context);
    await dependencies.abuseControl.consume(
      'submission_prepare',
      ipFingerprint(ip, dependencies.fingerprintSecret)
    );
    return dependencies.textSubmissions.submit(
      body as unknown as TextSubmissionInput,
      { ip }
    );
  }

  if (method === 'POST' && path === '/api/v1/submission-status') {
    const body = requestRecord(event);
    if (typeof body.statusToken !== 'string') throw invalidRequest();
    const ip = requireSourceIp(context);
    await dependencies.abuseControl.consume(
      'status_query',
      ipFingerprint(ip, dependencies.fingerprintSecret)
    );
    return publicStatus(await dependencies.submissions.getStatus(body.statusToken));
  }

  if (method === 'GET' && path === '/api/v1/community') {
    const page = await dependencies.publicContent.listCommunity(
      publicListQuery(event)
    );
    return {
      items: page.items.map(publicCommunity),
      nextCursor: page.nextCursor
    };
  }

  if (method === 'GET' && path === '/api/v1/feedback') {
    const kind = event.queryStringParameters?.kind;
    if (kind !== 'feedback' && kind !== 'suggestion') throw invalidRequest();
    const page = await dependencies.publicContent.listFeedback(
      kind,
      publicListQuery(event)
    );
    return {
      items: page.items.map(publicFeedback),
      nextCursor: page.nextCursor
    };
  }

  const likeId = dynamicId(
    method,
    path,
    'POST',
    '/api/v1/community/',
    '/like'
  );
  if (likeId !== null) {
    requestRecord(event);
    const deviceHash = deviceFingerprint(
      requireSourceIp(context),
      header(event.headers, 'user-agent'),
      dependencies.fingerprintSecret
    );
    await dependencies.abuseControl.consume(`like:${likeId}`, deviceHash);
    return dependencies.publicContent.toggleLike(likeId, deviceHash);
  }

  const downloadId = dynamicId(
    method,
    path,
    'POST',
    '/api/v1/community/',
    '/download'
  );
  if (downloadId !== null) {
    requestRecord(event);
    const deviceHash = deviceFingerprint(
      requireSourceIp(context),
      header(event.headers, 'user-agent'),
      dependencies.fingerprintSecret
    );
    await dependencies.abuseControl.consume(
      `download:${downloadId}`,
      deviceHash
    );
    return dependencies.publicContent.getDownload(downloadId);
  }

  const communityId = dynamicId(
    method,
    path,
    'GET',
    '/api/v1/community/',
    ''
  );
  if (communityId !== null) {
    return publicCommunity(
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
  cursor?: number | null;
} {
  const rawLimit = event.queryStringParameters?.limit;
  const rawCursor = event.queryStringParameters?.cursor;
  const limit = rawLimit === undefined ? 20 : Number(rawLimit);
  const cursor = rawCursor === undefined ? undefined : Number(rawCursor);
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > 100
    || (
      cursor !== undefined
      && (!Number.isSafeInteger(cursor) || cursor < 0)
    )
  ) {
    throw invalidRequest();
  }
  return {
    limit,
    ...(cursor === undefined ? {} : { cursor })
  };
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

function requireSourceIp(context: ApiContext): string {
  const ip = context.sourceIp;
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

function publicStatus(value: unknown): Record<string, unknown> {
  const row = submissionStatusViewSchema.strip().parse(value);
  return {
    submissionId: row.submissionId,
    status: row.status,
    publicReason: row.publicReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function publicCommunity(item: PublicCommunityItem): PublicCommunityItem {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    cover: {
      url: item.cover.url,
      expiresAt: item.cover.expiresAt
    },
    packageFileName: item.packageFileName,
    packageSizeBytes: item.packageSizeBytes,
    likeCount: item.likeCount,
    downloadCount: item.downloadCount,
    publishedAt: item.publishedAt
  };
}

function publicFeedback(item: PublicFeedbackItem): PublicFeedbackItem {
  return {
    id: item.id,
    kind: item.kind,
    authorName: item.authorName,
    content: item.content,
    likeCount: item.likeCount,
    createdAt: item.createdAt
  };
}

function safeRequestId(value: string | undefined): string {
  return typeof value === 'string'
    && /^[A-Za-z0-9._:-]{1,128}$/u.test(value)
    ? value
    : randomUUID();
}

function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (typeof error === 'object' && error !== null) {
    const value = error as Record<string, unknown>;
    if (
      typeof value.code === 'string'
      && typeof value.statusCode === 'number'
      && Number.isSafeInteger(value.statusCode)
      && value.statusCode >= 400
      && value.statusCode <= 599
    ) {
      return new ApiError(
        value.code,
        value.statusCode,
        '受控错误',
        typeof value.retryAfterSeconds === 'number'
          && Number.isSafeInteger(value.retryAfterSeconds)
          && value.retryAfterSeconds > 0
          ? value.retryAfterSeconds
          : undefined
      );
    }
  }
  return new ApiError('INTERNAL_ERROR', 500);
}

function invalidRequest(): ApiError {
  return new ApiError('INVALID_REQUEST', 400);
}

let productionHandler: ApiHandler | undefined;

/** CloudBase 函数入口；初始化失败同样返回稳定的失败关闭信封。 */
export async function main(
  event: ApiHttpEvent,
  context: ApiContext
): Promise<CloudBaseHttpResponse> {
  try {
    productionHandler ??= createProductionHandler();
    return await productionHandler(event, context);
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

function createProductionHandler(): ApiHandler {
  const config = loadCloudConfig(process.env);
  const nodeApp = cloudbaseNode.init({ env: config.envId });
  const webApp = cloudbaseWeb.init({ env: config.envId });
  const bucket = webApp.storage.from(config.privateBucketId);
  const store = new CloudBasePostgresStore(
    nodeApp.rdb(),
    new CloudBasePostgresRpcClient(config.envId, config.cloudbaseApiKey)
  );
  const storage = new CloudBaseStorage(bucket);
  const captcha = new TencentCaptchaVerifier(
    createTencentCaptchaClient(),
    store,
    config
  );
  return createApi({
    submissions: new SubmissionService(store, storage, captcha),
    textSubmissions: new TextSubmissionService(store, captcha),
    publicContent: new PublicContentService(store, storage),
    abuseControl: new AbuseControl(store),
    fingerprintSecret: config.abuseHmacSecret
  });
}
