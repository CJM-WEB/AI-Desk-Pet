import cloudbase from '@cloudbase/node-sdk';

import type { CloudBaseRdbClient } from './cloudbase-postgres.js';
import type { CloudBaseStorageBucket } from './cloudbase-storage.js';
import type { CloudConfig } from '../config.js';

export interface CloudBaseServerRuntime {
  rdb: CloudBaseRdbClient;
  bucket: CloudBaseStorageBucket;
}

export interface CloudBaseServerSdk {
  init(options: {
    env: string;
    region: 'ap-singapore';
    timeout: number;
    accessKey: string;
  }): {
    rdb(): CloudBaseRdbClient;
    storage: { from(bucketId: string): CloudBaseStorageBucket };
  };
}

/** 仅在已安装 SDK 边界收窄其缺失或宽泛的类型。 */
const installedSdk: CloudBaseServerSdk = {
  init: options => cloudbase.init(
    options as unknown as Parameters<typeof cloudbase.init>[0]
  ) as unknown as ReturnType<CloudBaseServerSdk['init']>
};

export function createCloudBaseServerRuntime(
  config: CloudConfig,
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
