import type { Rectangle } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HabitatWindowController,
  type HabitatExplorerObservation
} from '../src/main/habitat/habitat-window-controller';

const NOW = 5_000;

function observation(
  overrides: Partial<HabitatExplorerObservation> = {}
): HabitatExplorerObservation {
  return {
    instanceId: 'explorer-instance-1',
    sequence: 1,
    explorerHwnd: '43210',
    explorerBounds: { x: -1600, y: -40, width: 1400, height: 1000 },
    observedAt: NOW,
    foreground: true,
    minimized: false,
    localOffset: { x: 500, y: 500 },
    ...overrides
  };
}

function createFixture(options: {
  workAreas?: readonly Rectangle[];
  isCurrentExplorerWindow?: (hwnd: string, instanceId: string) => boolean | Promise<boolean>;
} = {}) {
  const events: string[] = [];
  let destroyed = false;
  let alwaysOnTop = false;
  let bounds: Rectangle = { x: 0, y: 0, width: 180, height: 220 };
  let closedListener: (() => void) | undefined;
  const window = {
    getBounds: vi.fn(() => ({ ...bounds })),
    setPosition: vi.fn((x: number, y: number) => {
      events.push(`position:${x},${y}`);
      bounds = { ...bounds, x, y };
    }),
    setAlwaysOnTop: vi.fn((value: boolean) => {
      events.push(`topmost:${value}`);
      alwaysOnTop = value;
    }),
    isAlwaysOnTop: vi.fn(() => alwaysOnTop),
    isDestroyed: vi.fn(() => destroyed),
    hide: vi.fn(() => events.push('hide')),
    showInactive: vi.fn(() => events.push('show')),
    once: vi.fn((_name: 'closed', listener: () => void) => {
      closedListener = listener;
    }),
    removeListener: vi.fn()
  };
  const layer = {
    activate: vi.fn(async ({ explorerHwnd }: { explorerHwnd: string }) => {
      events.push(`activate:${explorerHwnd}`);
    }),
    invalidate: vi.fn(async (reason: string) => {
      events.push(`invalidate:${reason}`);
    }),
    dispose: vi.fn(async () => {
      events.push('dispose-layer');
    })
  };
  const motion = {
    setSuspended: vi.fn((value: boolean) => events.push(`suspended:${value}`)),
    setMovementRegions: vi.fn((regions: readonly Rectangle[] | null) => {
      events.push(`regions:${regions === null ? 'desktop' : regions.length}`);
    })
  };
  const interaction = {
    setPassthrough: vi.fn((value: boolean) => events.push(`passthrough:${value}`))
  };
  const position = {
    setPersistenceMode: vi.fn((mode: string) => events.push(`persistence:${mode}`))
  };
  const currentExplorer = options.isCurrentExplorerWindow ?? (() => true);
  const controller = new HabitatWindowController({
    window,
    layer,
    motion,
    interaction,
    position,
    getWorkAreas: () => options.workAreas ?? [
      { x: -1920, y: 0, width: 1920, height: 1040 },
      { x: 0, y: 0, width: 1920, height: 1040 }
    ],
    isCurrentExplorerWindow: currentExplorer,
    now: () => NOW
  });

  return {
    controller,
    events,
    interaction,
    layer,
    motion,
    position,
    window,
    setDestroyed(value: boolean) {
      destroyed = value;
    },
    closeWindow() {
      destroyed = true;
      closedListener?.();
    }
  };
}

