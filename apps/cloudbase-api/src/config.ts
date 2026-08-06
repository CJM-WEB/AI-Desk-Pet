/** CloudBase 审核 API 的运行时配置。 */
export interface CloudConfig {
  envId: string;
  cloudbaseRegion: 'ap-singapore';
  cloudbaseSdkTimeoutMs: 15000;
  cloudbaseApiKey: string;
  privateBucketId: string;
  adminEmail: string;
  abuseHmacSecret: string;
  tencentCloudSecretId: string;
  tencentCloudSecretKey: string;
  tencentCloudSessionToken?: string;
  moderationRegion: string;
  tmsBizType: string;
  imsBizType: string;
  scannerUrl: string;
  scannerHmacSecret: string;
}

/** 读取必填环境变量，避免以空配置启动服务。 */
function readRequired(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`缺少必填环境变量：${name}`);
  return value;
}

/** 优先读取 SCF 可配置别名，并兼容平台自动注入的腾讯云凭据名。 */
function readCredential(
  env: NodeJS.ProcessEnv,
  alias: string,
  platformName: string
): string {
  const value = env[alias]?.trim() || env[platformName]?.trim();
  if (!value) {
    throw new Error(`缺少必填环境变量：${alias}（或 ${platformName}）`);
  }
  return value;
}

/** 从显式传入的环境变量构造运行配置。 */
export function loadCloudConfig(env: NodeJS.ProcessEnv): CloudConfig {
  const envId = readRequired(env, 'CLOUDBASE_ENV_ID');
  const cloudbaseRegion = env.CLOUDBASE_REGION?.trim() || 'ap-singapore';
  if (cloudbaseRegion !== 'ap-singapore') {
    throw new Error('CLOUDBASE_REGION 必须为 ap-singapore');
  }
  const privateBucketId = readRequired(env, 'PRIVATE_BUCKET_ID');
  const adminEmail = readRequired(env, 'ADMIN_EMAIL');
  const scannerUrl = normalizeHttpsUrl(
    readRequired(env, 'SCANNER_URL'),
    'SCANNER_URL'
  );
  // 显式审核密钥不能搭配平台临时 Token，否则会因凭据不属于同一会话而验签失败。
  const usesModerationAlias = Boolean(
    env.MODERATION_SECRET_ID?.trim() || env.MODERATION_SECRET_KEY?.trim()
  );
  const moderationSessionToken = usesModerationAlias
    ? env.MODERATION_SESSION_TOKEN?.trim()
    : env.TENCENTCLOUD_SESSIONTOKEN?.trim();

  return {
    envId,
    cloudbaseRegion,
    cloudbaseSdkTimeoutMs: 15_000,
    cloudbaseApiKey: readRequired(env, 'CLOUDBASE_API_KEY'),
    privateBucketId,
    adminEmail,
    abuseHmacSecret: readRequired(env, 'ABUSE_HMAC_SECRET'),
    tencentCloudSecretId: readCredential(
      env,
      'MODERATION_SECRET_ID',
      'TENCENTCLOUD_SECRETID'
    ),
    tencentCloudSecretKey: readCredential(
      env,
      'MODERATION_SECRET_KEY',
      'TENCENTCLOUD_SECRETKEY'
    ),
    ...(moderationSessionToken ? {
      tencentCloudSessionToken: moderationSessionToken
    } : {}),
    moderationRegion: readRequired(env, 'MODERATION_REGION'),
    tmsBizType: readRequired(env, 'TMS_BIZ_TYPE'),
    imsBizType: readRequired(env, 'IMS_BIZ_TYPE'),
    scannerUrl,
    scannerHmacSecret: readRequired(env, 'SCANNER_HMAC_SECRET')
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
