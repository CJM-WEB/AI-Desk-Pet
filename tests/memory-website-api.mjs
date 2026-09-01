import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const websiteRequire = createRequire(new URL('../apps/website/package.json', import.meta.url));
const moderationModuleUrl = pathToFileURL(
  websiteRequire.resolve('@myself/shared-types/moderation')
).href;
const { adminActionSchema } = await import(moderationModuleUrl);
const { z } = websiteRequire('zod');

/** Memory 保持与生产共享 wire 同形，避免测试服务器直接装载含内部源码依赖的 TS 聚合模块。 */
const publicLikeRequestSchema = z.object({
  liked: z.boolean(),
  operationId: z.string().uuid().transform(value => value.toLowerCase())
}).strict();
const publicDownloadRequestSchema = z.object({
  operationId: z.string().uuid().transform(value => value.toLowerCase())
}).strict();

const ADMIN_TOKEN = 'e2e-admin-session';
const CONTRACT_ADMIN_TOKEN = 'contract-admin-token';
const CONTRACT_REFS = Object.freeze({
  adminToken: CONTRACT_ADMIN_TOKEN,
  uploadedSubmissionId: 'contract-uploaded',
  uploadedStatusToken: 'c'.repeat(43),
  adminSubmissionId: 'contract-historical-reviewing',
  adminSubmissionVersion: 1,
  overrideSubmissionId: 'contract-override',
  overrideSubmissionVersion: 2,
  standardSubmissionId: 'contract-standard-feedback',
  standardSubmissionVersion: 2,
  invalidForceSubmissionId: 'contract-invalid-force',
  invalidForceSubmissionVersion: 2,
  invalidStandardSubmissionId: 'contract-invalid-standard',
  invalidStandardSubmissionVersion: 2,
  publicCommunityId: 'contract-community',
  damagedPublicCommunityId: 'contract-zz-damaged',
  publicFeedbackId: 'contract-feedback'
});
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** 为单次 Playwright worker 创建完全隔离的确定性 API 状态。 */
export function createMemoryWebsiteApi({ runId }) {
  const submissions = new Map();
  const tokenIndex = new Map();
  const uploads = new Map();
  const adminIdempotency = new Map();
  const interactionOperations = new Map();
  const interactionVotes = new Set();
  let sequence = 0;
  let clockOffsetMs = 0;

  const reset = () => {
    submissions.clear();
    tokenIndex.clear();
    uploads.clear();
    adminIdempotency.clear();
    interactionOperations.clear();
    interactionVotes.clear();
    sequence = 0;
    clockOffsetMs = 0;
    seedContractFixtures(submissions, tokenIndex, uploads);
    return structuredClone(CONTRACT_REFS);
  };

  const nextId = () => `e2e-${++sequence}`;
  const now = () => new Date(
    Date.UTC(2026, 6, 30, 12, 0, sequence) + clockOffsetMs
  ).toISOString();
  const advanceTime = milliseconds => {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error('INVALID_CLOCK_ADVANCE');
    }
    clockOffsetMs += milliseconds;
  };
  const tokenFor = id => createHash('sha256').update(`${runId}:${id}`).digest('base64url');

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const { pathname, searchParams } = url;
    if (request.method === 'POST' && pathname === '/__e2e/reset') {
      return sendData(response, 200, { reset: true, fixtures: reset() });
    }
    if (pathname.startsWith('/__e2e/upload/')) {
      return handleUpload(request, response, pathname);
    }
    if (request.method === 'GET' && pathname.startsWith('/__e2e/cover/')) {
      return sendBinary(response, 'image/png', Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      ));
    }
    if (request.method === 'GET' && pathname.startsWith('/__e2e/download/')) {
      return sendBinary(response, 'application/zip', Buffer.from('e2e-package'));
    }
    if (!pathname.startsWith('/api/v1/')) return false;

    try {
      if (request.method === 'POST' && pathname === '/api/v1/submissions/prepare') {
        const body = await readJson(request);
        if (body.kind !== 'shared_package' || !body.coverFile || !body.packageFile) {
          return sendError(response, 400, 'INVALID_REQUEST');
        }
        const id = nextId();
        const statusToken = tokenFor(id);
        const createdAt = now();
        const record = {
          id,
          kind: 'shared_package',
          title: String(body.title ?? '').trim(),
          body: String(body.body ?? '').trim(),
          status: 'uploading',
          statusVersion: 0,
          statusToken,
          publicReason: null,
          autoRejectionReason: null,
          riskSummary: { summary: '等待系统审核', labels: [] },
          assets: [
            assetFrom(
              body.coverFile,
              'cover',
              `submissions/${id}/cover.${fileExtension(body.coverFile.fileName)}`
            ),
            assetFrom(
              body.packageFile,
              'package',
              `submissions/${id}/package.zip`
            )
          ],
          moderationResults: [],
          auditLogs: [],
          purgeAfter: null,
          preQuarantineStatus: null,
          publishedAt: null,
          rejectedAt: null,
          quarantinedAt: null,
          publicationBasis: null,
          riskAcknowledgement: null,
          createdAt,
          updatedAt: createdAt,
          likeCount: 0,
          downloadCount: 0
        };
        submissions.set(id, record);
        tokenIndex.set(statusToken, id);
        const origin = `http://${request.headers.host}`;
        return sendData(response, 200, {
          submissionId: id,
          statusToken,
          statusPath: '/submission-status/',
          status: 'uploading',
          coverUpload: uploadTarget(origin, id, 'cover'),
          packageUpload: uploadTarget(origin, id, 'package')
        });
      }

      const finalizeId = matchId(pathname, '/api/v1/submissions/', '/finalize');
      if (request.method === 'POST' && finalizeId) {
        await readJson(request);
        const record = requireSubmission(finalizeId);
        if (record.status === 'manual_review_pending') {
          return sendData(response, 200, { status: record.status });
        }
        if (record.status !== 'uploading') {
          return sendError(response, 404, 'NOT_FOUND');
        }
        if (!uploads.has(`${record.id}:cover`) || !uploads.has(`${record.id}:package`)) {
          return sendError(response, 409, 'UPLOAD_INCOMPLETE');
        }
        record.status = 'manual_review_pending';
        record.statusVersion += 1;
        record.updatedAt = now();
        record.riskSummary = {
          summary: '等待人工审核',
          labels: []
        };
        record.autoRejectionReason = null;
        record.moderationResults = [];
        return sendData(response, 200, { status: record.status });
      }

      if (request.method === 'POST' && pathname === '/api/v1/feedback') {
        const body = await readJson(request);
        if (!['feedback', 'suggestion'].includes(body.kind) || typeof body.content !== 'string') {
          return sendError(response, 400, 'INVALID_REQUEST');
        }
        const id = nextId();
        const statusToken = tokenFor(id);
        const createdAt = now();
        const record = {
          id,
          kind: body.kind,
          title: String(body.authorName ?? '').trim() || '匿名用户',
          body: body.content.trim(),
          status: 'manual_review_pending',
          statusVersion: 0,
          statusToken,
          publicReason: null,
          autoRejectionReason: null,
          riskSummary: { summary: '等待人工审核', labels: [] },
          assets: [],
          moderationResults: [],
          auditLogs: [],
          purgeAfter: null,
          preQuarantineStatus: null,
          publishedAt: null,
          rejectedAt: null,
          quarantinedAt: null,
          publicationBasis: null,
          riskAcknowledgement: null,
          createdAt,
          updatedAt: createdAt,
          likeCount: 0,
          downloadCount: 0
        };
        submissions.set(id, record);
        tokenIndex.set(statusToken, id);
        return sendData(response, 200, {
          submissionId: id,
          statusToken,
          statusPath: '/submission-status/',
          status: record.status
        });
      }

      if (request.method === 'POST' && pathname === '/api/v1/submission-status') {
        const body = await readJson(request);
        const id = tokenIndex.get(body.statusToken);
        if (!id) return sendError(response, 404, 'NOT_FOUND');
        const record = submissions.get(id);
        return sendData(response, 200, statusView(record));
      }

      if (request.method === 'GET' && pathname === '/api/v1/community') {
        return sendData(response, 200, pageOf(
          [...submissions.values()].filter(row => row.kind === 'shared_package' && row.status === 'published'),
          searchParams,
          record => publicCommunity(record, request.headers.host),
          'community',
          'publishedAt',
          true
        ));
      }

      const communityId = matchId(pathname, '/api/v1/community/', '');
      if (request.method === 'GET' && communityId) {
        const record = requirePublished(communityId, 'shared_package');
        return sendData(response, 200, publicCommunity(record, request.headers.host));
      }

      const communityLikeId = matchId(pathname, '/api/v1/community/', '/like');
      if (request.method === 'POST' && communityLikeId) {
        const body = publicLikeRequestSchema.safeParse(await readJson(request));
        if (!body.success) return sendError(response, 400, 'INVALID_REQUEST');
        return sendData(response, 200, setLike({
          record: requireSubmission(communityLikeId),
          endpointKind: 'community',
          allowedKinds: ['shared_package'],
          deviceHash: memoryDeviceHash(request),
          request: body.data,
          interactionOperations,
          interactionVotes,
          now: now()
        }));
      }

      const downloadId = matchId(pathname, '/api/v1/community/', '/download');
      if (request.method === 'POST' && downloadId) {
        const body = publicDownloadRequestSchema.safeParse(await readJson(request));
        if (!body.success) return sendError(response, 400, 'INVALID_REQUEST');
        const record = requirePublished(downloadId, 'shared_package');
        const url = `http://${request.headers.host}/__e2e/download/${record.id}`;
        recordDownload({
          record,
          deviceHash: memoryDeviceHash(request),
          request: body.data,
          interactionOperations,
          now: now()
        });
        return sendData(response, 200, {
          url,
          expiresAt: plusMinutes(now(), 5),
          publicationBasis: record.publicationBasis
        });
      }

      if (request.method === 'GET' && pathname === '/api/v1/feedback') {
        const kind = searchParams.get('kind');
        if (!['feedback', 'suggestion'].includes(kind)) return sendError(response, 400, 'INVALID_REQUEST');
        return sendData(response, 200, pageOf(
          [...submissions.values()].filter(row => row.kind === kind && row.status === 'published'),
          searchParams,
          publicFeedback,
          `feedback:${kind}`,
          'publishedAt',
          true
        ));
      }

      const feedbackLikeId = matchId(pathname, '/api/v1/feedback/', '/like');
      if (request.method === 'POST' && feedbackLikeId) {
        const body = publicLikeRequestSchema.safeParse(await readJson(request));
        if (!body.success) return sendError(response, 400, 'INVALID_REQUEST');
        return sendData(response, 200, setLike({
          record: requireSubmission(feedbackLikeId),
          endpointKind: 'feedback',
          allowedKinds: ['feedback', 'suggestion'],
          deviceHash: memoryDeviceHash(request),
          request: body.data,
          interactionOperations,
          interactionVotes,
          now: now()
        }));
      }

      if (pathname.startsWith('/api/v1/admin/')) {
        const authorized = requireAdmin(request, response);
        if (!authorized) return true;

        if (request.method === 'GET' && pathname === '/api/v1/admin/submissions') {
          const status = searchParams.get('status');
          if (status !== null && !SUBMISSION_STATUSES.has(status)) {
            return sendError(response, 400, 'INVALID_REQUEST');
          }
          return sendData(response, 200, pageOf(
            [...submissions.values()].filter(row => !status || row.status === status),
            searchParams,
            adminSummary,
            `admin:${status ?? 'all'}`,
            'createdAt'
          ));
        }

        const actionId = matchId(pathname, '/api/v1/admin/submissions/', '/actions');
        if (request.method === 'POST' && actionId) {
          const body = await readJson(request);
          return applyAdminAction(
            response,
            requireSubmission(actionId),
            body,
            now,
            adminIdempotency
          );
        }

        const detailId = matchId(pathname, '/api/v1/admin/submissions/', '');
        if (request.method === 'GET' && detailId) {
          return sendData(response, 200, adminDetail(requireSubmission(detailId), request));
        }
      }

      return sendError(response, 404, 'NOT_FOUND');
    } catch (error) {
      if (error instanceof MemoryApiError) return sendError(response, error.status, error.code);
      return sendError(response, 500, 'INTERNAL_ERROR');
    }
  }

  function handleUpload(request, response, pathname) {
    if (request.method !== 'PUT') return sendError(response, 405, 'METHOD_NOT_ALLOWED');
    const match = /^\/__e2e\/upload\/([^/]+)\/(cover|package)$/u.exec(pathname);
    if (!match || !submissions.has(match[1])) return sendError(response, 404, 'NOT_FOUND');
    let bytes = 0;
    const digest = createHash('sha256');
    request.on('data', chunk => {
      bytes += chunk.length;
      digest.update(chunk);
    });
    request.on('end', () => {
      uploads.set(`${match[1]}:${match[2]}`, {
        sizeBytes: bytes,
        sha256: digest.digest('hex')
      });
      const record = submissions.get(match[1]);
      const asset = record.assets.find(item => item.role === match[2]);
      if (asset) asset.actualBytes = bytes;
      response.writeHead(204);
      response.end();
    });
    return true;
  }

  function requireSubmission(id) {
    const record = submissions.get(id);
    if (!record) throw new MemoryApiError('NOT_FOUND', 404);
    return record;
  }

  function requirePublished(id, kinds) {
    const record = requireSubmission(id);
    const allowed = Array.isArray(kinds) ? kinds.includes(record.kind) : record.kind === kinds;
    if (
      !allowed
      || record.status !== 'published'
      || !hasValidPublicationShape(record)
    ) throw new MemoryApiError('NOT_FOUND', 404);
    return record;
  }

  return { handle, reset, advanceTime };
}

