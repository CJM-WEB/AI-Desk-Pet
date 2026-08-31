import { createApi, type ApiDependencies, type ApiHandler } from '../../apps/cloudbase-api/src/functions/api';
import { ApiError } from '../../apps/cloudbase-api/src/errors';
import {
  decodeContractResponse,
  runWebsiteApiContract,
  type ContractFixtureRefs,
  type ContractRequest,
  type WebsiteApiDriver,
} from './website-api-contract';

const CREATED_AT = '2026-07-31T00:00:00.000Z';
const UPDATED_AT = '2026-07-31T00:01:00.000Z';
const ADMIN_TOKEN = 'contract-admin-token';

const FIXTURE_REFS: ContractFixtureRefs = Object.freeze({
  adminToken: ADMIN_TOKEN,
  uploadedSubmissionId: 'contract-uploaded',
  uploadedStatusToken: 'c'.repeat(43),
  adminSubmissionId: 'contract-uploaded',
  adminSubmissionVersion: 1,
  overrideSubmissionId: 'contract-override',
  overrideSubmissionVersion: 2,
  publicCommunityId: 'contract-community',
  publicFeedbackId: 'contract-feedback',
});

interface ContractRecord {
  id: string;
  status: 'system_reviewing' | 'manual_review_pending' | 'published';
  statusVersion: number;
  title: string;
  publicationBasis: 'standard' | 'admin_override' | null;
  publishedAt: string | null;
}

type PublishedContractRecord = Omit<ContractRecord, 'status' | 'publicationBasis' | 'publishedAt'> & {
  status: 'published';
  publicationBasis: 'standard' | 'admin_override';
  publishedAt: string;
};

interface ProductionFixtureState {
  records: Map<string, ContractRecord>;
  idempotency: Map<string, { payload: string; result: unknown }>;
  interactionOperations: Map<string, {
    payload: string;
    result: { liked: boolean; likeCount: number };
    expiresAtMs: number;
  }>;
  interactionVotes: Set<string>;
  nowMs: number;
}

function createState(): ProductionFixtureState {
  return {
    records: new Map([
      [FIXTURE_REFS.uploadedSubmissionId, {
        id: FIXTURE_REFS.uploadedSubmissionId,
        status: 'system_reviewing',
        statusVersion: FIXTURE_REFS.adminSubmissionVersion,
        title: '待审核合同投稿',
        publicationBasis: null,
        publishedAt: null,
      }],
      [FIXTURE_REFS.overrideSubmissionId, {
        id: FIXTURE_REFS.overrideSubmissionId,
        status: 'manual_review_pending',
        statusVersion: FIXTURE_REFS.overrideSubmissionVersion,
        title: '待强制发布合同投稿',
        publicationBasis: null,
        publishedAt: null,
      }],
      [FIXTURE_REFS.publicCommunityId, {
        id: FIXTURE_REFS.publicCommunityId,
        status: 'published',
        statusVersion: 3,
        title: '公开合同资源',
        publicationBasis: 'standard',
        publishedAt: '2026-07-31T00:00:00.000002Z',
      }],
      ['contract-b', {
        id: 'contract-b',
        status: 'published',
        statusVersion: 1,
        title: '等价 offset 合同资源',
        publicationBasis: 'standard',
        publishedAt: '2026-07-31T08:00:00.000002+08:00',
      }],
      ['contract-z', {
        id: 'contract-z',
        status: 'published',
        statusVersion: 1,
        title: '亚毫秒较早合同资源',
        publicationBasis: 'standard',
        publishedAt: '2026-07-31T00:00:00.000001Z',
      }],
    ]),
    idempotency: new Map(),
    interactionOperations: new Map(),
    interactionVotes: new Set(),
    nowMs: Date.parse(CREATED_AT),
  };
}

function isPublished(record: ContractRecord): record is PublishedContractRecord {
  return record.status === 'published'
    && record.publicationBasis !== null
    && record.publishedAt !== null;
}

