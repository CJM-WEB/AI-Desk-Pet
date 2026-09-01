import cloudbase from '@cloudbase/js-sdk';

export interface CloudBaseSdkResult<T> {
  data: T | null;
  error: unknown | null;
}

export interface CloudBaseBrowserSession {
  access_token?: string;
}

export interface CloudBaseBrowserOtpChallenge {
  verifyOtp(params: { token: string }): Promise<CloudBaseSdkResult<unknown>>;
}

export interface CloudBaseBrowserAuth {
  signInWithOtp(params: {
    email: string;
    options: { shouldCreateUser: false };
  }): Promise<CloudBaseSdkResult<CloudBaseBrowserOtpChallenge>>;
  getSession(): Promise<CloudBaseSdkResult<{ session: CloudBaseBrowserSession | null }>>;
  refreshSession(): Promise<CloudBaseSdkResult<{ session: CloudBaseBrowserSession | null }>>;
  signOut(): Promise<unknown>;
}

export interface CloudBaseBrowserClient {
  auth(): CloudBaseBrowserAuth;
}

interface CloudBaseBrowserSdk {
  init(options: {
    env: string;
    region: 'ap-shanghai';
    accessKey: string;
    timeout: 15_000;
  }): CloudBaseBrowserClient;
}

/** 仅在 SDK 边界收窄 3.6.8 未完整导出的响应类型。 */
const installedSdk: CloudBaseBrowserSdk = {
  init: options => cloudbase.init(options) as unknown as CloudBaseBrowserClient
};

let browserClient: CloudBaseBrowserClient | undefined;

/** 在浏览器端延迟创建并复用 CloudBase V3 客户端。 */
export function getCloudBaseClient(): CloudBaseBrowserClient {
  if (typeof window === 'undefined') {
    throw new Error('CLOUDBASE_BROWSER_ONLY');
  }

  if (browserClient) {
    return browserClient;
  }

  const env = process.env.NEXT_PUBLIC_CLOUDBASE_ENV_ID;
  const accessKey = process.env.NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY;
  if (!env || !accessKey) {
    throw new Error('CLOUDBASE_BROWSER_CONFIG_REQUIRED');
  }

  browserClient = installedSdk.init({
    env,
    region: 'ap-shanghai',
    accessKey,
    timeout: 15_000
  });
  return browserClient;
}
