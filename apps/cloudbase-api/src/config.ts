/** CloudBase 审核 API 的运行时配置。 */
export interface CloudConfig {
  envId: string;
  cloudbaseApiKey: string;
  privateBucketId: string;
  adminEmail: string;
  captchaAppId: number;
  captchaSecretKey: string;
  abuseHmacSecret: string;
  tencentCloudSecretId: string;
  tencentCloudSecretKey: string;
  tencentCloudSessionToken?: string;
  moderationRegion: string;
  tmsBizType: string;
  imsBizType: string;
  scannerUrl: string;
  scannerHmacSecret: string;
  cloudbaseAiBaseUrl: string;
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

  const cloudbaseAiBaseUrl = readRequired(env, 'CLOUDBASE_AI_BASE_URL');
  if (!cloudbaseAiBaseUrl.startsWith('https://')) {
    throw new Error('CLOUDBASE_AI_BASE_URL 必须使用 HTTPS');
  }

  const scannerUrl = normalizeHttpsUrl(
    readRequired(env, 'SCANNER_URL'),
    'SCANNER_URL'
  );

  return {
    envId,
    cloudbaseApiKey: readRequired(env, 'CLOUDBASE_API_KEY'),
    privateBucketId,
    adminEmail,
    captchaAppId,
    captchaSecretKey: readRequired(env, 'CAPTCHA_SECRET_KEY'),
    abuseHmacSecret: readRequired(env, 'ABUSE_HMAC_SECRET'),
    tencentCloudSecretId: readRequired(env, 'TENCENTCLOUD_SECRETID'),
    tencentCloudSecretKey: readRequired(env, 'TENCENTCLOUD_SECRETKEY'),
    ...(env.TENCENTCLOUD_SESSIONTOKEN?.trim() ? {
      tencentCloudSessionToken: env.TENCENTCLOUD_SESSIONTOKEN.trim()
    } : {}),
    moderationRegion: readRequired(env, 'MODERATION_REGION'),
    tmsBizType: readRequired(env, 'TMS_BIZ_TYPE'),
    imsBizType: readRequired(env, 'IMS_BIZ_TYPE'),
    scannerUrl,
    scannerHmacSecret: readRequired(env, 'SCANNER_HMAC_SECRET'),
    cloudbaseAiBaseUrl,
    cloudbaseAiApiKey: readRequired(env, 'CLOUDBASE_AI_API_KEY'),
    relevanceModel: 'deepseek-v4-flash'
  };
}

function normalizeHttpsUrl(value: string, name: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      throw new Error();
    }
    return url.toString().replace(/\/$/u, '');
  } catch {
    throw new Error(`${name} 必须使用 HTTPS`);
  }
}
