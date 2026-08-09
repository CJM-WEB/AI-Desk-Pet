import { describe, expect, test, vi } from 'vitest';

import { createExplorerMainComposition } from '../src/main/explorer/explorer-main-wiring';

const readySnapshot = {
  nonce: 'a'.repeat(32),
  sequence: 1,
  status: 'ready' as const,
  instanceId: 'instance-1',
  hwnd: '101',
  foreground: true,
  minimized: false
};

describe('Explorer Main 图层组合', () => {
  test('快照只交给图层协调器，错误只报告稳定码且不隐藏桌宠', async () => {
    const effects: string[] = [];
    let windowVisible = true;
    const composition = createExplorerMainComposition({
      bridge: {
        start: async () => undefined,
        startObserving: async () => ({ ok: true as const }),
        close: async () => undefined
      },
      coordinator: {
        accept: async observation => {
          if (observation && !(observation instanceof Error) && observation.status === 'ready') {
            effects.push(`move:${observation.hwnd}`);
          }
        },
        close: async () => undefined
      },
      showPet: () => { windowVisible = true; },
      reportError: code => effects.push(`error:${code}`)
    });

    await composition.onExplorerSnapshot(readySnapshot);
    await composition.onExplorerSnapshot({ ...readySnapshot, sequence: 2, status: 'none' });
    await composition.onExplorerError(new Error('PRIVATE'));

    expect(effects).toEqual(['move:101', 'error:EXPLORER_BRIDGE_FAILED']);
    expect(windowVisible).toBe(true);
  });

  test('桥接启动失败仍显示普通桌宠并只公开稳定错误码', async () => {
    const showPet = vi.fn();
    const reportError = vi.fn();
    const composition = createExplorerMainComposition({
      bridge: {
        start: async () => { throw new Error('PRIVATE_START'); },
        startObserving: async () => ({ ok: true as const }),
        close: async () => undefined
      },
      coordinator: { accept: async () => undefined, close: async () => undefined },
      showPet,
      reportError
    });

    await expect(composition.start()).resolves.toBeUndefined();
    expect(showPet).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledExactlyOnceWith('EXPLORER_BRIDGE_FAILED');
  });

  test('关闭顺序固定为图层协调器后桥接且可重复调用', async () => {
    const effects: string[] = [];
    const composition = createExplorerMainComposition({
      bridge: {
        start: async () => undefined,
        startObserving: async () => ({ ok: true as const }),
        close: async () => { effects.push('bridge'); }
      },
      coordinator: {
        accept: async () => undefined,
        close: async () => { effects.push('coordinator'); }
      },
      showPet: () => undefined,
      reportError: () => undefined
    });

    await Promise.all([composition.close(), composition.close()]);
    expect(effects).toEqual(['coordinator', 'bridge']);
  });
});
