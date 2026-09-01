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
  publicFeedbackId: 'contract-feedback',
});

interface ContractRecord {
  id: string;
  status: 'system_reviewing' | 'manual_review_pending' | 'published';
  statusVersion: number;
  kind: 'shared_package' | 'feedback' | 'suggestion';
  title: string;
  body: string;
  assets: ContractAsset[];
  auditLogs: Array<{
    action: 'approve' | 'force_publish' | 'move_to_manual'
      | 'reject' | 'delete' | 'restore';
    beforeStatus: string;
    afterStatus: string;
    reason: string;
    createdAt: string;
  }>;
  publicationBasis: 'standard' | 'admin_override' | null;
  publishedAt: string | null;
}

interface ContractAsset {
  role: 'cover' | 'package' | 'derived';
  storageKey: string;
  fileName: string;
  declaredBytes: number;
  actualBytes: number | null;
  contentType: string;
}

type ContractInteractionResult =
  | { liked: boolean; likeCount: number }
  | { downloadCount: number };

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
    result: ContractInteractionResult;
    expiresAtMs: number;
  }>;
  interactionVotes: Set<string>;
  downloadCounts: Map<string, number>;
  nowMs: number;
}

function sharedContractRecord(
  id: string,
  status: ContractRecord['status'],
  statusVersion: number,
  publicationBasis: ContractRecord['publicationBasis'],
  publishedAt: string | null,
): ContractRecord {
  return {
    id,
    status,
    statusVersion,
    kind: 'shared_package',
    title: id,
    body: '合同资源说明',
    assets: [{
      role: 'cover',
      storageKey: `submissions/${id}/cover.webp`,
      fileName: 'cover.webp',
      declaredBytes: 12,
      actualBytes: 12,
      contentType: 'image/webp',
    }, {
      role: 'package',
      storageKey: `submissions/${id}/package.zip`,
      fileName: 'pet.zip',
      declaredBytes: 24,
      actualBytes: 24,
      contentType: 'application/zip',
    }],
    auditLogs: [],
    publicationBasis,
    publishedAt,
  };
}

