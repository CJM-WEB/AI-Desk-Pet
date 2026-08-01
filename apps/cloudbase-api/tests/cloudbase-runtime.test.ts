import { describe, expect, it, vi } from 'vitest';

import type { CloudBaseAuthClient } from '../src/adapters/cloudbase-auth.js';
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
  captchaAppId: 10001,
  captchaSecretKey: 'captcha-secret',
  abuseHmacSecret: 'abuse-hmac-secret',
  tencentCloudSecretId: 'secret-id',
  tencentCloudSecretKey: 'secret-key',
  moderationRegion: 'ap-shanghai',
  tmsBizType: 'ai-pet-text',
  imsBizType: 'ai-pet-image',
  scannerUrl: 'https://scanner.example.com',
  scannerHmacSecret: 'scanner-secret'
};

describe('CloudBase V3 服务端运行时工厂', () => {
  it('使用当前环境、新加坡地域和有界超时只初始化一次', () => {
    const { fakeApp, fakeAuth, fakeBucket, fakeRdb } = createFakeApp();
    const init = vi.fn(() => fakeApp);
    const runtime = createCloudBaseServerRuntime(validConfig, {
      init,
      currentEnv: Symbol('current-env')
    });

    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith({
      env: expect.any(Symbol),
      region: 'ap-singapore',
      timeout: 15_000
    });
    expect(runtime).toEqual({
      rdb: fakeRdb,
      bucket: fakeBucket,
      auth: fakeAuth
    });
  });

  it('服务端初始化不接受 API Key 或 Publishable Key', () => {
    const { fakeApp } = createFakeApp();
    const fakeSdk: CloudBaseServerSdk = {
      init: vi.fn(() => fakeApp),
      currentEnv: Symbol('current-env')
    };

    createCloudBaseServerRuntime(validConfig, fakeSdk);

    expect(fakeSdk.init).not.toHaveBeenCalledWith(
      expect.objectContaining({ accessKey: expect.anything() })
    );
  });
});

function createFakeApp(): {
  fakeApp: ReturnType<CloudBaseServerSdk['init']>;
  fakeAuth: CloudBaseAuthClient;
  fakeBucket: CloudBaseStorageBucket;
  fakeRdb: CloudBaseRdbClient;
} {
  const fakeRdb = {} as CloudBaseRdbClient;
  const fakeBucket = {} as CloudBaseStorageBucket;
  const fakeAuth = {} as CloudBaseAuthClient;
  return {
    fakeApp: {
      rdb: vi.fn(() => fakeRdb),
      storage: { from: vi.fn(() => fakeBucket) },
      auth: vi.fn(() => fakeAuth)
    },
    fakeRdb,
    fakeBucket,
    fakeAuth
  };
}