/** 固定合同种子只表达 HTTP 可观察事实，不暴露内部 Map 或数据库 port。 */
function seedContractFixtures(submissions, tokenIndex, uploads) {
  const createdAt = '2026-07-31T00:00:00.000Z';
  const updatedAt = '2026-07-31T00:01:00.000Z';
  const sharedRecord = (id, title, status, statusVersion, publicationBasis) => ({
    id,
    kind: 'shared_package',
    title,
    body: '合同资源说明',
    status,
    statusVersion,
    statusToken: id === CONTRACT_REFS.uploadedSubmissionId
      ? CONTRACT_REFS.uploadedStatusToken
      : null,
    publicReason: null,
    autoRejectionReason: null,
    riskSummary: { summary: '合同固定种子', labels: [] },
    assets: [
      assetFrom(
        { fileName: 'cover.webp', sizeBytes: 12, contentType: 'image/webp' },
        'cover',
        `submissions/${id}/cover.webp`
      ),
      assetFrom(
        { fileName: 'pet.zip', sizeBytes: 24, contentType: 'application/zip' },
        'package',
        `submissions/${id}/package.zip`
      )
    ].map(asset => ({ ...asset, actualBytes: asset.role === 'cover' ? 12 : 24 })),
    moderationResults: [],
    auditLogs: [],
    purgeAfter: null,
    preQuarantineStatus: null,
    publishedAt: status === 'published' ? createdAt : null,
    rejectedAt: null,
    quarantinedAt: null,
    publicationBasis,
    riskAcknowledgement: null,
    createdAt,
    updatedAt,
    likeCount: 0,
    downloadCount: 0
  });
  const uploaded = sharedRecord(
    CONTRACT_REFS.uploadedSubmissionId,
    '待审核合同投稿',
    'manual_review_pending',
    CONTRACT_REFS.adminSubmissionVersion,
    null
  );
  const historicalReviewing = sharedRecord(
    CONTRACT_REFS.adminSubmissionId,
    '历史系统审核投稿',
    'system_reviewing',
    CONTRACT_REFS.adminSubmissionVersion,
    null
  );
  const community = sharedRecord(
    CONTRACT_REFS.publicCommunityId,
    '公开合同资源',
    'published',
    3,
    'standard'
  );
  community.publishedAt = '2026-07-31T00:00:00.000002Z';
  community.assets.push(
    {
      ...assetFrom(
        { fileName: 'contract-private-derived.webp', sizeBytes: 8, contentType: 'image/webp' },
        'derived',
        `submissions/${community.id}/derived/contract-private-derived.webp`
      ),
      actualBytes: 8
    },
    {
      ...assetFrom(
        { fileName: 'contract-private-derived.json', sizeBytes: 9, contentType: 'application/json' },
        'derived',
        `submissions/${community.id}/derived/contract-private-derived.json`
      ),
      actualBytes: 9
    }
  );
  const equivalentOffsetCommunity = {
    ...sharedRecord(
      'contract-b',
      '等价 offset 合同资源',
      'published',
      1,
      'standard'
    ),
    publishedAt: '2026-07-31T08:00:00.000002+08:00'
  };
  const microsecondOlderCommunity = {
    ...sharedRecord(
      'contract-z',
      '亚毫秒较早合同资源',
      'published',
      1,
      'standard'
    ),
    publishedAt: '2026-07-31T00:00:00.000001Z'
  };
  const override = sharedRecord(
    CONTRACT_REFS.overrideSubmissionId,
    '待强制发布合同投稿',
    'manual_review_pending',
    CONTRACT_REFS.overrideSubmissionVersion,
    null
  );
  override.autoRejectionReason = '历史自动拒绝事实';
  const standardFeedback = {
    ...sharedRecord(
      CONTRACT_REFS.standardSubmissionId,
      '待普通批准合同反馈',
      'manual_review_pending',
      CONTRACT_REFS.standardSubmissionVersion,
      null
    ),
    kind: 'feedback',
    body: '合法反馈正文',
    assets: []
  };
  const invalidStandard = {
    ...sharedRecord(
      CONTRACT_REFS.invalidStandardSubmissionId,
      '   ',
      'manual_review_pending',
      CONTRACT_REFS.invalidStandardSubmissionVersion,
      null
    ),
    kind: 'feedback',
    body: '标题损坏的反馈',
    assets: []
  };
  const invalidForce = sharedRecord(
    CONTRACT_REFS.invalidForceSubmissionId,
    '资产损坏的共享包',
    'manual_review_pending',
    CONTRACT_REFS.invalidForceSubmissionVersion,
    null
  );
  invalidForce.assets = invalidForce.assets.filter(asset => asset.role === 'package');
  const damagedCommunity = sharedRecord(
    'contract-zz-damaged',
    '损坏公开记录',
    'published',
    1,
    'standard'
  );
  damagedCommunity.publishedAt = '2026-07-31T00:00:00.000001Z';
  damagedCommunity.assets.find(asset => asset.role === 'package').storageKey =
    'submissions/contract-zz-damaged/wrong.zip';
  const feedback = {
    ...sharedRecord(CONTRACT_REFS.publicFeedbackId, '合同用户', 'published', 1, 'standard'),
    kind: 'feedback',
    body: '公开合同反馈',
    assets: [],
    publicationBasis: 'standard'
  };
  const sameTimeFeedback = {
    ...feedback,
    id: 'Z-feedback',
    title: '同时间合同用户',
    body: '同时间公开合同反馈',
    publishedAt: createdAt
  };
  for (const record of [
    uploaded,
    historicalReviewing,
    community,
    equivalentOffsetCommunity,
    microsecondOlderCommunity,
    override,
    standardFeedback,
    invalidStandard,
    invalidForce,
    feedback,
    sameTimeFeedback,
    damagedCommunity
  ]) {
    submissions.set(record.id, record);
  }
  tokenIndex.set(CONTRACT_REFS.uploadedStatusToken, CONTRACT_REFS.uploadedSubmissionId);
  uploads.set(`${CONTRACT_REFS.uploadedSubmissionId}:cover`, {
    sizeBytes: 12,
    sha256: createHash('sha256').update('contract-cover').digest('hex')
  });
  uploads.set(`${CONTRACT_REFS.uploadedSubmissionId}:package`, {
    sizeBytes: 24,
    sha256: createHash('sha256').update('contract-package').digest('hex')
  });
}

