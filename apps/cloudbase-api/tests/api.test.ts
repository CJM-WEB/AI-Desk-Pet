import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createApi,
  createProductionHandler,
  main as productionMain
} from '../src/functions/api.js';
import { AbuseControl } from '../src/services/abuse-control.js';
import {
  createFakeRuntime,
  stubCloudConfig
} from './support/cloudbase-production.js';

const productionSdk = vi.hoisted(() => ({
  createRuntime: vi.fn()
}));

vi.mock('../src/adapters/cloudbase-runtime.js', () => ({
  createCloudBaseServerRuntime: productionSdk.createRuntime
}));

const sourceIp = '203.0.113.8';
const fingerprintSecret = '仅用于测试的指纹配置值';

function createDependencies() {
  return {
    submissions: {
      prepare: vi.fn(async () => ({
        submissionId: 'submission-1',
        statusToken: 'a'.repeat(43),
        statusPath: '/submission-status/',
        status: 'uploading',
        coverUpload: {
          path: 'submissions/submission-1/cover.webp',
          url: 'https://storage.example/cover',
          expiresAt: '2026-07-31T01:00:00.000Z'
        },
        packageUpload: {
          path: 'submissions/submission-1/package.zip',
          url: 'https://storage.example/package',
          expiresAt: '2026-07-31T01:00:00.000Z'
        }
      })),
      finalize: vi.fn(async () => ({ status: 'system_reviewing' })),
      getStatus: vi.fn(async () => ({
        submissionId: 'submission-1',
        status: 'system_reviewing',
        publicReason: null,
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:01:00.000Z',
        moderationEvidence: null as string | null
      }))
    },
    textSubmissions: {
      submit: vi.fn(async () => ({
        submissionId: 'feedback-1',
        statusToken: 'b'.repeat(43),
        statusPath: '/submission-status/',
        status: 'system_reviewing'
      }))
    },
    publicContent: {
      listCommunity: vi.fn(async () => ({
        items: [{
          id: 'community-1',
          name: '公开名称',
          description: '公开说明',
          cover: {
            url: 'https://storage.example/cover',
            expiresAt: '2026-07-31T00:05:00.000Z'
          },
          packageFileName: 'pet.zip',
          packageSizeBytes: 1024,
          likeCount: 2,
          downloadCount: 3,
          publishedAt: '2026-07-31T00:00:00.000Z',
          storageKey: '不得公开'
        }],
        nextCursor: null
      })),
      getCommunity: vi.fn(async () => ({
        id: 'community-1',
        name: '公开名称',
        description: '公开说明',
        cover: {
          url: 'https://storage.example/cover',
          expiresAt: '2026-07-31T00:05:00.000Z'
        },
        packageFileName: 'pet.zip',
        packageSizeBytes: 1024,
        likeCount: 2,
        downloadCount: 3,
        publishedAt: '2026-07-31T00:00:00.000Z',
        internalEvidence: '不得公开'
      })),
      listFeedback: vi.fn(async () => ({
        items: [{
          id: 'feedback-1',
          kind: 'feedback' as const,
          authorName: '匿名用户',
          content: '公开反馈',
          likeCount: 1,
          createdAt: '2026-07-31T00:00:00.000Z',
          statusTokenHash: '不得公开'
        }],
        nextCursor: null
      })),
      toggleCommunityLike: vi.fn(async () => ({ liked: true, likeCount: 3 })),
      toggleFeedbackLike: vi.fn(async () => ({ liked: true, likeCount: 3 })),
      getDownload: vi.fn(async () => ({
        url: 'https://storage.example/download',
        expiresAt: '2026-07-31T00:05:00.000Z'
      }))
    },
    abuseControl: {
      consume: vi.fn(async () => undefined)
    },
    adminIdentity: {
      requireAdmin: vi.fn(async () => ({
        uid: 'uid-admin',
        email: 'admin@example.com'
      }))
    },
    admin: {
      listQueue: vi.fn(async () => ({ items: [], nextCursor: null })),
      getDetail: vi.fn(async () => ({
        id: 'submission-1',
        status: 'manual_review_pending',
        coverPreview: {
          url: 'https://preview.example/cover.webp',
          expiresAt: '2026-07-31T00:05:00.000Z'
        }
      })),
      applyAction: vi.fn(async () => ({
        submission: {
          id: 'submission-1',
          status: 'published',
          statusVersion: 4
        },
        replayed: false
      }))
    },
    fingerprintSecret
  };
}

