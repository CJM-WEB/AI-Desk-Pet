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
      PRIVATE_BUCKET_ID: 'ai-pet-private',
      ADMIN_EMAIL: 'admin@example.com',
      CAPTCHA_APP_ID: '10001',
      CAPTCHA_SECRET_KEY: 'captcha-secret',
      MODERATION_REGION: 'ap-shanghai',
      TMS_BIZ_TYPE: 'ai-pet-text',
      IMS_BIZ_TYPE: 'ai-pet-image',
      SCANNER_URL: 'https://scanner.example.com',
      SCANNER_HMAC_SECRET: 'scanner-secret',
      CLOUDBASE_AI_API_KEY: 'ai-secret'
    })).toEqual({
      envId: 'env-test',
      privateBucketId: 'ai-pet-private',
      adminEmail: 'admin@example.com',
      captchaAppId: 10001,
      captchaSecretKey: 'captcha-secret',
      moderationRegion: 'ap-shanghai',
      tmsBizType: 'ai-pet-text',
      imsBizType: 'ai-pet-image',
      scannerUrl: 'https://scanner.example.com',
      scannerHmacSecret: 'scanner-secret',
      cloudbaseAiApiKey: 'ai-secret',
      relevanceModel: 'deepseek-v4-flash'
    });
  });
});