class MemoryApiError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new MemoryApiError('INVALID_REQUEST', 400);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new MemoryApiError('INVALID_REQUEST', 400);
  }
}

function requireAdmin(request, response) {
  const forwardedToken = request.headers['x-ai-pet-admin-token'];
  if (!forwardedToken) {
    sendError(response, 401, 'UNAUTHORIZED');
    return false;
  }
  if (forwardedToken !== ADMIN_TOKEN && forwardedToken !== CONTRACT_ADMIN_TOKEN) {
    sendError(response, 403, 'FORBIDDEN');
    return false;
  }
  return true;
}

function assetFrom(value, role, storageKey) {
  return {
    role,
    storageKey,
    fileName: String(value.fileName ?? ''),
    declaredBytes: Number(value.sizeBytes ?? 0),
    contentType: String(value.contentType ?? ''),
    actualBytes: null
  };
}

function fileExtension(fileName) {
  const value = String(fileName ?? '').toLowerCase();
  return value.includes('.') ? value.slice(value.lastIndexOf('.') + 1) : '';
}

function uploadTarget(origin, id, role) {
  return {
    path: `${id}/${role}`,
    url: `${origin}/__e2e/upload/${id}/${role}`,
    expiresAt: plusMinutes(new Date().toISOString(), 5)
  };
}