function event(
  method: string,
  path: string,
  body?: unknown,
  userAgent = 'test-agent'
): {
  httpMethod: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: string;
} {
  return {
    httpMethod: method,
    path,
    headers: { 'user-agent': userAgent },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  };
}

const context = {
  requestId: 'request-1',
  sourceIp
};

let runtime: ReturnType<typeof createFakeRuntime>;

beforeEach(() => {
  runtime = createFakeRuntime();
  productionSdk.createRuntime.mockReturnValue(runtime);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('API 生产组合', () => {
  it('使用有效 Bucket 和 Auth 创建共享运行时组合', () => {
    stubCloudConfig();

    const handler = createProductionHandler();

    expect(productionSdk.createRuntime).toHaveBeenCalledTimes(1);
    expect(productionSdk.createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ envId: 'env-test' })
    );
    expect(handler).toBeTypeOf('function');
  });

  it('主入口重复调用时复用同一个不触网的组合', async () => {
    stubCloudConfig();

    const admin = await productionMain(
      event('GET', '/api/v1/admin/submissions'),
      context
    );
    const first = await productionMain(event('GET', '/api/v1/missing'), context);
    const second = await productionMain(event('GET', '/api/v1/missing'), context);

    expect(productionSdk.createRuntime).toHaveBeenCalledTimes(1);
    expect(admin.statusCode).toBe(200);
    expect(first.statusCode).toBe(404);
    expect(second.statusCode).toBe(404);
    expect(runtime.auth.getUserInfo).toHaveBeenCalledOnce();
    expect(runtime.auth.getEndUserInfo).toHaveBeenCalledWith('admin-uid');
  });
});

