import { afterEach, describe, expect, test, vi } from 'vitest';
import { CharacterProactivityScheduler } from
  '../src/main/characters/character-proactivity-scheduler';
import type {
  CharacterActivityBlockers,
  ConversationBehaviorContext
} from '../src/main/characters/character-behavior-director';

const context: ConversationBehaviorContext = {
  character: {
    identity: {
      name: '测试角色', description: '测试角色', background: '测试环境', traits: [],
      languageStyle: '简洁', likes: [], behavioralTendencies: []
    },
    states: [{
      stateId: 'idle-state', name: '待机', tags: [],
      actions: [{ actionId: 'blink', name: '眨眼', tags: [] }]
    }]
  },
  runtime: { moving: false, dragging: false, carrying: false, movementMode: 2 },
  proactivityMode: 'assistive',
  recentActions: []
};

const unblocked: CharacterActivityBlockers = {
  chatting: false,
  dragging: false,
  moving: false,
  capabilityTask: false,
  awaitingConfirmation: false,
  movementModeTransition: false,
  movementMode: 2,
  closed: false
};
const booleanBlockerKeys = (Object.keys(unblocked) as Array<keyof CharacterActivityBlockers>)
  .filter((key): key is Exclude<keyof CharacterActivityBlockers, 'movementMode'> => (
    key !== 'movementMode'
  ));

