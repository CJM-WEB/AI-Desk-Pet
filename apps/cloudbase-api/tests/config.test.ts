import { describe, expect, it } from 'vitest';

import * as configModule from '../src/config.js';

const baseEnv = {
  CLOUDBASE_ENV_ID: 'env-test',
  CLOUDBASE_API_KEY: 'service-role-key',
  PRIVATE_BUCKET_ID: 'ai-pet-private'
};

describe('CloudBase 函数专属配置', () => {
  it('API loader 只要求 API 实际消费的变量且投稿开关默认关闭', () => {
    expect(configModule.loadApiConfig).toBeTypeOf('function');
    expect(configModule.loadApiConfig({
      ...baseEnv,
      ADMIN_EMAIL: 'admin@example.com',
      ABUSE_HMAC_SECRET: 'abuse-secret'
    })).toEqual({
      envId: 'env-test',
      cloudbaseRegion: 'ap-shanghai',
      cloudbaseSdkTimeoutMs: 15_000,
      cloudbaseApiKey: 'service-role-key',
      privateBucketId: 'ai-pet-private',
      adminEmail: 'admin@example.com',
      abuseHmacSecret: 'abuse-secret',
      sharedPackageSubmissionsEnabled: false
    });
  });

  it('配置模块不再暴露自动审核工作器入口', () => {
    expect(configModule).not.toHaveProperty('loadModerationWorkerConfig');
  });

  it('cleanup loader 不要求管理员、审核或 Scanner 变量', () => {
    expect(configModule.loadCleanupConfig).toBeTypeOf('function');
    expect(configModule.loadCleanupConfig(baseEnv)).toEqual({
      envId: 'env-test',
      cloudbaseRegion: 'ap-shanghai',
      cloudbaseSdkTimeoutMs: 15_000,
      cloudbaseApiKey: 'service-role-key',
      privateBucketId: 'ai-pet-private'
    });
  });

  it.each([
    [undefined, false], ['', false], ['false', false], ['true', true]
  ] as const)('投稿开关 %s 解析为 %s', (raw, expected) => {
    const config = configModule.loadApiConfig({
      ...baseEnv,
      ADMIN_EMAIL: 'admin@example.com',
      ABUSE_HMAC_SECRET: 'abuse-secret',
      ...(raw === undefined ? {} : { SHARED_PACKAGE_SUBMISSIONS_ENABLED: raw })
    });
    expect(config.sharedPackageSubmissionsEnabled).toBe(expected);
  });

  it('投稿开关拒绝模糊值', () => {
    expect(() => configModule.loadApiConfig({
      ...baseEnv,
      ADMIN_EMAIL: 'admin@example.com',
      ABUSE_HMAC_SECRET: 'abuse-secret',
      SHARED_PACKAGE_SUBMISSIONS_ENABLED: 'yes'
    })).toThrow('SHARED_PACKAGE_SUBMISSIONS_ENABLED 必须为 true 或 false');
  });

  it('API loader 拒绝新加坡地域', () => {
    expect(() => configModule.loadApiConfig({
      ...baseEnv,
      ADMIN_EMAIL: 'admin@example.com',
      ABUSE_HMAC_SECRET: 'abuse-secret',
      CLOUDBASE_REGION: 'ap-singapore'
    })).toThrow('CLOUDBASE_REGION 必须为 ap-shanghai');
  });

});
