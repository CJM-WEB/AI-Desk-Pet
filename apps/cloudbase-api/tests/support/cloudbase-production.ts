import { vi } from 'vitest';

/** 为生产入口组合测试提供完整且不含真实凭据的最小环境配置。 */
function stubValues(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

/** 为公开 API 入口提供最小环境配置。 */
export function stubApiConfig(): void {
  stubValues({
    CLOUDBASE_ENV_ID: 'env-test',
    PRIVATE_BUCKET_ID: 'private-bucket',
    ADMIN_EMAIL: 'admin@example.com',
    CLOUDBASE_API_KEY: 'service-role-key',
    ABUSE_HMAC_SECRET: 'abuse-secret'
  });
}

/** 为自动审核入口提供最小环境配置。 */
export function stubModerationWorkerConfig(): void {
  stubValues({
    CLOUDBASE_ENV_ID: 'env-test',
    PRIVATE_BUCKET_ID: 'private-bucket',
    CLOUDBASE_API_KEY: 'service-role-key',
    TENCENTCLOUD_SECRETID: 'secret-id',
    TENCENTCLOUD_SECRETKEY: 'secret-key',
    MODERATION_REGION: 'ap-singapore',
    TMS_BIZ_TYPE: 'text-moderation',
    IMS_BIZ_TYPE: 'image-moderation',
    SCANNER_URL: 'https://scanner.example.com',
    SCANNER_HMAC_SECRET: 'scanner-secret'
  });
}

/** 为隔离清理入口提供最小环境配置。 */
export function stubCleanupConfig(): void {
  stubValues({
    CLOUDBASE_ENV_ID: 'env-test',
    PRIVATE_BUCKET_ID: 'private-bucket',
    CLOUDBASE_API_KEY: 'service-role-key'
  });
}

/** 提供可通过存储适配器构造校验的共享运行时替身。 */
export function createFakeRuntime() {
  const queryResult = { data: [], error: null };
  const query = {
    insert: () => query,
    update: () => query,
    upsert: () => query,
    select: () => query,
    eq: () => query,
    lte: () => query,
    not: () => query,
    order: () => query,
    limit: () => query,
    range: () => query,
    single: () => query,
    maybeSingle: () => query,
    then<TResult1 = typeof queryResult, TResult2 = never>(
      onfulfilled?: ((value: typeof queryResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ) {
      return Promise.resolve(queryResult).then(onfulfilled, onrejected);
    }
  };
  return {
    rdb: { from: vi.fn(() => query) },
    bucket: {
      bucketId: 'ai-pet-private',
      createSignedUploadUrl: vi.fn(),
      info: vi.fn(),
      createSignedUrl: vi.fn(),
      remove: vi.fn()
    }
  };
}
