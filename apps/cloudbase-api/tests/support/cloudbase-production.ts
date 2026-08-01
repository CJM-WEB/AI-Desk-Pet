import { vi } from 'vitest';

/** 为生产入口组合测试提供完整且不含真实凭据的最小环境配置。 */
export function stubCloudConfig(): void {
  const values: Record<string, string> = {
    CLOUDBASE_ENV_ID: 'env-test',
    PRIVATE_BUCKET_ID: 'private-bucket',
    ADMIN_EMAIL: 'admin@example.com',
    CAPTCHA_APP_ID: '10001',
    CAPTCHA_SECRET_KEY: 'captcha-secret',
    CLOUDBASE_API_KEY: 'service-role-key',
    ABUSE_HMAC_SECRET: 'abuse-secret',
    TENCENTCLOUD_SECRETID: 'secret-id',
    TENCENTCLOUD_SECRETKEY: 'secret-key',
    MODERATION_REGION: 'ap-singapore',
    TMS_BIZ_TYPE: 'text-moderation',
    IMS_BIZ_TYPE: 'image-moderation',
    SCANNER_URL: 'https://scanner.example.com',
    SCANNER_HMAC_SECRET: 'scanner-secret',
    CLOUDBASE_AI_BASE_URL: 'https://ai.example.com/v1',
    CLOUDBASE_AI_API_KEY: 'ai-secret'
  };
  for (const [name, value] of Object.entries(values)) {
    vi.stubEnv(name, value);
  }
}
