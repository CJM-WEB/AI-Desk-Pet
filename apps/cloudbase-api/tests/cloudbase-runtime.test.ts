import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import type { CloudBaseRdbClient } from '../src/adapters/cloudbase-postgres.js';
import type { CloudBaseStorageBucket } from '../src/adapters/cloudbase-storage.js';
import {
  createCloudBaseServerRuntime,
  type CloudBaseServerSdk
} from '../src/adapters/cloudbase-runtime.js';
import type { CloudConfig } from '../src/config.js';

const validConfig: CloudConfig = {
  envId: 'env-test',
  cloudbaseRegion: 'ap-singapore',
  cloudbaseSdkTimeoutMs: 15_000,
  cloudbaseApiKey: 'service-role-key',
  privateBucketId: 'ai-pet-private',
  adminEmail: 'admin@example.com',
  abuseHmacSecret: 'abuse-hmac-secret',
  tencentCloudSecretId: 'secret-id',
  tencentCloudSecretKey: 'secret-key',
  moderationRegion: 'ap-shanghai',
  tmsBizType: 'ai-pet-text',
  imsBizType: 'ai-pet-image',
  scannerUrl: 'https://scanner.example.com',
  scannerHmacSecret: 'scanner-secret',
  sharedPackageSubmissionsEnabled: false
};

describe('CloudBase V3 服务端运行时工厂', () => {
  it('生产运行时使用 Node 后端 SDK 而不是浏览器 SDK', () => {
    const source = readFileSync(
      new URL('../src/adapters/cloudbase-runtime.ts', import.meta.url),
      'utf8'
    );

    expect(source).toContain("from '@cloudbase/node-sdk'");
    expect(source).not.toContain("from '@cloudbase/js-sdk'");
  });

  it('使用配置环境、新加坡地域和有界超时只初始化一次', () => {
    const { fakeApp, fakeBucket, fakeRdb } = createFakeApp();
    const init = vi.fn(() => fakeApp);
    const runtime = createCloudBaseServerRuntime(validConfig, {
      init
    });

    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith({
      env: 'env-test',
      region: 'ap-singapore',
      timeout: 15_000,
      accessKey: 'service-role-key'
    });
    expect(runtime).toEqual({
      rdb: fakeRdb,
      bucket: fakeBucket
    });
  });

  it('服务端初始化使用 service_role API Key', () => {
    const { fakeApp } = createFakeApp();
    const fakeSdk: CloudBaseServerSdk = {
      init: vi.fn(() => fakeApp)
    };

    createCloudBaseServerRuntime(validConfig, fakeSdk);

    expect(fakeSdk.init).toHaveBeenCalledWith(
      expect.objectContaining({ accessKey: 'service-role-key' })
    );
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
    },
    fakeRdb,
    fakeBucket
  };
}