function publicCommunity(record: PublishedContractRecord) {
  return {
    id: record.id,
    name: record.title,
    description: '合同资源说明',
    cover: {
      url: `https://storage.example/${record.id}/cover.webp`,
      expiresAt: '2026-07-31T00:05:00.000Z',
    },
    packageFileName: 'pet.zip',
    packageSizeBytes: 24,
    likeCount: 0,
    downloadCount: 0,
    publishedAt: record.publishedAt,
    publicationBasis: record.publicationBasis,
  };
}

function adminSummary(record: ContractRecord) {
  return {
    id: record.id,
    status: record.status,
    statusVersion: record.statusVersion,
    kind: 'shared_package',
    title: record.title,
    body: '合同资源说明',
    moderationLeaseUntil: null,
    purgeAfter: null,
    preQuarantineStatus: null,
    publishedAt: record.publishedAt,
    publicationBasis: record.publicationBasis,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    riskSummary: {},
    autoRejectionReason: null,
  };
}

function adminDetail(record: ContractRecord) {
  return {
    ...adminSummary(record),
    coverPreview: {
      url: `https://storage.example/${record.id}/cover.webp`,
      expiresAt: '2026-07-31T00:05:00.000Z',
    },
    assets: [
      {
        role: 'cover',
        storageKey: `${record.id}/cover.webp`,
        fileName: 'cover.webp',
        declaredBytes: 12,
        contentType: 'image/webp',
        actualBytes: 12,
      },
      {
        role: 'package',
        storageKey: `${record.id}/pet.zip`,
        fileName: 'pet.zip',
        declaredBytes: 24,
        contentType: 'application/zip',
        actualBytes: 24,
      },
    ],
    moderationResults: [],
    auditLogs: [],
  };
}

