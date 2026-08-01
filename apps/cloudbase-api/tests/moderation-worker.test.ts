import { describe, expect, it, vi } from 'vitest';

import { createModerationWorker } from '../src/functions/moderation-worker.js';

describe('自动审核定时工作器', () => {
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
