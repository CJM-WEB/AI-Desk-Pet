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

  it('moderation loader 只要求审核与 Scanner 变量', () => {
    expect(configModule.loadModerationWorkerConfig).toBeTypeOf('function');
    expect(configModule.loadModerationWorkerConfig({
      ...baseEnv,
      TENCENTCLOUD_SECRETID: 'secret-id',
      TENCENTCLOUD_SECRETKEY: 'secret-key',
      TENCENTCLOUD_SESSIONTOKEN: 'session-token',
      MODERATION_REGION: 'ap-shanghai',
      TMS_BIZ_TYPE: 'ai-pet-text',
      IMS_BIZ_TYPE: 'ai-pet-image',
      SCANNER_URL: 'https://scanner.example.com',
      SCANNER_HMAC_SECRET: 'scanner-secret'
    })).toEqual({
      envId: 'env-test',
      cloudbaseRegion: 'ap-shanghai',
      cloudbaseSdkTimeoutMs: 15_000,
      cloudbaseApiKey: 'service-role-key',
      privateBucketId: 'ai-pet-private',
      tencentCloudSecretId: 'secret-id',
      tencentCloudSecretKey: 'secret-key',
      tencentCloudSessionToken: 'session-token',
      moderationRegion: 'ap-shanghai',
      tmsBizType: 'ai-pet-text',
      imsBizType: 'ai-pet-image',
      scannerUrl: 'https://scanner.example.com',
      scannerHmacSecret: 'scanner-secret'
    });
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

  it('审核显式密钥不会混用平台临时 Token', () => {
    const config = configModule.loadModerationWorkerConfig({
      ...baseEnv,
      TENCENTCLOUD_SECRETID: 'platform-id',
      TENCENTCLOUD_SECRETKEY: 'platform-key',
      TENCENTCLOUD_SESSIONTOKEN: 'platform-token',
      MODERATION_SECRET_ID: 'moderation-id',
      MODERATION_SECRET_KEY: 'moderation-key',
      MODERATION_REGION: 'ap-shanghai',
      TMS_BIZ_TYPE: 'ai-pet-text',
      IMS_BIZ_TYPE: 'ai-pet-image',
      SCANNER_URL: 'https://scanner.example.com',
      SCANNER_HMAC_SECRET: 'scanner-secret'
    });
    expect(config.tencentCloudSecretId).toBe('moderation-id');
    expect(config.tencentCloudSecretKey).toBe('moderation-key');
    expect(config.tencentCloudSessionToken).toBeUndefined();
  });

  it('API loader 拒绝新加坡地域', () => {
    expect(() => configModule.loadApiConfig({
      ...baseEnv,
      ADMIN_EMAIL: 'admin@example.com',
      ABUSE_HMAC_SECRET: 'abuse-secret',
      CLOUDBASE_REGION: 'ap-singapore'
    })).toThrow('CLOUDBASE_REGION 必须为 ap-shanghai');
  });

  it('审核工作器拒绝新加坡地域', () => {
    expect(() => configModule.loadModerationWorkerConfig({
      ...baseEnv,
      TENCENTCLOUD_SECRETID: 'secret-id',
      TENCENTCLOUD_SECRETKEY: 'secret-key',
      MODERATION_REGION: 'ap-singapore',
      TMS_BIZ_TYPE: 'ai-pet-text',
      IMS_BIZ_TYPE: 'ai-pet-image',
      SCANNER_URL: 'https://scanner.example.com',
      SCANNER_HMAC_SECRET: 'scanner-secret'
    })).toThrow('MODERATION_REGION 必须为 ap-shanghai');
  });

  it('Scanner 地址必须使用 HTTPS', () => {
    expect(() => configModule.loadModerationWorkerConfig({
      ...baseEnv,
      TENCENTCLOUD_SECRETID: 'secret-id',
      TENCENTCLOUD_SECRETKEY: 'secret-key',
      MODERATION_REGION: 'ap-shanghai',
      TMS_BIZ_TYPE: 'ai-pet-text',
      IMS_BIZ_TYPE: 'ai-pet-image',
      SCANNER_URL: 'http://scanner.example.com',
      SCANNER_HMAC_SECRET: 'scanner-secret'
    })).toThrow('SCANNER_URL 必须使用 HTTPS');
  });
});
