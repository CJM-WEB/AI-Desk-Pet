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
  init(options: CloudBaseServerInitOptions): {
    rdb(): CloudBaseRdbClient;
    storage: { from(bucketId: string): CloudBaseStorageBucket };
  };
}

type CloudBaseServerInitOptions = {
  env: string;
  region: 'ap-shanghai';
  timeout: number;
  accessKey: string;
};

type CloudBaseServerRuntimeConfig = CloudBaseRuntimeConfig & {
  cloudbaseApiKey: string;
};

const installedSdk: CloudBaseServerSdk = {
  init: options => cloudbase.init(options) as unknown as ReturnType<
    CloudBaseServerSdk['init']
  >
};

/**
 * RDB 与私有 Storage 共用服务端 API Key 实例，避免第二个 context 实例无法读取私有对象。
 */
export function createCloudBaseServerRuntime(
  config: CloudBaseServerRuntimeConfig,
  sdk: CloudBaseServerSdk = installedSdk
): CloudBaseServerRuntime {
  const app = sdk.init({
    env: config.envId,
    region: config.cloudbaseRegion,
    timeout: config.cloudbaseSdkTimeoutMs,
    accessKey: config.cloudbaseApiKey
  });
  return {
    rdb: app.rdb(),
    bucket: app.storage.from(config.privateBucketId)
  };
}
