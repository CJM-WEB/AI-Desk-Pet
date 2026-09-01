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
  init(options: {
    env: string;
    region: 'ap-shanghai';
    timeout: number;
    context: CloudBaseFunctionContext;
  }): {
    rdb(): CloudBaseRdbClient;
    storage: { from(bucketId: string): CloudBaseStorageBucket };
  };
}

const installedSdk: CloudBaseServerSdk = {
  init: options => cloudbase.init(options) as unknown as ReturnType<
    CloudBaseServerSdk['init']
  >
};

/** 使用本次调用的临时身份创建 V3 运行时，不接收 PostgreSQL API Key。 */
export function createCloudBaseServerRuntime(
  config: CloudBaseRuntimeConfig,
  context: CloudBaseFunctionContext,
  sdk: CloudBaseServerSdk = installedSdk
): CloudBaseServerRuntime {
  const app = sdk.init({
    env: config.envId,
    region: config.cloudbaseRegion,
    timeout: config.cloudbaseSdkTimeoutMs,
    context
  });
  return {
    rdb: app.rdb(),
    bucket: app.storage.from(config.privateBucketId)
  };
}