function actionSnapshot(record: ContractRecord) {
  return {
    id: record.id,
    kind: 'shared_package',
    status: record.status,
    statusVersion: record.statusVersion,
    publicationBasis: record.publicationBasis,
    publicReason: null,
    publishedAt: record.publishedAt,
    rejectedAt: null,
    quarantinedAt: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

/** Production driver 只注入有状态测试依赖，验证正式 dispatch 而不冒充真实数据库。 */
function createDependencies(state: ProductionFixtureState): ApiDependencies {
  return {
    fingerprintSecret: 'contract-fingerprint-secret',
    abuseControl: { consume: async () => undefined },
    adminIdentity: {
      requireAdmin: async token => {
        if (token !== ADMIN_TOKEN) throw new ApiError('FORBIDDEN', 403);
        return { uid: 'contract-admin', email: 'admin@example.com' };
      },
    },
    submissions: {
      prepare: async () => ({
        submissionId: 'contract-prepared',
        statusToken: 'p'.repeat(43),
        statusPath: '/submission-status/',
        status: 'uploading',
        coverUpload: {
          path: 'contract-prepared/cover',
          url: 'https://storage.example/contract-prepared/cover',
          expiresAt: '2026-07-31T00:05:00.000Z',
        },
        packageUpload: {
          path: 'contract-prepared/package',
          url: 'https://storage.example/contract-prepared/package',
          expiresAt: '2026-07-31T00:05:00.000Z',
        },
      }),
      finalize: async ({ submissionId }) => {
        if (submissionId !== FIXTURE_REFS.uploadedSubmissionId) {
          throw new ApiError('NOT_FOUND', 404);
        }
        return { status: 'system_reviewing' };
      },
      getStatus: async token => {
        if (token !== FIXTURE_REFS.uploadedStatusToken) {
          throw new ApiError('NOT_FOUND', 404);
        }
        return {
          submissionId: FIXTURE_REFS.uploadedSubmissionId,
          status: 'system_reviewing',
          publicReason: null,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        };
      },
    },
    textSubmissions: {
      submit: async () => ({
        submissionId: 'contract-new-feedback',
        statusToken: 'f'.repeat(43),
        statusPath: '/submission-status/',
        status: 'system_reviewing',
      }),
    },
    publicContent: {
      listCommunity: async input => contractPage(
        [...state.records.values()].filter(isPublished),
        input,
        'community',
        record => record.publishedAt,
        publicCommunity,
      ),
      getCommunity: async id => {
        const record = state.records.get(id);
        if (!record || !isPublished(record)) throw new ApiError('NOT_FOUND', 404);
        return publicCommunity(record);
      },
      listFeedback: async (kind, input) => contractPage([{
          id: FIXTURE_REFS.publicFeedbackId,
          kind: 'feedback' as const,
          authorName: '合同用户',
          content: '公开合同反馈',
          likeCount: 0,
          createdAt: CREATED_AT,
        }, {
          id: 'Z-feedback',
          kind: 'feedback' as const,
          authorName: '同时间合同用户',
          content: '同时间公开合同反馈',
          likeCount: 0,
          createdAt: CREATED_AT,
        }].filter(item => item.kind === kind), input, `feedback:${kind}`,
        item => item.createdAt, item => item),
      setCommunityLike: async (id, fingerprint, desiredLiked, operationId) =>
        setContractLike(state, id, fingerprint, desiredLiked, operationId),
      setFeedbackLike: async (id, fingerprint, desiredLiked, operationId) =>
        setContractLike(state, id, fingerprint, desiredLiked, operationId),
      getDownload: async id => {
        const record = state.records.get(id);
        if (!record || !isPublished(record)) throw new ApiError('NOT_FOUND', 404);
        return {
          url: `https://storage.example/${id}/pet.zip`,
          expiresAt: '2026-07-31T00:05:00.000Z',
          publicationBasis: record.publicationBasis,
        };
      },
    },
    admin: {
      listQueue: async input => contractPage(
        [...state.records.values()].filter(record =>
          input.status === undefined || record.status === input.status
        ),
        input,
        `admin:${input.status ?? 'all'}`,
        () => CREATED_AT,
        adminSummary,
      ),
      getDetail: async id => {
        const record = state.records.get(id);
        if (!record) throw new ApiError('NOT_FOUND', 404);
        return adminDetail(record);
      },
      applyAction: async (_identity, id, action) => {
        const record = state.records.get(id);
        if (!record) throw new ApiError('NOT_FOUND', 404);
        const payload = JSON.stringify(action);
        const previous = state.idempotency.get(action.idempotencyKey);
        if (previous) {
          if (previous.payload !== payload) throw new ApiError('IDEMPOTENCY_CONFLICT', 409);
          return { ...(structuredClone(previous.result) as object), replayed: true };
        }
        if (record.statusVersion !== action.version) throw new ApiError('VERSION_CONFLICT', 409);
        if (action.action === 'move_to_manual' && record.status === 'system_reviewing') {
          record.status = 'manual_review_pending';
        } else if (action.action === 'force_publish' && record.status === 'manual_review_pending') {
          record.status = 'published';
          record.publicationBasis = 'admin_override';
          record.publishedAt = UPDATED_AT;
        } else {
          throw new ApiError('INVALID_ADMIN_ACTION', 409);
        }
        record.statusVersion += 1;
        const result = { submission: actionSnapshot(record), replayed: false as const };
        state.idempotency.set(action.idempotencyKey, { payload, result: structuredClone(result) });
        return result;
      },
    },
  };
}

/** 生产合同替身独立实现 desired-state 和操作号冲突，不借用数据库适配器。 */
function setContractLike(
  state: ProductionFixtureState,
  submissionId: string,
  fingerprint: string,
  desiredLiked: boolean,
  operationId: string,
): { liked: boolean; likeCount: number } {
  const canonicalOperationId = operationId.toLowerCase();
  const payload = JSON.stringify({
    action: 'like',
    submissionId,
    fingerprint,
    desiredLiked,
  });
  const previous = state.interactionOperations.get(canonicalOperationId);
  if (previous && previous.expiresAtMs <= state.nowMs) {
    state.interactionOperations.delete(canonicalOperationId);
  } else if (previous) {
    if (previous.payload !== payload) throw new ApiError('IDEMPOTENCY_CONFLICT', 409);
    return structuredClone(previous.result);
  }
  const voteKey = `${fingerprint}:${submissionId}`;
  if (desiredLiked) state.interactionVotes.add(voteKey);
  else state.interactionVotes.delete(voteKey);
  const likeCount = [...state.interactionVotes]
    .filter(key => key.endsWith(`:${submissionId}`)).length;
  const result = { liked: desiredLiked, likeCount };
  state.interactionOperations.set(canonicalOperationId, {
    payload,
    result: structuredClone(result),
    expiresAtMs: state.nowMs + 24 * 60 * 60 * 1000,
  });
  return result;
}

/** 合同 driver 只模拟 HTTP 可观察键集语义，不导入数据库实现。 */
function contractPage<T extends { id: string }, R>(
  records: T[],
  input: { limit: number; cursor?: string | null },
  scope: string,
  sortTime: (record: T) => string,
  project: (record: T) => R,
): { items: R[]; nextCursor: string | null } {
  const boundary = input.cursor ? decodeContractCursor(input.cursor, scope) : null;
  const rows = [...records]
    .filter(record => boundary === null
      || compareContractPosition(
        { sortTime: sortTime(record), id: record.id },
        boundary,
      ) < 0)
    .sort((left, right) => compareContractPosition(
      { sortTime: sortTime(right), id: right.id },
      { sortTime: sortTime(left), id: left.id },
    ))
    .slice(0, input.limit + 1);
  const last = rows[input.limit - 1];
  return {
    items: rows.slice(0, input.limit).map(project),
    nextCursor: rows.length > input.limit && last
      ? encodeContractCursor(scope, sortTime(last), last.id)
      : null,
  };
}

function compareContractPosition(
  left: { sortTime: string; id: string },
  right: { sortTime: string; id: string },
): number {
  const leftInstant = parseContractInstant(left.sortTime);
  const rightInstant = parseContractInstant(right.sortTime);
  if (leftInstant < rightInstant) return -1;
  if (leftInstant > rightInstant) return 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** 合同替身独立解析为 epoch 微秒，不借用生产数据库实现或浮点时间戳。 */
function parseContractInstant(value: string): bigint {
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
    year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]!
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

function encodeContractCursor(scope: string, sortTime: string, id: string): string {
  return `v1.${Buffer.from(JSON.stringify({ scope, sortTime, id }), 'utf8').toString('base64url')}`;
}

function decodeContractCursor(cursor: string, expectedScope: string): {
  sortTime: string;
  id: string;
} {
  try {
    if (cursor.length > 512 || !/^v1\.[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error();
    const encoded = cursor.slice(3);
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error();
    const payload = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as Record<string, unknown>;
    if (
      payload.scope !== expectedScope
      || typeof payload.sortTime !== 'string'
      || typeof payload.id !== 'string'
      || payload.id.length < 1
      || payload.id.length > 128
    ) throw new Error();
    parseContractInstant(payload.sortTime);
    return { sortTime: payload.sortTime, id: payload.id };
  } catch {
    throw new ApiError('INVALID_CURSOR', 400);
  }
}

function eventFrom(input: ContractRequest) {
  const url = new URL(input.path, 'https://contract.local');
  return {
    httpMethod: input.method,
    path: url.pathname,
    headers: { 'user-agent': 'website-contract', ...(input.headers ?? {}) },
    queryStringParameters: Object.fromEntries(url.searchParams),
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  };
}

async function createProductionDriver(): Promise<WebsiteApiDriver> {
  let handler: ApiHandler;
  let state: ProductionFixtureState;
  const reset = async () => {
    state = createState();
    handler = createApi(createDependencies(state));
    return structuredClone(FIXTURE_REFS);
  };
  await reset();
  return {
    reset,
    advanceTime: async milliseconds => {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
        throw new Error('INVALID_CLOCK_ADVANCE');
      }
      state.nowMs += milliseconds;
    },
    close: async () => undefined,
    request: async input => {
      const response = await handler(eventFrom(input), {
        requestId: 'contract-production-request',
        sourceIp: '203.0.113.20',
      });
      return decodeContractResponse(response.statusCode, JSON.parse(response.body));
    },
  };
}

runWebsiteApiContract('Production createApi Adapter', createProductionDriver);