function createState(): ProductionFixtureState {
  const uploaded = sharedContractRecord(
    FIXTURE_REFS.uploadedSubmissionId,
    'manual_review_pending',
    FIXTURE_REFS.adminSubmissionVersion,
    null,
    null,
  );
  uploaded.title = '待审核合同投稿';
  const historicalReviewing = sharedContractRecord(
    FIXTURE_REFS.adminSubmissionId,
    'system_reviewing',
    FIXTURE_REFS.adminSubmissionVersion,
    null,
    null,
  );
  historicalReviewing.title = '历史系统审核投稿';
  const override = sharedContractRecord(
    FIXTURE_REFS.overrideSubmissionId,
    'manual_review_pending',
    FIXTURE_REFS.overrideSubmissionVersion,
    null,
    null,
  );
  override.title = '待强制发布合同投稿';
  const community = sharedContractRecord(
    FIXTURE_REFS.publicCommunityId,
    'published',
    3,
    'standard',
    '2026-07-31T00:00:00.000002Z',
  );
  community.title = '公开合同资源';
  community.assets.push({
    role: 'derived',
    storageKey: `submissions/${community.id}/derived/contract-private-derived.webp`,
    fileName: 'contract-private-derived.webp',
    declaredBytes: 8,
    actualBytes: 8,
    contentType: 'image/webp',
  }, {
    role: 'derived',
    storageKey: `submissions/${community.id}/derived/contract-private-derived.json`,
    fileName: 'contract-private-derived.json',
    declaredBytes: 9,
    actualBytes: 9,
    contentType: 'application/json',
  });
  const equivalentOffset = sharedContractRecord(
    'contract-b', 'published', 1, 'standard',
    '2026-07-31T08:00:00.000002+08:00',
  );
  equivalentOffset.title = '等价 offset 合同资源';
  const microsecondOlder = sharedContractRecord(
    'contract-z', 'published', 1, 'standard',
    '2026-07-31T00:00:00.000001Z',
  );
  microsecondOlder.title = '亚毫秒较早合同资源';
  const damagedCommunity = sharedContractRecord(
    'contract-zz-damaged', 'published', 1, 'standard',
    '2026-07-31T00:00:00.000001Z',
  );
  damagedCommunity.assets[1]!.storageKey =
    'submissions/contract-zz-damaged/wrong.zip';
  const standardFeedback: ContractRecord = {
    ...sharedContractRecord(
      FIXTURE_REFS.standardSubmissionId,
      'manual_review_pending',
      FIXTURE_REFS.standardSubmissionVersion,
      null,
      null,
    ),
    kind: 'feedback',
    title: '待普通批准合同反馈',
    body: '合法反馈正文',
    assets: [],
  };
  const invalidStandard: ContractRecord = {
    ...sharedContractRecord(
      FIXTURE_REFS.invalidStandardSubmissionId,
      'manual_review_pending',
      FIXTURE_REFS.invalidStandardSubmissionVersion,
      null,
      null,
    ),
    kind: 'feedback',
    title: '   ',
    body: '标题损坏的反馈',
    assets: [],
  };
  const invalidForce = sharedContractRecord(
    FIXTURE_REFS.invalidForceSubmissionId,
    'manual_review_pending',
    FIXTURE_REFS.invalidForceSubmissionVersion,
    null,
    null,
  );
  invalidForce.assets = invalidForce.assets.filter(asset => asset.role === 'package');

  return {
    records: new Map([
      [uploaded.id, uploaded],
      [historicalReviewing.id, historicalReviewing],
      [override.id, override],
      [community.id, community],
      [equivalentOffset.id, equivalentOffset],
      [microsecondOlder.id, microsecondOlder],
      [damagedCommunity.id, damagedCommunity],
      [standardFeedback.id, standardFeedback],
      [invalidStandard.id, invalidStandard],
      [invalidForce.id, invalidForce],
    ]),
    idempotency: new Map(),
    interactionOperations: new Map(),
    interactionVotes: new Set(),
    downloadCounts: new Map(),
    nowMs: Date.parse(CREATED_AT),
  };
}

function isPublished(record: ContractRecord): record is PublishedContractRecord {
  return record.status === 'published'
    && record.publicationBasis !== null
    && record.publishedAt !== null;
}

function publicCommunity(record: PublishedContractRecord, downloadCount: number) {
  if (!hasValidContractPublicationShape(record)) throw new Error('INVALID_PUBLIC_SHAPE');
  const cover = record.assets.find(asset => asset.role === 'cover')!;
  const packageAsset = record.assets.find(asset => asset.role === 'package')!;
  return {
    id: record.id,
    name: record.title,
    description: record.body,
    cover: {
      url: `https://storage.example/${cover.storageKey}`,
      expiresAt: '2026-07-31T00:05:00.000Z',
    },
    packageFileName: packageAsset.fileName,
    packageSizeBytes: packageAsset.actualBytes!,
    likeCount: 0,
    downloadCount,
    publishedAt: record.publishedAt,
    publicationBasis: record.publicationBasis,
  };
}

/** Production 合同替身在发布与公开投影两侧复现同一结构规则。 */
function hasValidContractPublicationShape(record: ContractRecord): boolean {
  if (record.title.trim().length === 0 || record.body.trim().length === 0) return false;
  if (record.kind !== 'shared_package') return true;

  const covers = record.assets.filter(asset => asset.role === 'cover');
  const packages = record.assets.filter(asset => asset.role === 'package');
  if (covers.length !== 1 || packages.length !== 1) return false;
  const cover = covers[0]!;
  const packageAsset = packages[0]!;
  const coverMimeByKey = new Map([
    [`submissions/${record.id}/cover.png`, 'image/png'],
    [`submissions/${record.id}/cover.webp`, 'image/webp'],
    [`submissions/${record.id}/cover.jpg`, 'image/jpeg'],
    [`submissions/${record.id}/cover.jpeg`, 'image/jpeg'],
  ]);
  return packageAsset.storageKey === `submissions/${record.id}/package.zip`
    && packageAsset.contentType === 'application/zip'
    && Number.isSafeInteger(packageAsset.actualBytes)
    && packageAsset.actualBytes! > 0
    && coverMimeByKey.get(cover.storageKey) === cover.contentType
    && Number.isSafeInteger(cover.actualBytes)
    && cover.actualBytes! > 0;
}

