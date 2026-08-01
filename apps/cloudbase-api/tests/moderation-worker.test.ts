import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createModerationWorker,
  createProductionWorker
} from '../src/functions/moderation-worker.js';
import {
  createFakeRuntime,
  stubCloudConfig
} from './support/cloudbase-production.js';

const productionSdk = vi.hoisted(() => ({
  createRuntime: vi.fn()
}));

vi.mock('../src/adapters/cloudbase-runtime.js', () => ({
  createCloudBaseServerRuntime: productionSdk.createRuntime
}));

beforeEach(() => {
  productionSdk.createRuntime.mockReturnValue(createFakeRuntime());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('自动审核定时工作器', () => {
  it('无需 AI 环境变量即可创建生产工作器', () => {
    stubCloudConfig();

    const worker = createProductionWorker();

    expect(productionSdk.createRuntime).toHaveBeenCalledTimes(1);
    expect(productionSdk.createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ envId: 'env-test' })
    );
    expect(worker).toBeTypeOf('function');
  });

  it('每次只请求处理三个任务并返回裁剪统计', async () => {
    const processNextBatch = vi.fn().mockResolvedValue({
      claimed: 3,
      succeeded: 2,
      failed: 1,
      secret: '不得返回'
    });
    const worker = createModerationWorker({ processNextBatch });

    await expect(worker()).resolves.toEqual({
      claimed: 3,
      succeeded: 2,
      failed: 1
    });
    expect(processNextBatch).toHaveBeenCalledWith(3);
  });
});
