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
  communityLiked: boolean;
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
        publishedAt: CREATED_AT,
      }],
    ]),
    idempotency: new Map(),
    communityLiked: false,
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
      listCommunity: async () => ({
        items: [...state.records.values()]
          .filter(isPublished)
          .map(publicCommunity),
        nextCursor: null,
      }),
      getCommunity: async id => {
        const record = state.records.get(id);
        if (!record || !isPublished(record)) throw new ApiError('NOT_FOUND', 404);
        return publicCommunity(record);
      },
      listFeedback: async () => ({
        items: [{
          id: FIXTURE_REFS.publicFeedbackId,
          kind: 'feedback',
          authorName: '合同用户',
          content: '公开合同反馈',
          likeCount: 0,
          createdAt: CREATED_AT,
        }],
        nextCursor: null,
      }),
      toggleCommunityLike: async () => {
        state.communityLiked = !state.communityLiked;
        return { liked: state.communityLiked, likeCount: state.communityLiked ? 1 : 0 };
      },
      toggleFeedbackLike: async () => ({ liked: true, likeCount: 1 }),
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
      listQueue: async () => ({
        items: [...state.records.values()].map(adminSummary),
        nextCursor: null,
      }),
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
  const reset = async () => {
    handler = createApi(createDependencies(createState()));
    return structuredClone(FIXTURE_REFS);
  };
  await reset();
  return {
    reset,
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