function matchId(pathname, prefix, suffix) {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const encoded = pathname.slice(prefix.length, suffix ? -suffix.length : undefined);
  if (!encoded || encoded.includes('/')) return null;
  try { return decodeURIComponent(encoded); } catch { return null; }
}

function pageOf(
  records,
  searchParams,
  project,
  scope,
  sortField,
  isolateProjection = false
) {
  const limit = Number(searchParams.get('limit') ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new MemoryApiError('INVALID_REQUEST', 400);
  }
  const cursor = searchParams.get('cursor');
  const boundary = cursor === null ? null : decodeMemoryCursor(cursor, scope);
  const sorted = [...records]
    .filter(record => boundary === null
      || compareMemoryPosition(
        { sortTime: String(record[sortField]), id: record.id },
        boundary
      ) < 0)
    .sort((left, right) => compareMemoryPosition(
      { sortTime: String(right[sortField]), id: right.id },
      { sortTime: String(left[sortField]), id: left.id }
    ));
  const rows = sorted.slice(0, limit + 1);
  const items = [];
  for (const row of rows.slice(0, limit)) {
    try {
      items.push(project(row));
    } catch (error) {
      if (!isolateProjection) throw error;
    }
  }
  const last = rows[limit - 1];
  return {
    items,
    nextCursor: rows.length > limit
      ? encodeMemoryCursor(scope, last[sortField], last.id)
      : null
  };
}

