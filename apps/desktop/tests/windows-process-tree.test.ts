import { EventEmitter } from 'node:events';

import { describe, expect, test, vi } from 'vitest';

import {
  createNodeWindowsProcessTreePort,
  terminateExactPidProcessTree
} from '../src/main/agent/windows-process-tree';

class FakeChild extends EventEmitter {
  readonly kill = vi.fn(() => true);

  constructor(readonly pid = 4242) {
    super();
  }
}

describe('Windows 精确 PID 进程树清理', () => {
  test('默认 adapter 只接受精确 PID，taskkill 非零退出码作为失败', async () => {
    expect(createNodeWindowsProcessTreePort).toHaveLength(1);
    const taskkill = new EventEmitter();
    const spawnTaskkill = vi.fn(() => taskkill);
    const port = createNodeWindowsProcessTreePort(spawnTaskkill);

    const killing = port.killTree(4242);
    taskkill.emit('close', 1);

    await expect(killing).rejects.toThrow('TASKKILL_FAILED');
    expect(spawnTaskkill).toHaveBeenCalledWith('taskkill.exe', ['/PID', '4242', '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    });
  });

  test('严格模式不把 child error 当作退出证明', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const termination = terminateExactPidProcessTree({
        child,
        processTreePort: { killTree: async () => undefined },
        cleanupTimeoutMs: 20,
        waitForChildExit: true
      });
      child.emit('error', new Error('fixture child error'));
      await vi.advanceTimersByTimeAsync(20);

      await expect(termination).resolves.toEqual({ ok: false, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});
