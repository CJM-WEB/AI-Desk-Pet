import { describe, expect, it } from 'vitest';

import { loadCloudConfig } from '../src/config.js';

describe('loadCloudConfig', () => {
  const validEnv = {
    CLOUDBASE_ENV_ID: 'env-test',
    CLOUDBASE_API_KEY: 'service-role-key',
    PRIVATE_BUCKET_ID: 'ai-pet-private',
    ADMIN_EMAIL: 'admin@example.com',
    ABUSE_HMAC_SECRET: 'abuse-hmac-secret',
    TENCENTCLOUD_SECRETID: 'secret-id',
    TENCENTCLOUD_SECRETKEY: 'secret-key',
    TENCENTCLOUD_SESSIONTOKEN: 'session-token',
    MODERATION_REGION: 'ap-shanghai',
    TMS_BIZ_TYPE: 'ai-pet-text',
    IMS_BIZ_TYPE: 'ai-pet-image',
    SCANNER_URL: 'https://scanner.example.com',
    SCANNER_HMAC_SECRET: 'scanner-secret'
  };

  it('缺少管理员邮箱时拒绝启动', () => {
    expect(() => loadCloudConfig({
      CLOUDBASE_ENV_ID: 'env-test',
      PRIVATE_BUCKET_ID: 'ai-pet-private'
    })).toThrow('ADMIN_EMAIL');
  });

  it('从传入环境变量加载完整运行配置', () => {
    const config = loadCloudConfig(validEnv);

    expect(config).toEqual({
      envId: 'env-test',
      cloudbaseRegion: 'ap-singapore',
      cloudbaseSdkTimeoutMs: 15_000,
      cloudbaseApiKey: 'service-role-key',
      privateBucketId: 'ai-pet-private',
      adminEmail: 'admin@example.com',
      abuseHmacSecret: 'abuse-hmac-secret',
      tencentCloudSecretId: 'secret-id',
      tencentCloudSecretKey: 'secret-key',
      tencentCloudSessionToken: 'session-token',
      moderationRegion: 'ap-shanghai',
      tmsBizType: 'ai-pet-text',
      imsBizType: 'ai-pet-image',
      scannerUrl: 'https://scanner.example.com',
      scannerHmacSecret: 'scanner-secret'
    });
    expect(config.cloudbaseRegion).toBe('ap-singapore');
    expect(config.cloudbaseSdkTimeoutMs).toBe(15_000);
    expect(config).not.toHaveProperty('cloudbaseAiBaseUrl');
    expect(config).not.toHaveProperty('cloudbaseAiApiKey');
    expect(config).not.toHaveProperty('relevanceModel');
  });

  it('从 SCF 允许配置的别名加载审核凭据', () => {
    const {
      TENCENTCLOUD_SECRETID: _secretId,
      TENCENTCLOUD_SECRETKEY: _secretKey,
      TENCENTCLOUD_SESSIONTOKEN: _sessionToken,
      ...baseEnv
    } = validEnv;

    const config = loadCloudConfig({
      ...baseEnv,
      MODERATION_SECRET_ID: 'moderation-secret-id',
      MODERATION_SECRET_KEY: 'moderation-secret-key',
      MODERATION_SESSION_TOKEN: 'moderation-session-token'
    });

    expect(config.tencentCloudSecretId).toBe('moderation-secret-id');
    expect(config.tencentCloudSecretKey).toBe('moderation-secret-key');
    expect(config.tencentCloudSessionToken).toBe('moderation-session-token');
  });

  it('拒绝与已购买环境不一致的地域', () => {
    expect(() => loadCloudConfig({
      ...validEnv,
      CLOUDBASE_REGION: 'ap-shanghai'
    })).toThrow('CLOUDBASE_REGION 必须为 ap-singapore');
  });

  it('缺少服务端数据库 API Key 时拒绝启动', () => {
    expect(() => loadCloudConfig({
      CLOUDBASE_ENV_ID: 'env-test',
      PRIVATE_BUCKET_ID: 'ai-pet-private',
      ADMIN_EMAIL: 'admin@example.com',
      ABUSE_HMAC_SECRET: 'abuse-hmac-secret',
      TENCENTCLOUD_SECRETID: 'secret-id',
      TENCENTCLOUD_SECRETKEY: 'secret-key',
      MODERATION_REGION: 'ap-shanghai',
      TMS_BIZ_TYPE: 'ai-pet-text',
      IMS_BIZ_TYPE: 'ai-pet-image',
      SCANNER_URL: 'https://scanner.example.com',
      SCANNER_HMAC_SECRET: 'scanner-secret'
    })).toThrow('CLOUDBASE_API_KEY');
  });

  it('腾讯云访问凭据为空时拒绝启动', () => {
    expect(() => loadCloudConfig({
      CLOUDBASE_ENV_ID: 'env-test',
      CLOUDBASE_API_KEY: 'service-role-key',
      PRIVATE_BUCKET_ID: 'ai-pet-private',
      ADMIN_EMAIL: 'admin@example.com',
      ABUSE_HMAC_SECRET: 'abuse-hmac-secret',
      TENCENTCLOUD_SECRETID: ' ',
      TENCENTCLOUD_SECRETKEY: 'secret-key',
      MODERATION_REGION: 'ap-shanghai',
      TMS_BIZ_TYPE: 'ai-pet-text',
      IMS_BIZ_TYPE: 'ai-pet-image',
      SCANNER_URL: 'https://scanner.example.com',
      SCANNER_HMAC_SECRET: 'scanner-secret'
    })).toThrow('TENCENTCLOUD_SECRETID');
  });

  it('扫描服务地址必须使用 HTTPS', () => {
    expect(() => loadCloudConfig({
      CLOUDBASE_ENV_ID: 'env-test',
      CLOUDBASE_API_KEY: 'service-role-key',
      PRIVATE_BUCKET_ID: 'ai-pet-private',
      ADMIN_EMAIL: 'admin@example.com',
      ABUSE_HMAC_SECRET: 'abuse-hmac-secret',
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
