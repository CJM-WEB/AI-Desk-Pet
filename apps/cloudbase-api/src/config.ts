/** CloudBase 审核 API 的运行时配置。 */
export interface CloudConfig {
  envId: string;
  privateBucketId: string;
  adminEmail: string;
  captchaAppId: number;
  captchaSecretKey: string;
  moderationRegion: string;
  tmsBizType: string;
  imsBizType: string;
  scannerUrl: string;
  scannerHmacSecret: string;
  cloudbaseAiApiKey: string;
  relevanceModel: 'deepseek-v4-flash';
}

/** 读取必填环境变量，避免以空配置启动服务。 */
function readRequired(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`缺少必填环境变量：${name}`);
  return value;
}

/** 从显式传入的环境变量构造运行配置。 */
export function loadCloudConfig(env: NodeJS.ProcessEnv): CloudConfig {
  const envId = readRequired(env, 'CLOUDBASE_ENV_ID');
  const privateBucketId = readRequired(env, 'PRIVATE_BUCKET_ID');
  const adminEmail = readRequired(env, 'ADMIN_EMAIL');
  const captchaAppId = Number(readRequired(env, 'CAPTCHA_APP_ID'));
  if (!Number.isSafeInteger(captchaAppId) || captchaAppId <= 0) {
    throw new Error('CAPTCHA_APP_ID 必须是正整数');
  }

  return {
    envId,
    privateBucketId,
    adminEmail,
    captchaAppId,
    captchaSecretKey: readRequired(env, 'CAPTCHA_SECRET_KEY'),
    moderationRegion: readRequired(env, 'MODERATION_REGION'),
    tmsBizType: readRequired(env, 'TMS_BIZ_TYPE'),
    imsBizType: readRequired(env, 'IMS_BIZ_TYPE'),
    scannerUrl: readRequired(env, 'SCANNER_URL'),
    scannerHmacSecret: readRequired(env, 'SCANNER_HMAC_SECRET'),
    cloudbaseAiApiKey: readRequired(env, 'CLOUDBASE_AI_API_KEY'),
    relevanceModel: 'deepseek-v4-flash'
  };
}