function compareMemoryPosition(left, right) {
  const leftInstant = parseMemoryInstant(left.sortTime);
  const rightInstant = parseMemoryInstant(right.sortTime);
  if (leftInstant < rightInstant) return -1;
  if (leftInstant > rightInstant) return 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Memory 独立解析为 epoch 微秒，避免 JS 毫秒精度截断数据库键集。 */
function parseMemoryInstant(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) throw new Error('INVALID_DATETIME');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = match[8] === 'Z' ? 0 : Number(match[10]);
  const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11]);
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)
  ) throw new Error('INVALID_DATETIME');
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const shiftedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4)
    - Math.floor(yearOfEra / 100) + dayOfYear;
  const epochDays = BigInt(era * 146097 + dayOfEra - 719468);
  const offsetSign = match[8] === 'Z' || match[9] === '+' ? 1n : -1n;
  const offsetSeconds = offsetSign * BigInt(offsetHour * 60 + offsetMinute) * 60n;
  const localSeconds = ((epochDays * 24n + BigInt(hour)) * 60n + BigInt(minute)) * 60n
    + BigInt(second);
  const fraction = match[7] ?? '';
  let microseconds = BigInt((fraction + '000000').slice(0, 6));
  if (fraction.length > 6 && fraction.charCodeAt(6) >= 53) microseconds += 1n;
  return (localSeconds - offsetSeconds) * 1_000_000n + microseconds;
}

