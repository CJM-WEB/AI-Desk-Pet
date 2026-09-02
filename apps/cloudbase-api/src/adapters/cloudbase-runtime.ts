import cloudbase from '@cloudbase/js-sdk';

import type { CloudBaseRdbClient } from './cloudbase-postgres.js';
import type { CloudBaseStorageBucket } from './cloudbase-storage.js';
import type { CloudBaseRuntimeConfig } from '../config.js';

type CloudBaseInitConfig = NonNullable<Parameters<typeof cloudbase.init>[0]>;

/** 直接收窄自 V3 Node 入口，避免维护第二份云函数 context。 */
export type CloudBaseFunctionContext = NonNullable<
  CloudBaseInitConfig['context']
>;

export interface CloudBaseServerRuntime {
  rdb: CloudBaseRdbClient;
  bucket: CloudBaseStorageBucket;
}

export interface CloudBaseServerSdk {
  init(options: CloudBaseRdbInitOptions | CloudBaseStorageInitOptions): {
    rdb(): CloudBaseRdbClient;
    storage: { from(bucketId: string): CloudBaseStorageBucket };
  };
}

type CloudBaseRdbInitOptions = {
  env: string;
  region: 'ap-shanghai';
  timeout: number;
  accessKey: string;
  context?: never;
};

type CloudBaseStorageInitOptions = {
  env: string;
  region: 'ap-shanghai';
  timeout: number;
  context: CloudBaseFunctionContext;
  accessKey?: never;
};

type CloudBaseServerRuntimeConfig = CloudBaseRuntimeConfig & {
  cloudbaseApiKey: string;
};

const installedSdk: CloudBaseServerSdk = {
  init: options => cloudbase.init(options) as unknown as ReturnType<
    CloudBaseServerSdk['init']
  >
};

/** RDB 只使用服务端 API Key 查询 RLS 表；私有 Storage 仅使用本次函数临时身份。 */
export function createCloudBaseServerRuntime(
  config: CloudBaseServerRuntimeConfig,
  context: CloudBaseFunctionContext,
  sdk: CloudBaseServerSdk = installedSdk
): CloudBaseServerRuntime {
  const rdbApp = sdk.init({
    env: config.envId,
    region: config.cloudbaseRegion,
    timeout: config.cloudbaseSdkTimeoutMs,
    accessKey: config.cloudbaseApiKey
  });
  const storageApp = sdk.init({
    env: config.envId,
    region: config.cloudbaseRegion,
    timeout: config.cloudbaseSdkTimeoutMs,
    context
  });
  return {
    rdb: rdbApp.rdb(),
    bucket: storageApp.storage.from(config.privateBucketId)
  };
}