describe('HabitatWindowController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('交互临时提升在主动结束或固定上限后恢复普通层级', () => {
    const fixture = createFixture();

    const finish = fixture.controller.beginInteraction();
    expect(fixture.controller.getMode()).toBe('interaction-raised');
    expect(fixture.window.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'floating');
    finish();
    expect(fixture.controller.getMode()).toBe('desktop-idle');
    expect(fixture.window.setAlwaysOnTop).toHaveBeenLastCalledWith(false);

    fixture.controller.beginInteraction();
    vi.advanceTimersByTime(9_999);
    expect(fixture.controller.getMode()).toBe('interaction-raised');
    vi.advanceTimersByTime(1);
    expect(fixture.controller.getMode()).toBe('desktop-idle');
    expect(fixture.window.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
  });

  it('旧交互的结束回调不会降低更新交互，窗口销毁后定时器不触碰窗口', () => {
    const fixture = createFixture();
    const finishOld = fixture.controller.beginInteraction();
    fixture.controller.beginInteraction();
    finishOld();
    expect(fixture.controller.getMode()).toBe('interaction-raised');

    fixture.window.setAlwaysOnTop.mockClear();
    fixture.setDestroyed(true);
    vi.advanceTimersByTime(10_000);
    expect(fixture.window.setAlwaysOnTop).not.toHaveBeenCalled();
  });

  it('目录可见时先设置安全负坐标，再建立 Explorer 相邻层级', async () => {
    const fixture = createFixture();

    await fixture.controller.showFolder(observation());

    expect(fixture.motion.setMovementRegions).toHaveBeenLastCalledWith([
      { x: -1600, y: 0, width: 1400, height: 960 }
    ]);
    expect(fixture.window.setPosition).toHaveBeenCalledExactlyOnceWith(-1100, 460);
    expect(fixture.events.indexOf('position:-1100,460'))
      .toBeLessThan(fixture.events.indexOf('activate:43210'));
    expect(fixture.events.indexOf('show'))
      .toBeLessThan(fixture.events.indexOf('activate:43210'));
    expect(fixture.window.setAlwaysOnTop).toHaveBeenCalledWith(false);
    expect(fixture.layer.activate).toHaveBeenCalledExactlyOnceWith({ explorerHwnd: '43210' });
    expect(fixture.controller.getMode()).toBe('folder-visible');
    expect(fixture.motion.setSuspended).toHaveBeenLastCalledWith(false);
    expect(fixture.position.setPersistenceMode).toHaveBeenLastCalledWith('folder');
  });

  it('目录隐藏会同步隐藏窗口、暂停运动并恢复鼠标穿透安全态', async () => {
    const fixture = createFixture();
    await fixture.controller.showFolder(observation());
    fixture.events.splice(0);

    await fixture.controller.hideFolder();

    expect(fixture.events[0]).toBe('hide');
    expect(fixture.motion.setSuspended).toHaveBeenLastCalledWith(true);
    expect(fixture.interaction.setPassthrough).toHaveBeenLastCalledWith(true);
    expect(fixture.position.setPersistenceMode).toHaveBeenLastCalledWith('disabled');
    expect(fixture.layer.invalidate).toHaveBeenLastCalledWith('leave');
    expect(fixture.controller.getMode()).toBe('folder-hidden');
  });

  it('Explorer 失焦与观察超时都先隐藏再 invalidate，且超时不超过 1000ms', async () => {
    const fixture = createFixture();
    await fixture.controller.showFolder(observation());
    fixture.events.splice(0);

    vi.advanceTimersByTime(999);
    expect(fixture.controller.getMode()).toBe('folder-visible');
    vi.advanceTimersByTime(1);
    await vi.runAllTimersAsync();

    expect(fixture.events.indexOf('hide'))
      .toBeLessThan(fixture.events.indexOf('invalidate:tab-race'));
    expect(fixture.controller.getMode()).toBe('lost');
    expect(fixture.window.setAlwaysOnTop).toHaveBeenLastCalledWith(false);

    await fixture.controller.showFolder(observation({ sequence: 2 }));
    fixture.events.splice(0);
    await fixture.controller.loseExplorer('explorer-blurred');
    expect(fixture.events.indexOf('hide'))
      .toBeLessThan(fixture.events.indexOf('invalidate:explorer-blurred'));
  });

  it.each([
    ['零句柄', { explorerHwnd: '0' }],
    ['非规范句柄', { explorerHwnd: '043210' }],
    ['失焦', { foreground: false }],
    ['最小化', { minimized: true }],
    ['陈旧观察', { observedAt: NOW - 1_001 }]
  ])('拒绝%s并失败关闭', async (_label, overrides) => {
    const fixture = createFixture();

    await expect(fixture.controller.showFolder(observation(overrides)))
      .rejects.toThrow('HABITAT_EXPLORER_UNSAFE');

    expect(fixture.window.setPosition).not.toHaveBeenCalled();
    expect(fixture.layer.activate).not.toHaveBeenCalled();
    expect(fixture.window.hide).toHaveBeenCalled();
    expect(fixture.window.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
  });

  it('拒绝旧 Explorer 或其他进程 HWND，且对激活前后的身份变化失败关闭', async () => {
    const current = vi.fn<(hwnd: string) => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const fixture = createFixture({ isCurrentExplorerWindow: current });

    await expect(fixture.controller.showFolder(observation()))
      .rejects.toThrow('HABITAT_EXPLORER_UNSAFE');

    expect(current).toHaveBeenCalledTimes(2);
    expect(fixture.layer.activate).toHaveBeenCalledOnce();
    expect(fixture.window.hide).toHaveBeenCalled();
    expect(fixture.window.showInactive).toHaveBeenCalledOnce();
    expect(fixture.events.indexOf('show')).toBeLessThan(fixture.events.indexOf('hide'));

    const otherProcess = createFixture({ isCurrentExplorerWindow: () => false });
    await expect(otherProcess.controller.showFolder(observation({ explorerHwnd: '99999' })))
      .rejects.toThrow('HABITAT_EXPLORER_UNSAFE');
    expect(otherProcess.layer.activate).not.toHaveBeenCalled();
  });

  it('拒绝同一 Explorer 实例的旧序列回放', async () => {
    const fixture = createFixture();
    await fixture.controller.showFolder(observation({ sequence: 8 }));
    fixture.window.setPosition.mockClear();
    fixture.layer.activate.mockClear();

    await expect(fixture.controller.showFolder(observation({ sequence: 7 })))
      .rejects.toThrow('HABITAT_EXPLORER_UNSAFE');

    expect(fixture.window.setPosition).not.toHaveBeenCalled();
    expect(fixture.layer.activate).not.toHaveBeenCalled();
    expect(fixture.controller.getMode()).toBe('lost');
  });

  it('并发新观察取代旧转换，旧完成不得隐藏已生效窗口', async () => {
    const fixture = createFixture();
    let releaseOld: (() => void) | undefined;
    fixture.layer.activate
      .mockImplementationOnce(() => new Promise<void>(resolve => {
        releaseOld = resolve;
      }))
      .mockResolvedValueOnce();

    const oldTransition = fixture.controller.showFolder(observation({ sequence: 1 }));
    await vi.waitFor(() => expect(releaseOld).toBeTypeOf('function'));
    await fixture.controller.showFolder(observation({ sequence: 2 }));
    fixture.window.hide.mockClear();
    fixture.layer.invalidate.mockClear();

    releaseOld?.();
    await expect(oldTransition).rejects.toThrow('HABITAT_TRANSITION_SUPERSEDED');

    expect(fixture.controller.getMode()).toBe('folder-visible');
    expect(fixture.window.hide).not.toHaveBeenCalled();
    expect(fixture.layer.invalidate).not.toHaveBeenCalled();
  });

  it('拒绝已销毁桌宠窗口，不写坐标也不激活层级', async () => {
    const fixture = createFixture();
    fixture.setDestroyed(true);

    await expect(fixture.controller.showFolder(observation()))
      .rejects.toThrow('HABITAT_WINDOW_DESTROYED');

    expect(fixture.window.setPosition).not.toHaveBeenCalled();
    expect(fixture.layer.activate).not.toHaveBeenCalled();
    expect(fixture.window.hide).not.toHaveBeenCalled();
  });

  it.each([
    ['top', { x: 0, y: 40, width: 1920, height: 1040 }],
    ['bottom', { x: 0, y: 0, width: 1920, height: 1040 }],
    ['left', { x: 40, y: 0, width: 1880, height: 1080 }],
    ['right', { x: 0, y: 0, width: 1880, height: 1080 }]
  ] as const)('任务栏位于%s时使用实时工作区重算目录运动区域', async (_edge, workArea) => {
    const fixture = createFixture({ workAreas: [workArea] });

    await fixture.controller.showFolder(observation({
      explorerBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      localOffset: { x: 2_000, y: 2_000 }
    }));

    expect(fixture.motion.setMovementRegions).toHaveBeenLastCalledWith([workArea]);
    expect(fixture.window.setPosition).toHaveBeenLastCalledWith(
      workArea.x + workArea.width - 180,
      workArea.y + workArea.height - 220
    );
  });

  it('Explorer 移动或 DPI/显示器工作区变化时只重算纯矩形区域与安全坐标', async () => {
    let workAreas: readonly Rectangle[] = [
      { x: -1920, y: 0, width: 1920, height: 1040 }
    ];
    const fixture = createFixture({ get workAreas() { return workAreas; } });
    await fixture.controller.showFolder(observation());

    workAreas = [{ x: 0, y: 48, width: 2560, height: 1392 }];
    await fixture.controller.showFolder(observation({
      sequence: 2,
      explorerBounds: { x: 200, y: 20, width: 1800, height: 1200 },
      localOffset: { x: 1700, y: 1100 }
    }));

    expect(fixture.motion.setMovementRegions).toHaveBeenLastCalledWith([
      { x: 200, y: 48, width: 1800, height: 1172 }
    ]);
    expect(fixture.window.setPosition).toHaveBeenLastCalledWith(1820, 1000);
    expect(fixture.window.setAlwaysOnTop.mock.calls.every(([value]) => value === false))
      .toBe(true);
  });

  it('moveAbove 失败后不残留可见、透明可交互或 topmost 窗口', async () => {
    const fixture = createFixture();
    fixture.layer.activate.mockRejectedValueOnce(new Error('native failure'));

    await expect(fixture.controller.showFolder(observation()))
      .rejects.toThrow('native failure');

    expect(fixture.window.hide).toHaveBeenCalled();
    expect(fixture.window.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(fixture.motion.setSuspended).toHaveBeenLastCalledWith(true);
    expect(fixture.interaction.setPassthrough).toHaveBeenLastCalledWith(true);
    expect(fixture.controller.getMode()).toBe('lost');
  });
});