describe('公开 HTTP API', () => {
  it('兼容 CloudBase HTTP 服务剥离 api 前缀后的路径', async () => {
    const dependencies = createDependencies();
    const main = createApi(dependencies);

    const response = await main(event('GET', '/v1/community'), context);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).error).toBeNull();
  });

  it('匿名 prepare 缺少 CAPTCHA 返回 400', async () => {
    const dependencies = createDependencies();
    const main = createApi(dependencies);

    const response = await main(
      event('POST', '/api/v1/submissions/prepare', {}),
      context
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('INVALID_REQUEST');
    expect(dependencies.submissions.prepare).not.toHaveBeenCalled();
  });

  it('只从受信 context 读取来源 IP 并忽略代理头', async () => {
    const dependencies = createDependencies();
    const main = createApi(dependencies);
    const request = event('POST', '/api/v1/submissions/prepare', {
      kind: 'shared_package',
      title: '名称',
      body: '说明',
      captcha: { ticket: 'ticket', randstr: 'randstr' },
      packageFile: {
        fileName: 'pet.zip',
        sizeBytes: 1024,
        contentType: 'application/zip'
      },
      coverFile: {
        fileName: 'cover.webp',
        sizeBytes: 512,
        contentType: 'image/webp'
      }
    });
    request.headers['x-forwarded-for'] = '198.51.100.99';

    const response = await main(request, context);

    expect(response.statusCode).toBe(200);
    expect(dependencies.submissions.prepare).toHaveBeenCalledWith(
      expect.any(Object),
      { ip: sourceIp }
    );
    expect(JSON.stringify(dependencies.abuseControl.consume.mock.calls))
      .not.toContain(sourceIp);
    expect(JSON.stringify(dependencies.abuseControl.consume.mock.calls))
      .not.toContain('198.51.100.99');
  });

  it('缺少受信来源 IP 时失败关闭', async () => {
    const main = createApi(createDependencies());

    const response = await main(
      event('POST', '/api/v1/submission-status', {
        statusToken: 'a'.repeat(43)
      }),
      { requestId: 'request-no-ip' }
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('INVALID_REQUEST');
  });

  it('动态投稿 ID 只接受单个安全路径段', async () => {
    const dependencies = createDependencies();
    const main = createApi(dependencies);

    const valid = await main(
      event('POST', '/api/v1/submissions/submission-1/finalize', {}),
      context
    );
    const encodedSlash = await main(
      event('POST', '/api/v1/submissions/submission%2Fprivate/finalize', {}),
      context
    );

    expect(valid.statusCode).toBe(200);
    expect(dependencies.submissions.finalize).toHaveBeenCalledWith({
      submissionId: 'submission-1'
    });
    expect(encodedSlash.statusCode).toBe(400);
    expect(dependencies.submissions.finalize).toHaveBeenCalledOnce();
  });

  it('状态查询限流并只返回公开状态 DTO', async () => {
    const dependencies = createDependencies();
    dependencies.submissions.getStatus.mockResolvedValueOnce({
      submissionId: 'submission-1',
      status: 'system_reviewing',
      publicReason: null,
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:01:00.000Z',
      moderationEvidence: '不得公开'
    });
    const main = createApi(dependencies);

    const response = await main(
      event('POST', '/api/v1/submission-status', {
        statusToken: 'a'.repeat(43)
      }),
      context
    );
    const payload = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(dependencies.abuseControl.consume).toHaveBeenCalledWith(
      'status_query',
      expect.stringMatching(/^[a-f0-9]{64}$/u)
    );
    expect(payload.data).toEqual({
      submissionId: 'submission-1',
      status: 'system_reviewing',
      publicReason: null,
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:01:00.000Z'
    });
    expect(response.body).not.toContain('moderationEvidence');
  });

  it('公开列表、详情和反馈裁剪内部字段', async () => {
    const dependencies = createDependencies();
    const main = createApi(dependencies);

    const responses = await Promise.all([
      main(event('GET', '/api/v1/community'), context),
      main(event('GET', '/api/v1/community/community-1'), context),
      main({
        ...event('GET', '/api/v1/feedback'),
        queryStringParameters: { kind: 'feedback' }
      }, context)
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toMatch(
        /storageKey|internalEvidence|statusTokenHash/u
      );
    }
  });

  it('点赞和下载分别按设备哈希与资源 ID 限流', async () => {
    const dependencies = createDependencies();
    const main = createApi(dependencies);

    await main(
      event('POST', '/api/v1/community/community-1/like', {}),
      context
    );
    await main(
      event('POST', '/api/v1/community/community-1/download', {}),
      context
    );

    const deviceHash = createHmac('sha256', fingerprintSecret)
      .update(`${sourceIp}\ntest-agent`)
      .digest('hex');
    expect(dependencies.abuseControl.consume.mock.calls).toContainEqual([
      'like:community-1',
      deviceHash
    ]);
    expect(dependencies.abuseControl.consume.mock.calls).toContainEqual([
      'download:community-1',
      deviceHash
    ]);
    expect(dependencies.publicContent.toggleCommunityLike)
      .toHaveBeenCalledWith('community-1', deviceHash);
    expect(dependencies.publicContent.toggleFeedbackLike).not.toHaveBeenCalled();
    expect(dependencies.publicContent.getDownload)
      .toHaveBeenCalledWith('community-1');
  });

  it('反馈点赞使用独立公开路由并复用设备限流', async () => {
    const dependencies = createDependencies();
    const main = createApi(dependencies);

    const response = await main(
      event('POST', '/api/v1/feedback/feedback-1/like', {}),
      context
    );

    const deviceHash = createHmac('sha256', fingerprintSecret)
      .update(`${sourceIp}\ntest-agent`)
      .digest('hex');
    expect(response.statusCode).toBe(200);
    expect(dependencies.abuseControl.consume).toHaveBeenCalledWith(
      'like:feedback-1',
      deviceHash
    );
    expect(dependencies.publicContent.toggleFeedbackLike)
      .toHaveBeenCalledWith('feedback-1', deviceHash);
    expect(dependencies.publicContent.toggleCommunityLike).not.toHaveBeenCalled();
  });

  it('429 响应在稳定错误信封中包含重试秒数', async () => {
    const dependencies = createDependencies();
    dependencies.abuseControl.consume.mockRejectedValueOnce(
      Object.assign(new Error('内部计数信息'), {
        code: 'RATE_LIMITED',
        statusCode: 429,
        retryAfterSeconds: 18,
        publicMessage: '请求失败'
      })
    );
    const main = createApi(dependencies);

    const response = await main(
      event('POST', '/api/v1/submission-status', {
        statusToken: 'a'.repeat(43)
      }),
      context
    );

    expect(response.statusCode).toBe(429);
    expect(JSON.parse(response.body)).toMatchObject({
      data: null,
      error: {
        code: 'RATE_LIMITED',
        retryAfterSeconds: 18
      },
      requestId: 'request-1'
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain('内部计数信息');
  });

  it('未知路由返回稳定 404', async () => {
    const response = await createApi(createDependencies())(
      event('GET', '/api/v1/missing'),
      context
    );

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({
      data: null,
      error: { code: 'NOT_FOUND' },
      requestId: 'request-1'
    });
  });

  it('三个管理员路由都先验证唯一管理员身份', async () => {
    const dependencies = createDependencies();
    const main = createApi(dependencies);

    await main({
      ...event('GET', '/api/v1/admin/submissions'),
      queryStringParameters: { status: 'manual_review_pending' }
    }, context);
    await main(
      event('GET', '/api/v1/admin/submissions/submission-1'),
      context
    );
    await main(
      event('POST', '/api/v1/admin/submissions/submission-1/actions', {
        action: 'approve',
        version: 3,
        idempotencyKey: 'request-0001',
        reason: '审核通过'
      }),
      context
    );

    expect(dependencies.adminIdentity.requireAdmin).toHaveBeenCalledTimes(3);
    expect(dependencies.admin.listQueue).toHaveBeenCalledWith({
      limit: 20,
      status: 'manual_review_pending'
    });
    expect(dependencies.admin.applyAction).toHaveBeenCalledWith(
      { uid: 'uid-admin', email: 'admin@example.com' },
      'submission-1',
      {
        action: 'approve',
        version: 3,
        idempotencyKey: 'request-0001',
        reason: '审核通过'
      }
    );
  });

  it('管理员详情在身份校验后返回短期封面预览', async () => {
    const dependencies = createDependencies();
    const response = await createApi(dependencies)(
      event('GET', '/api/v1/admin/submissions/submission-1'),
      context
    );

    expect(dependencies.adminIdentity.requireAdmin).toHaveBeenCalledOnce();
    expect(JSON.parse(response.body)).toMatchObject({
      data: {
        coverPreview: {
          url: 'https://preview.example/cover.webp',
          expiresAt: '2026-07-31T00:05:00.000Z'
        }
      }
    });
  });

  it('非白名单用户不能读取管理员队列', async () => {
    const dependencies = createDependencies();
    dependencies.adminIdentity.requireAdmin.mockRejectedValueOnce(
      Object.assign(new Error('邮箱不在白名单'), {
        code: 'FORBIDDEN',
        statusCode: 403
      })
    );
    const main = createApi(dependencies);

    const response = await main(
      event('GET', '/api/v1/admin/submissions'),
      context
    );

    expect(response.statusCode).toBe(403);
    expect(dependencies.admin.listQueue).not.toHaveBeenCalled();
    expect(response.body).not.toContain('邮箱不在白名单');
  });
});

describe('持久化滥用控制', () => {
  it.each([
    ['submission_prepare', 5, 600],
    ['status_query', 30, 60],
    ['like:community-1', 10, 60],
    ['download:community-1', 10, 60]
  ] as const)('%s 使用精确窗口策略', async (scope, maximum, windowSeconds) => {
    const store = {
      consumeAbuseLimit: vi.fn(async () => ({
        allowed: true,
        retryAfterSeconds: 0
      }))
    };
    const control = new AbuseControl(store);

    await control.consume(scope, 'a'.repeat(64));

    expect(store.consumeAbuseLimit).toHaveBeenCalledWith({
      scope,
      fingerprintHash: 'a'.repeat(64),
      maximum,
      windowSeconds
    });
  });

  it('数据库拒绝消费时抛出带重试秒数的 429', async () => {
    const control = new AbuseControl({
      consumeAbuseLimit: vi.fn(async () => ({
        allowed: false,
        retryAfterSeconds: 42
      }))
    });

    await expect(control.consume('status_query', 'b'.repeat(64)))
      .rejects.toMatchObject({
        code: 'RATE_LIMITED',
        statusCode: 429,
        retryAfterSeconds: 42
      });
  });
});