function adminSummary(record: ContractRecord) {
  return {
    id: record.id,
    status: record.status,
    statusVersion: record.statusVersion,
    kind: record.kind,
    title: record.title,
    body: record.body,
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
  const cover = record.assets.find(asset => asset.role === 'cover');
  const packageAsset = record.assets.find(asset => (
    isCurrentPackageAsset(asset)
  ));
  return {
    ...adminSummary(record),
    coverPreview: cover ? {
      url: `https://storage.example/${record.id}/cover.webp`,
      expiresAt: '2026-07-31T00:05:00.000Z',
    } : null,
    packageDownload: packageAsset ? {
      url: `https://storage.example/${packageAsset.storageKey}`,
      expiresAt: '2026-07-31T00:05:00.000Z',
    } : null,
    assets: record.assets,
    moderationResults: [],
    auditLogs: record.auditLogs,
  };
}

/** 合同替身只为当前有效 ZIP 投影管理员短期下载地址。 */
function isCurrentPackageAsset(asset: ContractAsset): boolean {
  const actualBytes = asset.actualBytes;
  return asset.role === 'package'
    && asset.contentType === 'application/zip'
    && actualBytes !== null
    && Number.isSafeInteger(actualBytes)
    && actualBytes > 0;
}

function actionSnapshot(record: ContractRecord) {
  return {
    id: record.id,
    kind: record.kind,
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
        return { status: 'manual_review_pending' };
      },
      getStatus: async token => {
        if (token !== FIXTURE_REFS.uploadedStatusToken) {
          throw new ApiError('NOT_FOUND', 404);
        }
        return {
          submissionId: FIXTURE_REFS.uploadedSubmissionId,
          status: 'manual_review_pending',
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
        status: 'manual_review_pending',
      }),
    },
    publicContent: {
      listCommunity: async input => contractPage(
        [...state.records.values()].filter((record): record is PublishedContractRecord =>
          isPublished(record) && record.kind === 'shared_package'
        ),
        input,
        'community',
        record => record.publishedAt,
        record => publicCommunity(record, state.downloadCounts.get(record.id) ?? 0),
        true,
      ),
      getCommunity: async id => {
        const record = state.records.get(id);
        if (
          !record || !isPublished(record) || record.kind !== 'shared_package'
          || !hasValidContractPublicationShape(record)
        ) throw new ApiError('NOT_FOUND', 404);
        return publicCommunity(record, state.downloadCounts.get(record.id) ?? 0);
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
        }, ...[...state.records.values()]
          .filter((record): record is PublishedContractRecord =>
            isPublished(record) && record.kind === kind
          )
          .map(record => ({
            id: record.id,
            kind: record.kind as 'feedback' | 'suggestion',
            authorName: record.title,
            content: record.body,
            likeCount: 0,
            createdAt: record.publishedAt,
          }))].filter(item => item.kind === kind), input, `feedback:${kind}`,
        item => item.createdAt,
        item => {
          const record = state.records.get(item.id);
          if (record && !hasValidContractPublicationShape(record)) {
            throw new Error('INVALID_PUBLIC_SHAPE');
          }
          return item;
        },
        true),
      setCommunityLike: async (id, fingerprint, desiredLiked, operationId) =>
        setContractLike(
          state, id, fingerprint, desiredLiked, operationId, 'community'
        ),
      setFeedbackLike: async (id, fingerprint, desiredLiked, operationId) =>
        setContractLike(
          state, id, fingerprint, desiredLiked, operationId, 'feedback'
        ),
      getDownload: async (id, fingerprint, operationId) => {
        const record = state.records.get(id);
        if (
          !record || !isPublished(record) || record.kind !== 'shared_package'
          || !hasValidContractPublicationShape(record)
        ) throw new ApiError('NOT_FOUND', 404);
        recordContractDownload(state, id, fingerprint, operationId);
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
        if (
          (action.action === 'approve' || action.action === 'force_publish')
          && !hasValidContractPublicationShape(record)
        ) throw new ApiError('INVALID_ADMIN_ACTION', 409);
        // Production 合同夹具没有技术通过证据，共享包普通批准必须与真实服务同样失败关闭。
        if (action.action === 'approve' && record.kind === 'shared_package') {
          throw new ApiError('TECHNICAL_SCAN_REQUIRED', 409);
        }
        const beforeStatus = record.status;
        if (action.action === 'move_to_manual' && record.status === 'system_reviewing') {
          record.status = 'manual_review_pending';
        } else if (action.action === 'approve' && record.status === 'manual_review_pending') {
          record.status = 'published';
          record.publicationBasis = 'standard';
          record.publishedAt = UPDATED_AT;
        } else if (action.action === 'force_publish' && record.status === 'manual_review_pending') {
          if (record.kind !== 'shared_package') throw new ApiError('INVALID_ADMIN_ACTION', 409);
          record.status = 'published';
          record.publicationBasis = 'admin_override';
          record.publishedAt = UPDATED_AT;
        } else {
          throw new ApiError('INVALID_ADMIN_ACTION', 409);
        }
        record.statusVersion += 1;
        record.auditLogs.push({
          action: action.action,
          beforeStatus,
          afterStatus: record.status,
          reason: action.reason,
          createdAt: UPDATED_AT,
        });
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
  endpointKind: 'community' | 'feedback',
): { liked: boolean; likeCount: number } {
  const canonicalOperationId = operationId.toLowerCase();
  const payload = JSON.stringify({
    action: 'like',
    submissionId,
    fingerprint,
    desiredLiked,
    endpointKind,
  });
  const previous = state.interactionOperations.get(canonicalOperationId);
  if (previous && previous.expiresAtMs <= state.nowMs) {
    state.interactionOperations.delete(canonicalOperationId);
  } else if (previous) {
    if (previous.payload !== payload) throw new ApiError('IDEMPOTENCY_CONFLICT', 409);
    if (!('liked' in previous.result)) throw new ApiError('IDEMPOTENCY_CONFLICT', 409);
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

/** 下载替身复用互动 operation 账本，回放首次计数且不重复增加成功签发次数。 */
function recordContractDownload(
  state: ProductionFixtureState,
  submissionId: string,
  fingerprint: string,
  operationId: string,
): { downloadCount: number } {
  const canonicalOperationId = operationId.toLowerCase();
  const payload = JSON.stringify({ action: 'download', submissionId, fingerprint });
  const previous = state.interactionOperations.get(canonicalOperationId);
  if (previous && previous.expiresAtMs <= state.nowMs) {
    state.interactionOperations.delete(canonicalOperationId);
  } else if (previous) {
    if (previous.payload !== payload) throw new ApiError('IDEMPOTENCY_CONFLICT', 409);
    if (!('downloadCount' in previous.result)) {
      throw new ApiError('IDEMPOTENCY_CONFLICT', 409);
    }
    return structuredClone(previous.result);
  }
  const result = {
    downloadCount: (state.downloadCounts.get(submissionId) ?? 0) + 1,
  };
  state.downloadCounts.set(submissionId, result.downloadCount);
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
  isolateProjection = false,
): { items: R[]; nextCursor: string | null } {
  const boundary = input.cursor === undefined || input.cursor === null
    ? null
    : decodeContractCursor(input.cursor, scope);
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
  const items: R[] = [];
  for (const row of rows.slice(0, input.limit)) {
    try {
      items.push(project(row));
    } catch (error) {
      if (!isolateProjection) throw error;
    }
  }
  return {
    items,
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
      Object.keys(payload).sort().join(',') !== 'id,scope,sortTime'
      || payload.scope !== expectedScope
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
