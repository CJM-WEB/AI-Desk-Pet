import { describe, expect, it } from 'vitest';

import { loadCloudConfig } from '../src/config.js';

describe('loadCloudConfig', () => {
  it('缺少管理员邮箱时拒绝启动', () => {
    expect(() => loadCloudConfig({
      CLOUDBASE_ENV_ID: 'env-test',
      PRIVATE_BUCKET_ID: 'ai-pet-private'
    })).toThrow('ADMIN_EMAIL');
  });

  it('从传入环境变量加载完整运行配置', () => {
    expect(loadCloudConfig({
      CLOUDBASE_ENV_ID: 'env-test',
      CLOUDBASE_API_KEY: 'service-role-key',
      PRIVATE_BUCKET_ID: 'ai-pet-private',
      ADMIN_EMAIL: 'admin@example.com',
      CAPTCHA_APP_ID: '10001',
      CAPTCHA_SECRET_KEY: 'captcha-secret',
      ABUSE_HMAC_SECRET: 'abuse-hmac-secret',
      TENCENTCLOUD_SECRETID: 'secret-id',
      TENCENTCLOUD_SECRETKEY: 'secret-key',
      TENCENTCLOUD_SESSIONTOKEN: 'session-token',
      MODERATION_REGION: 'ap-shanghai',
      TMS_BIZ_TYPE: 'ai-pet-text',
      IMS_BIZ_TYPE: 'ai-pet-image',
      SCANNER_URL: 'https://scanner.example.com',
      SCANNER_HMAC_SECRET: 'scanner-secret',
      CLOUDBASE_AI_BASE_URL: 'https://ai.example.com/v1',
      CLOUDBASE_AI_API_KEY: 'ai-secret'
    })).toEqual({
      envId: 'env-test',
      cloudbaseApiKey: 'service-role-key',
      privateBucketId: 'ai-pet-private',
      adminEmail: 'admin@example.com',
      captchaAppId: 10001,
      captchaSecretKey: 'captcha-secret',
      abuseHmacSecret: 'abuse-hmac-secret',
      tencentCloudSecretId: 'secret-id',
      tencentCloudSecretKey: 'secret-key',
      tencentCloudSessionToken: 'session-token',
      moderationRegion: 'ap-shanghai',
      tmsBizType: 'ai-pet-text',
      imsBizType: 'ai-pet-image',
      scannerUrl: 'https://scanner.example.com',
      scannerHmacSecret: 'scanner-secret',
      cloudbaseAiBaseUrl: 'https://ai.example.com/v1',
      cloudbaseAiApiKey: 'ai-secret',
      relevanceModel: 'deepseek-v4-flash'
    });
  });

  it('缺少服务端数据库 API Key 时拒绝启动', () => {
    expect(() => loadCloudConfig({
      CLOUDBASE_ENV_ID: 'env-test',
      PRIVATE_BUCKET_ID: 'ai-pet-private',
      ADMIN_EMAIL: 'admin@example.com',
      CAPTCHA_APP_ID: '10001',
      CAPTCHA_SECRET_KEY: 'captcha-secret',
      ABUSE_HMAC_SECRET: 'abuse-hmac-secret',
      TENCENTCLOUD_SECRETID: 'secret-id',
      TENCENTCLOUD_SECRETKEY: 'secret-key',
      MODERATION_REGION: 'ap-shanghai',
      TMS_BIZ_TYPE: 'ai-pet-text',
      IMS_BIZ_TYPE: 'ai-pet-image',
      SCANNER_URL: 'https://scanner.example.com',
      SCANNER_HMAC_SECRET: 'scanner-secret',
      CLOUDBASE_AI_BASE_URL: 'https://ai.example.com/v1',
      CLOUDBASE_AI_API_KEY: 'ai-secret'
    })).toThrow('CLOUDBASE_API_KEY');
  });

  it('腾讯云访问凭据为空时拒绝启动', () => {
    expect(() => loadCloudConfig({
      CLOUDBASE_ENV_ID: 'env-test',
      CLOUDBASE_API_KEY: 'service-role-key',
      PRIVATE_BUCKET_ID: 'ai-pet-private',
      ADMIN_EMAIL: 'admin@example.com',
      CAPTCHA_APP_ID: '10001',
      CAPTCHA_SECRET_KEY: 'captcha-secret',
      ABUSE_HMAC_SECRET: 'abuse-hmac-secret',
      TENCENTCLOUD_SECRETID: ' ',
      TENCENTCLOUD_SECRETKEY: 'secret-key'
    })).toThrow('TENCENTCLOUD_SECRETID');
  });

  it('扫描服务地址必须使用 HTTPS', () => {
    expect(() => loadCloudConfig({
      CLOUDBASE_ENV_ID: 'env-test',
      CLOUDBASE_API_KEY: 'service-role-key',
      PRIVATE_BUCKET_ID: 'ai-pet-private',
      ADMIN_EMAIL: 'admin@example.com',
      CAPTCHA_APP_ID: '10001',
      CAPTCHA_SECRET_KEY: 'captcha-secret',
      ABUSE_HMAC_SECRET: 'abuse-hmac-secret',
      TENCENTCLOUD_SECRETID: 'secret-id',
      TENCENTCLOUD_SECRETKEY: 'secret-key',
      MODERATION_REGION: 'ap-shanghai',
      TMS_BIZ_TYPE: 'ai-pet-text',
      IMS_BIZ_TYPE: 'ai-pet-image',
      SCANNER_URL: 'http://scanner.example.com',
      SCANNER_HMAC_SECRET: 'scanner-secret',
      CLOUDBASE_AI_BASE_URL: 'https://ai.example.com/v1',
      CLOUDBASE_AI_API_KEY: 'ai-secret'
    })).toThrow('SCANNER_URL 必须使用 HTTPS');
  });
});
