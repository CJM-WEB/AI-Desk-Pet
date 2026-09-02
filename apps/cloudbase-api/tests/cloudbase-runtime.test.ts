import { describe, expect, it, vi } from 'vitest';
import cloudbase from '@cloudbase/js-sdk';

import type { CloudBaseRdbClient } from '../src/adapters/cloudbase-postgres.js';
import {
  createCloudBaseServerRuntime,
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
describe('CloudBase V3 Node 运行时工厂', () => {
  it('已安装 3.6.8 的 rdb 运行时是工厂函数', () => {
    const app = cloudbase.init({
      env: 'env-test',
      context: { eventID: 'runtime-shape-probe' }
    });

    expect(app.rdb).toBeTypeOf('function');
  });

  it('RDB 与私有 Storage 共用同一个服务端 API Key 实例', async () => {
    const { sdk, init, events, rdb, bucket } = createServiceRoleSdk();
    const runtime = createCloudBaseServerRuntime(
      runtimeConfig,
      sdk
    );

    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith({
      env: 'env-test',
      region: 'ap-shanghai',
      timeout: 15_000,
      accessKey: 'server-rdb-access-key'
    });
    expect(init.mock.calls[0]?.[0]).not.toHaveProperty('context');
    expect(events).toEqual([
      'init:service-role',
      'rdb:service-role',
      'bucket:service-role:ai-pet-private'
    ]);
    expect(runtime).toEqual({ rdb, bucket });
    await expect(runtime.bucket.info('submissions/example/package.zip')).resolves.toEqual({
      data: {
        name: 'submissions/example/package.zip',
        size: 1,
        contentType: 'application/zip'
      },
      error: null
    });
  });
});

/** 服务端 API Key 必须同时覆盖 RDB 与私有对象存储，避免第二个 context 实例读对象失败。 */
function createServiceRoleSdk(): {
  sdk: CloudBaseServerSdk;
  init: ReturnType<typeof vi.fn>;
  events: string[];
  rdb: CloudBaseRdbClient;
  bucket: CloudBaseStorageBucket;
} {
  const events: string[] = [];
  const rdb = {} as CloudBaseRdbClient;
  const bucket = {
    bucketId: 'ai-pet-private',
    info: vi.fn(async (path: string) => ({
      data: {
        name: path,
        size: 1,
        contentType: 'application/zip'
      },
      error: null
    }))
  } as unknown as CloudBaseStorageBucket;
  const deniedBucket = {
    bucketId: 'ai-pet-private',
    info: vi.fn(async () => ({
      data: null,
      error: { status: 403 }
    }))
  } as unknown as CloudBaseStorageBucket;
  const init = vi.fn((options: Parameters<CloudBaseServerSdk['init']>[0]) => {
    const identity = 'accessKey' in options ? 'service-role' : 'function-context';
    events.push(`init:${identity}`);
    return {
      rdb: vi.fn(() => {
        events.push(`rdb:${identity}`);
        return rdb;
      }),
      storage: {
        from: vi.fn(bucketId => {
          events.push(`bucket:${identity}:${bucketId}`);
          return identity === 'service-role' ? bucket : deniedBucket;
        })
      }
    } as unknown as ReturnType<CloudBaseServerSdk['init']>;
  });
  return {
    sdk: { init: init as CloudBaseServerSdk['init'] },
    init,
    events,
    rdb,
    bucket
  };
}
