import { describe, expect, test, vi } from 'vitest';

type ProbeFactory = (options: {
  platform: NodeJS.Platform;
  runFixedProbe(): Promise<string>;
}) => { sample(): Promise<boolean> };

async function loadFactory(): Promise<ProbeFactory | undefined> {
  const module = await import('../src/main/habitat/habitat-window-controller');
  return (module as { createForegroundFullscreenProbe?: ProbeFactory })
    .createForegroundFullscreenProbe;
}

describe('受限前台全屏探针', () => {
  test('Windows 固定适配器只把严格 0/1 结果转换为布尔值', async () => {
    const factory = await loadFactory();
    const trueProbe = factory?.({ platform: 'win32', runFixedProbe: async () => '1\r\n' });
    const falseProbe = factory?.({ platform: 'win32', runFixedProbe: async () => '0\n' });

    expect(await trueProbe?.sample()).toBe(true);
    expect(await falseProbe?.sample()).toBe(false);
  });

  test('非 Windows、执行失败和异常输出都失败关闭为阻止自动藏身', async () => {
    const factory = await loadFactory();
    const run = vi.fn(async () => '0');
    const nonWindows = factory?.({ platform: 'linux', runFixedProbe: run });
    const failed = factory?.({
      platform: 'win32',
      runFixedProbe: async () => { throw new Error('PRIVATE_FOREGROUND'); }
    });
    const malformed = factory?.({ platform: 'win32', runFixedProbe: async () => 'window:123' });

    expect(await nonWindows?.sample()).toBe(true);
    expect(await failed?.sample()).toBe(true);
    expect(await malformed?.sample()).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});
