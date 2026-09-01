/** 两个函数共享的 CloudBase 运行时最小配置。 */
export interface CloudBaseRuntimeConfig {
  envId: string;
  cloudbaseRegion: 'ap-shanghai';
  cloudbaseSdkTimeoutMs: 15000;
  privateBucketId: string;
}

export interface ApiConfig extends CloudBaseRuntimeConfig {
  cloudbaseApiKey: string;
  adminEmail: string;
  abuseHmacSecret: string;
  sharedPackageSubmissionsEnabled: boolean;
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
  const cloudbaseRegion = env.CLOUDBASE_REGION?.trim() || 'ap-shanghai';
  if (cloudbaseRegion !== 'ap-shanghai') {
    throw new Error('CLOUDBASE_REGION 必须为 ap-shanghai');
  }
  return {
    envId: readRequired(env, 'CLOUDBASE_ENV_ID'),
    cloudbaseRegion,
    cloudbaseSdkTimeoutMs: 15_000,
    privateBucketId: readRequired(env, 'PRIVATE_BUCKET_ID')
  };
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

/** 只读取隔离清理工作器所需的配置。 */
export function loadCleanupConfig(env: NodeJS.ProcessEnv): CleanupConfig {
  return {
    ...loadRuntimeConfig(env),
    cloudbaseApiKey: readRequired(env, 'CLOUDBASE_API_KEY')
  };
}
