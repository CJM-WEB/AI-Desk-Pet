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
  cloudbaseRegion: 'ap-shanghai' as const,
  cloudbaseSdkTimeoutMs: 15_000 as const,
  privateBucketId: 'ai-pet-private',
  cloudbaseApiKey: 'server-rdb-access-key'
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

  it('隔离 RDB API Key 与 Storage 函数临时身份，避免 RLS 表查询失去服务端身份', () => {
    const {
      fakeRdbApp,
      fakeStorageApp,
      fakeBucket,
      fakeRdb
    } = createFakeApps();
    const init = vi.fn()
      .mockReturnValueOnce(fakeRdbApp)
      .mockReturnValueOnce(fakeStorageApp);
    const runtime = createCloudBaseServerRuntime(
      runtimeConfig,
      functionContext,
      { init: init as CloudBaseServerSdk['init'] }
    );

    expect(init).toHaveBeenCalledTimes(2);
    expect(init).toHaveBeenNthCalledWith(1, {
      env: 'env-test',
      region: 'ap-shanghai',
      timeout: 15_000,
      accessKey: 'server-rdb-access-key'
    });
    expect(init.mock.calls[0]?.[0]).not.toHaveProperty('context');
    expect(init).toHaveBeenNthCalledWith(2, {
      env: 'env-test',
      region: 'ap-shanghai',
      timeout: 15_000,
      context: functionContext
    });
    expect(init.mock.calls[1]?.[0]).not.toHaveProperty('accessKey');
    expect(fakeRdbApp.rdb).toHaveBeenCalledOnce();
    expect(fakeStorageApp.storage.from).toHaveBeenCalledWith('ai-pet-private');
    expect(runtime).toEqual({ rdb: fakeRdb, bucket: fakeBucket });
  });
});

function createFakeApps(): {
  fakeRdbApp: ReturnType<CloudBaseServerSdk['init']>;
  fakeStorageApp: ReturnType<CloudBaseServerSdk['init']>;
  fakeBucket: CloudBaseStorageBucket;
  fakeRdb: CloudBaseRdbClient;
} {
  const fakeRdb = {} as CloudBaseRdbClient;
  const fakeBucket = {} as CloudBaseStorageBucket;
  return {
    fakeRdbApp: {
      rdb: vi.fn(() => fakeRdb),
      storage: { from: vi.fn() }
    } as unknown as ReturnType<CloudBaseServerSdk['init']>,
    fakeStorageApp: {
      rdb: vi.fn(),
      storage: { from: vi.fn(() => fakeBucket) }
    } as unknown as ReturnType<CloudBaseServerSdk['init']>,
    fakeRdb,
    fakeBucket
  };
}