/** Memory 合同独立实现同一 opaque wire，不导入生产数据库或适配器代码。 */
function encodeMemoryCursor(scope, sortTime, id) {
  return `v1.${Buffer.from(JSON.stringify({ scope, sortTime, id }), 'utf8').toString('base64url')}`;
}

function decodeMemoryCursor(cursor, expectedScope) {
  try {
    if (
      !CURSOR_SCOPES.has(expectedScope)
      || cursor.length > 512
      || !/^v1\.[A-Za-z0-9_-]+$/u.test(cursor)
    ) throw new Error();
    const encoded = cursor.slice(3);
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error();
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      Object.keys(payload).sort().join(',') !== 'id,scope,sortTime'
      || payload.scope !== expectedScope
      || typeof payload.sortTime !== 'string'
      || typeof payload.id !== 'string'
      || payload.id.length < 1
      || payload.id.length > 128
    ) throw new Error();
    parseMemoryInstant(payload.sortTime);
    return { sortTime: payload.sortTime, id: payload.id };
  } catch {
    throw new MemoryApiError('INVALID_CURSOR', 400);
  }
}

const SUBMISSION_STATUSES = new Set([
  'uploading',
  'system_reviewing',
  'manual_review_pending',
  'published',
  'auto_rejected',
  'admin_rejected',
  'deleted_quarantined',
  'purged'
]);
const CURSOR_SCOPES = new Set([
  'community',
  'feedback:feedback',
  'feedback:suggestion',
  'admin:all',
  ...[...SUBMISSION_STATUSES].map(status => `admin:${status}`)
]);

function publicCommunity(record, host) {
  if (!hasValidPublicationShape(record)) throw new Error('INVALID_PUBLIC_SHAPE');
  const cover = record.assets.find(asset => asset.role === 'cover');
  const packageAsset = record.assets.find(asset => asset.role === 'package');
  return {
    id: record.id,
    name: record.title,
    description: record.body,
    cover: {
      url: `http://${host}/__e2e/cover/${record.id}`,
      expiresAt: plusMinutes(record.updatedAt, 5)
    },
    packageFileName: packageAsset.fileName,
    packageSizeBytes: packageAsset.actualBytes ?? packageAsset.declaredBytes,
    likeCount: record.likeCount,
    downloadCount: record.downloadCount,
    publishedAt: record.publishedAt,
    publicationBasis: record.publicationBasis
  };
}

function publicFeedback(record) {
  if (!hasValidPublicationShape(record)) throw new Error('INVALID_PUBLIC_SHAPE');
  return {
    id: record.id,
    kind: record.kind,
    authorName: record.title,
    content: record.body,
    likeCount: record.likeCount,
    createdAt: record.publishedAt
  };
}

