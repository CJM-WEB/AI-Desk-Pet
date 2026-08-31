/** 三个函数共享的 CloudBase 运行时最小配置。 */
export interface CloudBaseRuntimeConfig {
  envId: string;
  cloudbaseRegion: 'ap-singapore';
  cloudbaseSdkTimeoutMs: 15000;
  privateBucketId: string;
}

export interface ApiConfig extends CloudBaseRuntimeConfig {
  cloudbaseApiKey: string;
  adminEmail: string;
  abuseHmacSecret: string;
  sharedPackageSubmissionsEnabled: boolean;
}

export interface ModerationWorkerConfig extends CloudBaseRuntimeConfig {
  cloudbaseApiKey: string;
  tencentCloudSecretId: string;
  tencentCloudSecretKey: string;
  tencentCloudSessionToken?: string;
  moderationRegion: string;
  tmsBizType: string;
  imsBizType: string;
  scannerUrl: string;
  scannerHmacSecret: string;
}

export interface CleanupConfig extends CloudBaseRuntimeConfig {
  cloudbaseApiKey: string;
}

function readRequired(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`缺少必填环境变量：${name}`);
  return value;
}

function loadRuntimeConfig(env: NodeJS.ProcessEnv): CloudBaseRuntimeConfig {
  const cloudbaseRegion = env.CLOUDBASE_REGION?.trim() || 'ap-singapore';
  if (cloudbaseRegion !== 'ap-singapore') {
    throw new Error('CLOUDBASE_REGION 必须为 ap-singapore');
  }
  return {
    envId: readRequired(env, 'CLOUDBASE_ENV_ID'),
    cloudbaseRegion,
    cloudbaseSdkTimeoutMs: 15_000,
    privateBucketId: readRequired(env, 'PRIVATE_BUCKET_ID')
  };
}

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

function readBooleanSwitch(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} 必须为 true 或 false`);
}

/** 只读取公开 API 运行所需的配置。 */
export function loadApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  return {
    ...loadRuntimeConfig(env),
    cloudbaseApiKey: readRequired(env, 'CLOUDBASE_API_KEY'),
    adminEmail: readRequired(env, 'ADMIN_EMAIL'),
    abuseHmacSecret: readRequired(env, 'ABUSE_HMAC_SECRET'),
    sharedPackageSubmissionsEnabled: readBooleanSwitch(
      env,
      'SHARED_PACKAGE_SUBMISSIONS_ENABLED'
    )
  };
}

/** 只读取自动审核工作器所需的配置。 */
export function loadModerationWorkerConfig(
  env: NodeJS.ProcessEnv
): ModerationWorkerConfig {
  const usesModerationAlias = Boolean(
    env.MODERATION_SECRET_ID?.trim() || env.MODERATION_SECRET_KEY?.trim()
  );
  const moderationSessionToken = usesModerationAlias
    ? env.MODERATION_SESSION_TOKEN?.trim()
    : env.TENCENTCLOUD_SESSIONTOKEN?.trim();
  return {
    ...loadRuntimeConfig(env),
    cloudbaseApiKey: readRequired(env, 'CLOUDBASE_API_KEY'),
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
    ...(moderationSessionToken
      ? { tencentCloudSessionToken: moderationSessionToken }
      : {}),
    moderationRegion: readRequired(env, 'MODERATION_REGION'),
    tmsBizType: readRequired(env, 'TMS_BIZ_TYPE'),
    imsBizType: readRequired(env, 'IMS_BIZ_TYPE'),
    scannerUrl: normalizeHttpsUrl(
      readRequired(env, 'SCANNER_URL'),
      'SCANNER_URL'
    ),
    scannerHmacSecret: readRequired(env, 'SCANNER_HMAC_SECRET')
  };
}

/** 只读取隔离清理工作器所需的配置。 */
export function loadCleanupConfig(env: NodeJS.ProcessEnv): CleanupConfig {
  return {
    ...loadRuntimeConfig(env),
    cloudbaseApiKey: readRequired(env, 'CLOUDBASE_API_KEY')
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
    ) throw new Error();
    return url.toString().replace(/\/$/u, '');
  } catch {
    throw new Error(`${name} 必须使用 HTTPS`);
  }
}
