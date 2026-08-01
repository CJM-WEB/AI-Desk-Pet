import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { init } = vi.hoisted(() => ({ init: vi.fn() }));

vi.mock('@cloudbase/js-sdk', () => ({
  default: { init }
}));

describe('CloudBase 浏览器客户端', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    init.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('服务端渲染阶段拒绝初始化浏览器 SDK', async () => {
    vi.stubGlobal('window', undefined);
    const { getCloudBaseClient } = await import('../lib/cloudbase-client');

    expect(() => getCloudBaseClient()).toThrow('CLOUDBASE_BROWSER_ONLY');
    expect(init).not.toHaveBeenCalled();
  });

  it('只使用公开环境变量初始化并复用浏览器单例', async () => {
    const app = { auth: vi.fn() };
    init.mockReturnValue(app);
    vi.stubGlobal('window', {});
    vi.stubEnv('NEXT_PUBLIC_CLOUDBASE_ENV_ID', 'ai-pet-dev');
    vi.stubEnv('NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY', 'publishable-test-key');
    const { getCloudBaseClient } = await import('../lib/cloudbase-client');

    const first = getCloudBaseClient();
    const second = getCloudBaseClient();

    expect(first).toBe(app);
    expect(second).toBe(first);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith({
      env: 'ai-pet-dev',
      region: 'ap-singapore',
      intl: true,
      accessKey: 'publishable-test-key',
      timeout: 15_000
    });
  });

  it('缺少公开环境变量时返回稳定错误', async () => {
    vi.stubGlobal('window', {});
    vi.stubEnv('NEXT_PUBLIC_CLOUDBASE_ENV_ID', '');
    vi.stubEnv('NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY', '');
    const { getCloudBaseClient } = await import('../lib/cloudbase-client');

    expect(() => getCloudBaseClient()).toThrow('CLOUDBASE_BROWSER_CONFIG_REQUIRED');
    expect(init).not.toHaveBeenCalled();
  });
});
