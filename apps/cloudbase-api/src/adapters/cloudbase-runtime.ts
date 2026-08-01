import cloudbase from '@cloudbase/js-sdk';

import type { CloudBaseAuthClient } from './cloudbase-auth.js';
import type { CloudBaseRdbClient } from './cloudbase-postgres.js';
import type { CloudBaseStorageBucket } from './cloudbase-storage.js';
import type { CloudConfig } from '../config.js';

export interface CloudBaseServerRuntime {
  rdb: CloudBaseRdbClient;
  bucket: CloudBaseStorageBucket;
  auth: CloudBaseAuthClient;
}

export interface CloudBaseServerSdk {
  currentEnv: symbol;
  init(options: {
    env: symbol;
    region: 'ap-singapore';
    timeout: number;
  }): {
    rdb(): CloudBaseRdbClient;
    storage: { from(bucketId: string): CloudBaseStorageBucket };
    auth(): CloudBaseAuthClient;
  };
}

/** 仅在已安装 SDK 边界收窄其缺失或宽泛的类型。 */
const installedSdk: CloudBaseServerSdk = {
  currentEnv: (cloudbase as typeof cloudbase & {
    SYMBOL_CURRENT_ENV: symbol;
  }).SYMBOL_CURRENT_ENV,
  init: options => cloudbase.init(
    options as unknown as Parameters<typeof cloudbase.init>[0]
  ) as unknown as ReturnType<CloudBaseServerSdk['init']>
};

export function createCloudBaseServerRuntime(
  config: CloudConfig,
  sdk: CloudBaseServerSdk = installedSdk
): CloudBaseServerRuntime {
  const app = sdk.init({
    env: sdk.currentEnv,
    region: config.cloudbaseRegion,
    timeout: config.cloudbaseSdkTimeoutMs
  });
  return {
    rdb: app.rdb(),
    bucket: app.storage.from(config.privateBucketId),
    auth: app.auth()
  };
}