function statusView(record) {
  return {
    submissionId: record.id,
    status: record.status,
    publicReason: record.publicReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function adminBase(record) {
  return {
    id: record.id,
    status: record.status,
    statusVersion: record.statusVersion,
    kind: record.kind,
    title: record.title,
    body: record.body,
    purgeAfter: record.purgeAfter,
    preQuarantineStatus: record.preQuarantineStatus,
    publishedAt: record.publishedAt,
    publicationBasis: record.publicationBasis,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function adminSummary(record) {
  return { ...adminBase(record), riskSummary: record.riskSummary, autoRejectionReason: record.autoRejectionReason };
}

/** 管理员动作只快照稳定裁决事实，避免把正文或风险证据固化进幂等结果。 */
function adminActionSnapshot(record) {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    statusVersion: record.statusVersion,
    publicationBasis: record.publicationBasis,
    publicReason: record.publicReason,
    publishedAt: record.publishedAt,
    rejectedAt: record.rejectedAt,
    quarantinedAt: record.quarantinedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

/** Memory 在发布写入与公开读取两侧复现数据库的同一结构语义。 */
function hasValidPublicationShape(record) {
  if (
    !['shared_package', 'feedback', 'suggestion'].includes(record.kind)
    || typeof record.title !== 'string'
    || record.title.trim().length === 0
    || typeof record.body !== 'string'
    || record.body.trim().length === 0
  ) return false;
  if (record.kind !== 'shared_package') return true;

  const covers = record.assets.filter(asset => asset.role === 'cover');
  const packages = record.assets.filter(asset => asset.role === 'package');
  if (covers.length !== 1 || packages.length !== 1) return false;
  const cover = covers[0];
  const packageAsset = packages[0];
  const coverMimeByKey = new Map([
    [`submissions/${record.id}/cover.png`, 'image/png'],
    [`submissions/${record.id}/cover.webp`, 'image/webp'],
    [`submissions/${record.id}/cover.jpg`, 'image/jpeg'],
    [`submissions/${record.id}/cover.jpeg`, 'image/jpeg']
  ]);
  return packageAsset.storageKey === `submissions/${record.id}/package.zip`
    && packageAsset.contentType === 'application/zip'
    && Number.isSafeInteger(packageAsset.actualBytes)
    && packageAsset.actualBytes > 0
    && coverMimeByKey.get(cover.storageKey) === cover.contentType
    && Number.isSafeInteger(cover.actualBytes)
    && cover.actualBytes > 0;
}

function adminDetail(record, request) {
  const cover = record.assets.find(asset => asset.role === 'cover');
  const packageAsset = record.assets.find(asset => (
    asset.role === 'package'
    && asset.contentType === 'application/zip'
    && Number.isSafeInteger(asset.actualBytes)
    && asset.actualBytes > 0
  ));
  return {
    ...adminSummary(record),
    coverPreview: cover ? {
      url: `http://${request.headers.host}/__e2e/cover/${record.id}`,
      expiresAt: plusMinutes(record.updatedAt, 5)
    } : null,
    packageDownload: packageAsset ? {
      url: `http://${request.headers.host}/__e2e/package/${record.id}`,
      expiresAt: plusMinutes(record.updatedAt, 5)
    } : null,
    assets: record.assets,
    moderationResults: record.moderationResults,
    auditLogs: record.auditLogs
  };
}

/** Memory 与生产共用 desired-state 语义，并按设备和投稿保存独立 vote。 */
function setLike({
  record,
  endpointKind,
  allowedKinds,
  deviceHash,
  request,
  interactionOperations,
  interactionVotes,
  now
}) {
  const existing = interactionOperations.get(request.operationId);
  if (existing && Date.parse(existing.expiresAt) <= Date.parse(now)) {
    interactionOperations.delete(request.operationId);
  } else if (existing) {
    if (
      existing.action !== 'like'
      || existing.submissionId !== record.id
      || existing.deviceHash !== deviceHash
      || existing.desiredLiked !== request.liked
      || existing.endpointKind !== endpointKind
    ) throw new MemoryApiError('IDEMPOTENCY_CONFLICT', 409);
    return structuredClone(existing.result);
  }

  if (record.status !== 'published' || !allowedKinds.includes(record.kind)) {
    throw new MemoryApiError('NOT_FOUND', 404);
  }

  const voteKey = `${deviceHash}:${record.id}`;
  const currentlyLiked = interactionVotes.has(voteKey);
  if (request.liked && !currentlyLiked) {
    interactionVotes.add(voteKey);
    record.likeCount += 1;
  } else if (!request.liked && currentlyLiked) {
    interactionVotes.delete(voteKey);
    record.likeCount = Math.max(0, record.likeCount - 1);
  }
  const result = { liked: request.liked, likeCount: record.likeCount };
  interactionOperations.set(request.operationId, {
    action: 'like',
    submissionId: record.id,
    deviceHash,
    desiredLiked: request.liked,
    endpointKind,
    result: structuredClone(result),
    expiresAt: plusDays(now, 1)
  });
  return result;
}

/** 下载只在地址成功形成后记录一次签发事实；失败重试复用首次计数快照。 */
function recordDownload({
  record,
  deviceHash,
  request,
  interactionOperations,
  now
}) {
  const existing = interactionOperations.get(request.operationId);
  if (existing && Date.parse(existing.expiresAt) <= Date.parse(now)) {
    interactionOperations.delete(request.operationId);
  } else if (existing) {
    if (
      existing.action !== 'download'
      || existing.submissionId !== record.id
      || existing.deviceHash !== deviceHash
    ) throw new MemoryApiError('IDEMPOTENCY_CONFLICT', 409);
    return structuredClone(existing.result);
  }

  record.downloadCount += 1;
  const result = { downloadCount: record.downloadCount };
  interactionOperations.set(request.operationId, {
    action: 'download',
    submissionId: record.id,
    deviceHash,
    result: structuredClone(result),
    expiresAt: plusDays(now, 1)
  });
  return result;
}

/** 内存驱动只保留不可逆设备摘要，不保存来源地址或 User-Agent。 */
function memoryDeviceHash(request) {
  const userAgent = Array.isArray(request.headers['user-agent'])
    ? request.headers['user-agent'].join(',')
    : String(request.headers['user-agent'] ?? '');
  return createHash('sha256')
    .update(`${request.socket.remoteAddress ?? ''}\n${userAgent}`)
    .digest('hex');
}

function applyAdminAction(response, record, body, now, adminIdempotency) {
  const parsed = adminActionSchema.safeParse(body);
  if (!parsed.success) return sendError(response, 400, 'INVALID_REQUEST');
  const actionRequest = parsed.data;
  const forcePublish = actionRequest.action === 'force_publish';
  const requestPayload = {
    submissionId: record.id,
    action: actionRequest.action,
    version: actionRequest.version,
    reason: actionRequest.reason,
    ...(forcePublish ? { riskAcknowledgement: actionRequest.riskAcknowledgement } : {})
  };
  const previous = adminIdempotency.get(actionRequest.idempotencyKey);
  if (previous) {
    if (JSON.stringify(previous.request) !== JSON.stringify(requestPayload)) {
      return sendError(response, 409, 'IDEMPOTENCY_CONFLICT');
    }
    return sendData(response, 200, {
      ...structuredClone(previous.result),
      replayed: true
    });
  }
  if (actionRequest.version !== record.statusVersion) return sendError(response, 409, 'VERSION_CONFLICT');
  const beforeStatus = record.status;
  const action = actionRequest.action;
  if (action === 'approve' && record.kind === 'shared_package'
    && !hasCurrentTechnicalEvidence(record, now())) {
    return sendError(response, 409, 'TECHNICAL_SCAN_REQUIRED');
  }
  if (action === 'force_publish' && hasCurrentTechnicalEvidence(record, now())) {
    return sendError(response, 409, 'INVALID_ADMIN_ACTION');
  }
  if (
    (action === 'approve' || action === 'force_publish')
    && !hasValidPublicationShape(record)
  ) {
    return sendError(response, 409, 'INVALID_ADMIN_ACTION');
  }

  if (action === 'approve' && record.status === 'manual_review_pending') {
    record.status = 'published';
    record.publishedAt = now();
    record.publicationBasis = 'standard';
    record.purgeAfter = null;
  } else if (
    action === 'force_publish'
    && record.kind === 'shared_package'
    && record.status === 'manual_review_pending'
  ) {
    record.status = 'published';
    record.publishedAt = now();
    record.publicationBasis = 'admin_override';
    record.riskAcknowledgement = actionRequest.riskAcknowledgement;
    record.purgeAfter = null;
  } else if (action === 'reject' && record.status === 'manual_review_pending') {
    record.status = 'admin_rejected';
    record.rejectedAt = now();
    record.purgeAfter = plusDays(now(), 3);
  } else if (
    action === 'move_to_manual'
    && (record.status === 'system_reviewing' || record.status === 'auto_rejected')
  ) {
    record.status = 'manual_review_pending';
    record.purgeAfter = null;
  } else if (action === 'delete' && record.status !== 'purged') {
    record.preQuarantineStatus = record.status;
    record.status = 'deleted_quarantined';
    record.quarantinedAt = now();
    record.publicationBasis = null;
    record.purgeAfter = plusDays(now(), 3);
  } else if (action === 'restore' && record.status === 'deleted_quarantined' && record.preQuarantineStatus) {
    record.status = record.kind === 'shared_package'
      ? 'manual_review_pending'
      : record.preQuarantineStatus;
    record.publicationBasis = record.kind !== 'shared_package'
      && record.preQuarantineStatus === 'published'
      ? 'standard'
      : null;
    record.quarantinedAt = null;
    record.preQuarantineStatus = null;
    record.purgeAfter = null;
  } else {
    return sendError(response, 409, 'INVALID_ADMIN_ACTION');
  }

  record.statusVersion += 1;
  record.updatedAt = now();
  record.publicReason = action === 'reject' ? actionRequest.reason : null;
  record.auditLogs.push({
    action,
    beforeStatus,
    afterStatus: record.status,
    reason: actionRequest.reason,
    createdAt: record.updatedAt
  });
  const result = { submission: adminActionSnapshot(record), replayed: false };
  adminIdempotency.set(actionRequest.idempotencyKey, {
    request: requestPayload,
    result: structuredClone(result)
  });
  return sendData(response, 200, result);
}

function hasCurrentTechnicalEvidence(record, currentTime) {
  const packageAsset = record.assets.find(asset => asset.role === 'package');
  return record.moderationResults.some(result => {
    const evidence = result.evidence ?? {};
    return result.kind === 'package_scan'
      && result.provider === 'isolated-scanner'
      && result.suggestion === 'Pass'
      && evidence.submissionId === record.id
      && evidence.packageStorageKey === packageAsset?.storageKey
      && evidence.packageSizeBytes === packageAsset?.actualBytes
      && evidence.archiveSizeBytes === packageAsset?.actualBytes
      && /^[a-f0-9]{64}$/u.test(evidence.archiveSha256 ?? '')
      && evidence.protocolVersion === '2026-08-15'
      && evidence.ruleVersion === 'character-package-2026-08-15'
      && evidence.submissionStatusVersion === record.statusVersion
      && Date.parse(evidence.expiresAt) - Date.parse(evidence.completedAt) === 86_400_000
      && Date.parse(evidence.expiresAt) > Date.parse(currentTime);
  });
}

function plusMinutes(value, minutes) {
  return new Date(new Date(value).getTime() + minutes * 60_000).toISOString();
}

function plusDays(value, days) {
  return new Date(new Date(value).getTime() + days * 86_400_000).toISOString();
}

function sendData(response, status, data) {
  return sendJson(response, status, { requestId: 'e2e-request', data });
}

function sendError(response, status, code) {
  return sendJson(response, status, { requestId: 'e2e-request', error: { code } });
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
  return true;
}

function sendBinary(response, contentType, body) {
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  response.end(body);
  return true;
}
