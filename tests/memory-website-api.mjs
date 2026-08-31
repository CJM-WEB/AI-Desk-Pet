import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const websiteRequire = createRequire(new URL('../apps/website/package.json', import.meta.url));
const moderationModuleUrl = pathToFileURL(
  websiteRequire.resolve('@myself/shared-types/moderation')
).href;
const { adminActionSchema } = await import(moderationModuleUrl);

const ADMIN_TOKEN = 'e2e-admin-session';
const CONTRACT_ADMIN_TOKEN = 'contract-admin-token';
const CONTRACT_REFS = Object.freeze({
  adminToken: CONTRACT_ADMIN_TOKEN,
  uploadedSubmissionId: 'contract-uploaded',
  uploadedStatusToken: 'c'.repeat(43),
  adminSubmissionId: 'contract-uploaded',
  adminSubmissionVersion: 1,
  overrideSubmissionId: 'contract-override',
  overrideSubmissionVersion: 2,
  publicCommunityId: 'contract-community',
  publicFeedbackId: 'contract-feedback'
});
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** 为单次 Playwright worker 创建完全隔离的确定性 API 状态。 */
export function createMemoryWebsiteApi({ runId }) {
  const submissions = new Map();
  const tokenIndex = new Map();
  const uploads = new Map();
  const adminIdempotency = new Map();
  let sequence = 0;

  const reset = () => {
    submissions.clear();
    tokenIndex.clear();
    uploads.clear();
    adminIdempotency.clear();
    sequence = 0;
    seedContractFixtures(submissions, tokenIndex, uploads);
    return structuredClone(CONTRACT_REFS);
  };

  const nextId = () => `e2e-${++sequence}`;
  const now = () => new Date(Date.UTC(2026, 6, 30, 12, 0, sequence)).toISOString();
  const tokenFor = id => createHash('sha256').update(`${runId}:${id}`).digest('base64url');

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const { pathname, searchParams } = url;
    if (request.method === 'POST' && pathname === '/__e2e/reset') {
      return sendData(response, 200, { reset: true, fixtures: reset() });
    }
    const moderationClaimId = matchId(pathname, '/__e2e/moderation/', '/claim');
    if (request.method === 'POST' && moderationClaimId) {
      const record = requireSubmission(moderationClaimId);
      const claimedVersion = Number(searchParams.get('claimedVersion'));
      if (
        record.status !== 'system_reviewing'
        || !Number.isInteger(claimedVersion)
        || claimedVersion !== record.statusVersion
      ) return sendError(response, 409, 'MODERATION_JOB_STALE');
      const rawLeaseMinutes = searchParams.get('leaseMinutes');
      const leaseMinutes = rawLeaseMinutes === null ? 10 : Number(rawLeaseMinutes);
      if (!Number.isFinite(leaseMinutes)) {
        return sendError(response, 400, 'INVALID_REQUEST');
      }
      record.moderationLeaseUntil = plusMinutes(now(), leaseMinutes);
      return sendData(response, 200, { claimedVersion });
    }
    const moderationId = matchId(pathname, '/__e2e/moderation/', '');
    if (request.method === 'POST' && moderationId) {
      const record = requireSubmission(moderationId);
      const rawClaimedVersion = searchParams.get('claimedVersion');
      const claimedVersion = Number(rawClaimedVersion);
      const lateResult = record.kind === 'shared_package'
        && record.status === 'published'
        && record.publicationBasis === 'admin_override'
        && rawClaimedVersion !== null
        && Number.isInteger(claimedVersion)
        && record.statusVersion === claimedVersion + 2
        && record.moderationLeaseUntil !== null
        && Date.parse(record.moderationLeaseUntil) > Date.parse(now());
      if (record.status !== 'system_reviewing' && !lateResult) {
        return sendError(response, 409, 'MODERATION_JOB_STALE');
      }
      completeModeration(
        record,
        now(),
        uploads.get(`${record.id}:package`),
        lateResult
      );
      return sendData(response, 200, { status: record.status });
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
            assetFrom(body.coverFile, 'cover', `${id}/cover`),
            assetFrom(body.packageFile, 'package', `${id}/package`)
          ],
          moderationResults: [],
          auditLogs: [],
          moderationLeaseUntil: null,
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
          downloadCount: 0,
          liked: false
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
        if (record.status === 'system_reviewing') {
          return sendData(response, 200, { status: 'system_reviewing' });
        }
        if (record.status !== 'uploading') {
          return sendError(response, 404, 'NOT_FOUND');
        }
        if (!uploads.has(`${record.id}:cover`) || !uploads.has(`${record.id}:package`)) {
          return sendError(response, 409, 'UPLOAD_INCOMPLETE');
        }
        record.status = 'system_reviewing';
        record.statusVersion += 1;
        record.updatedAt = now();
        record.riskSummary = {
          summary: '等待系统审核',
          labels: []
        };
        record.autoRejectionReason = null;
        record.moderationResults = [];
        return sendData(response, 200, { status: 'system_reviewing' });
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
          status: 'system_reviewing',
          statusVersion: 0,
          statusToken,
          publicReason: null,
          autoRejectionReason: null,
          riskSummary: { summary: '等待系统审核', labels: [] },
          assets: [],
          moderationResults: [],
          auditLogs: [],
          moderationLeaseUntil: null,
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
          downloadCount: 0,
          liked: false
        };
        submissions.set(id, record);
        tokenIndex.set(statusToken, id);
        return sendData(response, 200, {
          submissionId: id,
          statusToken,
          statusPath: '/submission-status/',
          status: 'system_reviewing'
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
          'publishedAt'
        ));
      }

      const communityId = matchId(pathname, '/api/v1/community/', '');
      if (request.method === 'GET' && communityId) {
        const record = requirePublished(communityId, 'shared_package');
        return sendData(response, 200, publicCommunity(record, request.headers.host));
      }

      const communityLikeId = matchId(pathname, '/api/v1/community/', '/like');
      if (request.method === 'POST' && communityLikeId) {
        await readJson(request);
        return sendData(response, 200, toggleLike(requirePublished(communityLikeId, 'shared_package')));
      }

      const downloadId = matchId(pathname, '/api/v1/community/', '/download');
      if (request.method === 'POST' && downloadId) {
        await readJson(request);
        const record = requirePublished(downloadId, 'shared_package');
        record.downloadCount += 1;
        return sendData(response, 200, {
          url: `http://${request.headers.host}/__e2e/download/${record.id}`,
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
          'publishedAt'
        ));
      }

      const feedbackLikeId = matchId(pathname, '/api/v1/feedback/', '/like');
      if (request.method === 'POST' && feedbackLikeId) {
        await readJson(request);
        return sendData(response, 200, toggleLike(requirePublished(feedbackLikeId, ['feedback', 'suggestion'])));
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
    if (!allowed || record.status !== 'published') throw new MemoryApiError('NOT_FOUND', 404);
    return record;
  }

  return { handle, reset };
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
      assetFrom({ fileName: 'cover.webp', sizeBytes: 12, contentType: 'image/webp' }, 'cover', `${id}/cover`),
      assetFrom({ fileName: 'pet.zip', sizeBytes: 24, contentType: 'application/zip' }, 'package', `${id}/package`)
    ].map(asset => ({ ...asset, actualBytes: asset.role === 'cover' ? 12 : 24 })),
    moderationResults: [],
    auditLogs: [],
    moderationLeaseUntil: null,
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
    downloadCount: 0,
    liked: false
  });
  const uploaded = sharedRecord(
    CONTRACT_REFS.uploadedSubmissionId,
    '待审核合同投稿',
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
  const offsetCommunity = {
    ...sharedRecord(
      'contract-a',
      '等价时区合同资源',
      'published',
      1,
      'standard'
    ),
    publishedAt: '2026-07-31T08:00:00.000+08:00'
  };
  const override = sharedRecord(
    CONTRACT_REFS.overrideSubmissionId,
    '待强制发布合同投稿',
    'manual_review_pending',
    CONTRACT_REFS.overrideSubmissionVersion,
    null
  );
  const feedback = {
    ...sharedRecord(CONTRACT_REFS.publicFeedbackId, '合同用户', 'published', 1, 'standard'),
    kind: 'feedback',
    body: '公开合同反馈',
    assets: [],
    publicationBasis: null
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
    community,
    offsetCommunity,
    override,
    feedback,
    sameTimeFeedback
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

function completeModeration(record, completedAt, archive, lateResult = false) {
  if (record.kind !== 'shared_package') {
    const blocked = record.body.includes('自动驳回');
    record.status = blocked ? 'auto_rejected' : 'manual_review_pending';
    record.statusVersion += 1;
    record.updatedAt = completedAt;
    record.riskSummary = {
      summary: blocked ? '系统规则自动驳回' : '系统审核完成',
      labels: blocked ? ['blocked'] : []
    };
    record.autoRejectionReason = blocked ? '测试夹具命中自动驳回规则' : null;
    record.purgeAfter = blocked ? plusDays(completedAt, 3) : null;
    record.moderationResults = [{
      kind: 'text_moderation',
      provider: 'e2e-fixture',
      suggestion: blocked ? 'Block' : 'Pass',
      label: blocked ? 'blocked' : 'safe',
      score: blocked ? 1 : 0,
      evidence: { fixture: blocked ? 'auto_reject' : 'safe' },
      createdAt: completedAt
    }];
    return;
  }
  const packageAsset = record.assets.find(asset => asset.role === 'package');
  const marker = `${record.title} ${record.body} ${packageAsset?.fileName ?? ''}`.toLowerCase();
  const technicalPass = !marker.includes('technical-fail')
    && !marker.includes('扫描失败');
  const blocked = marker.includes('auto-reject')
    || marker.includes('自动驳回')
    || !technicalPass;
  if (lateResult) {
    const technicalResult = packageScan(
      record,
      packageAsset,
      archive,
      technicalPass,
      completedAt
    );
    record.updatedAt = completedAt;
    record.riskSummary = {
      blocked: technicalResult.suggestion === 'Block',
      signalCount: 1,
      blockedLabels: technicalResult.suggestion === 'Block'
        ? [technicalResult.label]
        : []
    };
    record.moderationResults.push(technicalResult);
    record.moderationLeaseUntil = null;
    return;
  }
  record.status = blocked ? 'auto_rejected' : 'manual_review_pending';
  record.statusVersion += 1;
  record.updatedAt = completedAt;
  record.riskSummary = {
    summary: blocked ? '系统规则自动驳回' : '系统审核完成',
    labels: blocked ? ['blocked'] : ['reviewed']
  };
  record.autoRejectionReason = blocked ? '测试夹具命中自动驳回规则' : null;
  record.moderationResults = [packageScan(
    record,
    packageAsset,
    archive,
    technicalPass,
    completedAt
  )];
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

function uploadTarget(origin, id, role) {
  return {
    path: `${id}/${role}`,
    url: `${origin}/__e2e/upload/${id}/${role}`,
    expiresAt: plusMinutes(new Date().toISOString(), 5)
  };
}

function packageScan(record, packageAsset, archive, technicalPass, completedAt) {
  return {
    kind: 'package_scan',
    provider: 'isolated-scanner',
    suggestion: technicalPass ? 'Pass' : 'Block',
    label: technicalPass ? 'safe' : 'technical_failure',
    score: technicalPass ? 0 : 1,
    evidence: technicalPass ? {
      submissionId: record.id,
      packageStorageKey: packageAsset.storageKey,
      packageSizeBytes: packageAsset.actualBytes,
      archiveSizeBytes: archive.sizeBytes,
      archiveSha256: archive.sha256,
      protocolVersion: '2026-08-15',
      ruleVersion: 'character-package-2026-08-15',
      scanCode: 'CHARACTER_PACKAGE_SCAN_PASSED',
      completedAt,
      expiresAt: plusDays(completedAt, 1),
      submissionStatusVersion: record.statusVersion
    } : { scanCode: 'CHARACTER_PACKAGE_SCAN_FAILED' },
    createdAt: completedAt
  };
}

function matchId(pathname, prefix, suffix) {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const encoded = pathname.slice(prefix.length, suffix ? -suffix.length : undefined);
  if (!encoded || encoded.includes('/')) return null;
  try { return decodeURIComponent(encoded); } catch { return null; }
}

function pageOf(records, searchParams, project, scope, sortField) {
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
  const items = rows.slice(0, limit).map(project);
  const last = rows[limit - 1];
  return {
    items,
    nextCursor: rows.length > limit
      ? encodeMemoryCursor(scope, last[sortField], last.id)
      : null
  };
}

function compareMemoryPosition(left, right) {
  const instantDifference = parseMemoryInstant(left.sortTime) - parseMemoryInstant(right.sortTime);
  if (instantDifference !== 0) return instantDifference;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function parseMemoryInstant(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) throw new Error('INVALID_DATETIME');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = match[7] === 'Z' ? 0 : Number(match[9]);
  const offsetMinute = match[7] === 'Z' ? 0 : Number(match[10]);
  const instant = Date.parse(value);
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
    || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59
    || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)
    || !Number.isFinite(instant)
  ) throw new Error('INVALID_DATETIME');
  return instant;
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
      || !Number.isFinite(parseMemoryInstant(payload.sortTime))
      || typeof payload.id !== 'string'
      || payload.id.length < 1
      || payload.id.length > 128
    ) throw new Error();
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
    moderationLeaseUntil: record.moderationLeaseUntil,
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

/** 管理员动作只快照稳定裁决事实，避免把正文、租约或风险证据固化进幂等结果。 */
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

function adminDetail(record, request) {
  const cover = record.assets.find(asset => asset.role === 'cover');
  return {
    ...adminSummary(record),
    coverPreview: cover ? {
      url: `http://${request.headers.host}/__e2e/cover/${record.id}`,
      expiresAt: plusMinutes(record.updatedAt, 5)
    } : null,
    assets: record.assets,
    moderationResults: record.moderationResults,
    auditLogs: record.auditLogs
  };
}

function toggleLike(record) {
  record.liked = !record.liked;
  record.likeCount += record.liked ? 1 : -1;
  return { liked: record.liked, likeCount: record.likeCount };
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
      ? 'system_reviewing'
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