function fixture(options: Readonly<{
  mode?: ConversationBehaviorContext['proactivityMode'];
  random?: () => number;
  start?: boolean;
  reentrantPersistent?: boolean;
  blockOnSubmit?: boolean;
}> = {}) {
  let blockers = { ...unblocked };
  let mode = options.mode ?? 'assistive';
  let listener = (): void => undefined;
  let lifecycleGeneration = 0;
  const requestIntermittentMovement = vi.fn(() => {
    if (options.blockOnSubmit) {
      blockers = { ...blockers, moving: true };
      listener();
    }
  });
  const director = {
    getChatContext: vi.fn(() => ({
      ...context,
      proactivityMode: mode
    })),
    getActivityBlockers: vi.fn(() => ({ ...blockers })),
    subscribeActivityBlockers: vi.fn((next: () => void) => {
      listener = next;
      return () => { listener = (): void => undefined; };
    }),
    getBehaviorLifecycleGeneration: vi.fn(() => lifecycleGeneration),
    requestIntermittentMovement,
    requestPersistentMovement: vi.fn(() => {
      if (options.reentrantPersistent) listener();
    })
  };
  const scheduler = new CharacterProactivityScheduler({
    director,
    random: options.random ?? (() => 0)
  });
  if (options.start !== false) scheduler.start();
  return {
    director,
    scheduler,
    requestIntermittentMovement,
    setBlocker(key: keyof CharacterActivityBlockers, value: boolean) {
      blockers = { ...blockers, [key]: value };
      listener();
    },
    setAutonomousMovementAllowed(value: boolean) {
      blockers = { ...blockers, movementMode: value ? 2 : 0 };
      listener();
    },
    setMovementMode(value: 0 | 1 | 2) {
      blockers = { ...blockers, movementMode: value };
      listener();
    },
    setMode(value: ConversationBehaviorContext['proactivityMode']) {
      mode = value;
      listener();
    },
    invalidateLifecycle() {
      lifecycleGeneration += 1;
      listener();
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CharacterProactivityScheduler', () => {
  test('初始化完成前显式 start 才允许 arm timer', async () => {
    vi.useFakeTimers();
    const current = fixture({ start: false });
    expect(vi.getTimerCount()).toBe(0);
    current.scheduler.start();
    expect(vi.getTimerCount()).toBe(1);
    await current.scheduler.close();
  });
  test('passive 不吞掉用户明确选择的模式 2', async () => {
    vi.useFakeTimers();
    const passive = fixture({ mode: 'passive' });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(passive.requestIntermittentMovement).toHaveBeenCalledOnce();
    await passive.scheduler.close();
  });

  test.each([
    [0, 10_000],
    [0.5, 20_000],
    [1, 30_000]
  ])('assistive 的模式 2 在 random=%s 时等待 %i 毫秒后提交随机工作区移动', async (
    random,
    delay
  ) => {
    vi.useFakeTimers();
    const current = fixture({ mode: 'assistive', random: () => random });

    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(current.requestIntermittentMovement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(current.requestIntermittentMovement).toHaveBeenCalledOnce();

    await current.scheduler.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('autonomous 在每次 10–30 秒到期后都提交当前单屏随机移动', async () => {
    vi.useFakeTimers();
    const values = [0, 0];
    const current = fixture({ mode: 'autonomous', random: () => values.shift() ?? 0 });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(current.requestIntermittentMovement).toHaveBeenCalledOnce();
    await current.scheduler.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(booleanBlockerKeys)(
    '%s blocker 暂停并保留剩余时间，恢复时不补跑',
    async key => {
      vi.useFakeTimers();
      const current = fixture();
      await vi.advanceTimersByTimeAsync(5_000);
      current.setBlocker(key, true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(current.requestIntermittentMovement).not.toHaveBeenCalled();

      current.setBlocker(key, false);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(current.requestIntermittentMovement).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(current.requestIntermittentMovement).toHaveBeenCalledOnce();
      await current.scheduler.close();
    }
  );

  test('持续模式不等待随机时钟并在阻塞解除后请求 Director 续行', async () => {
    vi.useFakeTimers();
    const current = fixture({ mode: 'autonomous' });

    current.setMovementMode(1);
    expect(current.director.requestPersistentMovement).toHaveBeenCalledOnce();
    current.setBlocker('dragging', true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(current.director.requestPersistentMovement).toHaveBeenCalledOnce();
    current.setBlocker('dragging', false);
    expect(current.director.requestPersistentMovement).toHaveBeenCalledTimes(2);
    await current.scheduler.close();
  });

  test('持续模式请求同步发布活动变化时不会递归重入 Scheduler', async () => {
    const current = fixture({ start: false, reentrantPersistent: true });
    current.setMovementMode(1);

    expect(() => current.scheduler.start()).not.toThrow();
    expect(current.director.requestPersistentMovement).toHaveBeenCalledOnce();
    await current.scheduler.close();
  });

  test('自主移动许可关闭后跨 30 秒不会提交候选，重新开启后恢复独立随机周期', async () => {
    vi.useFakeTimers();
    const current = fixture({ mode: 'autonomous', random: () => 0 });

    current.setAutonomousMovementAllowed(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(current.requestIntermittentMovement).not.toHaveBeenCalled();
    current.setAutonomousMovementAllowed(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(current.requestIntermittentMovement).toHaveBeenCalledOnce();
    await current.scheduler.close();
  });

  test('停止锁在已消耗部分周期后丢弃剩余时间，恢复时重新等待完整随机周期', async () => {
    vi.useFakeTimers();
    const current = fixture({ mode: 'autonomous', random: () => 0 });

    await vi.advanceTimersByTimeAsync(9_000);
    current.setAutonomousMovementAllowed(false);
    await vi.advanceTimersByTimeAsync(30_000);
    current.setAutonomousMovementAllowed(true);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(current.requestIntermittentMovement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(current.requestIntermittentMovement).toHaveBeenCalledOnce();
    await current.scheduler.close();
  });

  test('间歇移动结束后才重新等待完整随机周期', async () => {
    vi.useFakeTimers();
    const current = fixture({ blockOnSubmit: true });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(current.requestIntermittentMovement).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(current.requestIntermittentMovement).toHaveBeenCalledOnce();
    current.setBlocker('moving', false);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(current.requestIntermittentMovement).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(current.requestIntermittentMovement).toHaveBeenCalledTimes(2);
    await current.scheduler.close();
  });

  test('0→2→1→2→0 每次切换都撤销旧时钟并只启动目标模式', async () => {
    vi.useFakeTimers();
    const values = [0, 1, 0.5];
    const current = fixture({ start: false, random: () => values.shift() ?? 0 });
    current.setMovementMode(0);
    current.scheduler.start();
    expect(vi.getTimerCount()).toBe(0);

    current.setMovementMode(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(current.requestIntermittentMovement).not.toHaveBeenCalled();

    current.setMovementMode(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(current.requestIntermittentMovement).not.toHaveBeenCalled();
    expect(current.director.requestPersistentMovement).toHaveBeenCalledOnce();

    current.setMovementMode(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(current.requestIntermittentMovement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(current.requestIntermittentMovement).toHaveBeenCalledOnce();

    current.setMovementMode(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(current.requestIntermittentMovement).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await current.scheduler.close();
  });

  test('间歇目标无需移动时也会重新等待完整周期而非永久失活', async () => {
    vi.useFakeTimers();
    const current = fixture({ random: () => 0 });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(current.requestIntermittentMovement).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(current.requestIntermittentMovement).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(current.requestIntermittentMovement).toHaveBeenCalledTimes(2);
    await current.scheduler.close();
  });

  test('生命周期变化重抽周期，但普通主动性设置不终止显式模式 2', async () => {
    vi.useFakeTimers();
    const current = fixture({ mode: 'autonomous', random: () => 0 });
    await vi.advanceTimersByTimeAsync(9_000);
    current.invalidateLifecycle();
    expect(current.requestIntermittentMovement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(current.requestIntermittentMovement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(current.requestIntermittentMovement).toHaveBeenCalledOnce();
    current.setMode('passive');
    expect(vi.getTimerCount()).toBe(1);
    await current.scheduler.close();
  });
});
