import { describe, expect, it, vi } from 'vitest';
import cloudbase from '@cloudbase/js-sdk';

import type { CloudBaseRdbClient } from '../src/adapters/cloudbase-postgres.js';
import {
  createCloudBaseServerRuntime,
  type CloudBaseFunctionContext,
  type CloudBaseServerSdk
} from '../src/adapters/cloudbase-runtime.js';
import type { CloudBaseStorageBucket } from '../src/adapters/cloudbase-storage.js';

const runtimeConfig = {
  envId: 'env-test',
  cloudbaseRegion: 'ap-singapore' as const,
  cloudbaseSdkTimeoutMs: 15_000 as const,
  privateBucketId: 'ai-pet-private'
};
const functionContext: CloudBaseFunctionContext = {
  eventID: 'event-1',
  extendedContext: {
    envId: 'env-test',
    source: 'scf',
    tmpSecret: {
      secretId: 'temporary-id',
      secretKey: 'temporary-key',
      token: 'temporary-token'
    }
  }
};

describe('CloudBase V3 Node 运行时工厂', () => {
  it('已安装 3.6.8 的 rdb 运行时是工厂函数', () => {
    const app = cloudbase.init({
      env: 'env-test',
      context: { eventID: 'runtime-shape-probe' }
    });

    expect(app.rdb).toBeTypeOf('function');
  });

  it('向 V3 SDK 传递函数原生 context 且不再传 PostgreSQL API Key', () => {
    const { fakeApp, fakeBucket, fakeRdb } = createFakeApp();
    const init = vi.fn(
      (_options: Parameters<CloudBaseServerSdk['init']>[0]) => fakeApp
    );
    const runtime = createCloudBaseServerRuntime(
      runtimeConfig,
      functionContext,
      { init }
    );

    expect(init).toHaveBeenCalledOnce();
    expect(init).toHaveBeenCalledWith({
      env: 'env-test',
      region: 'ap-singapore',
      timeout: 15_000,
      context: functionContext
    });
    expect(init.mock.calls[0]?.[0]).not.toHaveProperty('accessKey');
    expect(fakeApp.rdb).toHaveBeenCalledOnce();
    expect(runtime).toEqual({ rdb: fakeRdb, bucket: fakeBucket });
  });
});

function createFakeApp(): {
  fakeApp: ReturnType<CloudBaseServerSdk['init']>;
  fakeBucket: CloudBaseStorageBucket;
  fakeRdb: CloudBaseRdbClient;
} {
  const fakeRdb = {} as CloudBaseRdbClient;
  const fakeBucket = {} as CloudBaseStorageBucket;
  return {
    fakeApp: {
      rdb: vi.fn(() => fakeRdb),
      storage: { from: vi.fn(() => fakeBucket) }
    } as unknown as ReturnType<CloudBaseServerSdk['init']>,
    fakeRdb,
    fakeBucket
  };
}
