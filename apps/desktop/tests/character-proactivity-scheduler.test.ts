import type {
  CharacterBehaviorAuthorization,
  CharacterBehaviorPlan
} from '@myself/character-runtime';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CharacterProactivityScheduler } from
  '../src/main/characters/character-proactivity-scheduler';
import type {
  CharacterActivityBlockers,
  ConversationBehaviorContext
} from '../src/main/characters/character-behavior-director';

const context: ConversationBehaviorContext = {
  character: {
    characterName: '测试角色',
    semantics: ['idle', 'move'],
    stateNames: ['待机'],
    actionNames: ['眨眼'],
    tags: []
  },
  runtime: { moving: false, dragging: false, carrying: false, movementStopped: false },
  proactivityMode: 'assistive',
  recentActions: []
};

const unblocked: CharacterActivityBlockers = {
  chatting: false,
  dragging: false,
  moving: false,
  capabilityTask: false,
  awaitingConfirmation: false,
  movementStopped: false,
  closed: false
};

function fixture(options: Readonly<{
  mode?: ConversationBehaviorContext['proactivityMode'];
  random?: () => number;
  start?: boolean;
}> = {}) {
  let blockers = { ...unblocked };
  let mode = options.mode ?? 'assistive';
  let listener = (): void => undefined;
  let lifecycleGeneration = 0;
  const submit = vi.fn<(
    plan: CharacterBehaviorPlan,
    source: 'local-idle'
  ) => CharacterBehaviorAuthorization>(() => ({
    kind: 'play', actionId: 'blink-action', playbackToken: 'token', semantic: 'idle'
  }));
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
    requestBehaviorPlan: submit
  };
  const scheduler = new CharacterProactivityScheduler({
    director,
    random: options.random ?? (() => 0)
  });
  if (options.start !== false) scheduler.start();
  return {
    director,
    scheduler,
    submit,
    setBlocker(key: keyof CharacterActivityBlockers, value: boolean) {
      blockers = { ...blockers, [key]: value };
      listener();
    },
    setAutonomousMovementAllowed(value: boolean) {
      blockers = { ...blockers, autonomousMovementAllowed: value };
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
  test('passive 不创建主动计时器，assistive 在 10/30 秒边界只提交原地候选', async () => {
    vi.useFakeTimers();
    const passive = fixture({ mode: 'passive' });
    expect(vi.getTimerCount()).toBe(0);
    await passive.scheduler.close();

    const minimum = fixture({ random: () => 0 });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(minimum.submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(minimum.submit).toHaveBeenCalledWith({
      kind: 'play', target: { kind: 'semantic', semantic: 'idle' }
    }, 'local-idle');
    await minimum.scheduler.close();

    const maximum = fixture({ random: () => 1 });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(maximum.submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(maximum.submit.mock.calls[0]?.[0]).not.toMatchObject({ kind: 'move' });
    await maximum.scheduler.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('autonomous 在每次 10–30 秒到期后都提交当前单屏随机移动', async () => {
    vi.useFakeTimers();
    const values = [0, 0];
    const current = fixture({ mode: 'autonomous', random: () => values.shift() ?? 0 });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(current.submit).toHaveBeenCalledWith({
      kind: 'play', target: { kind: 'semantic', semantic: 'move' }
    }, 'local-idle');
    await current.scheduler.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(Object.keys(unblocked) as Array<keyof CharacterActivityBlockers>)(
    '%s blocker 暂停并保留剩余时间，恢复时不补跑',
    async key => {
      vi.useFakeTimers();
      const current = fixture();
      await vi.advanceTimersByTimeAsync(5_000);
      current.setBlocker(key, true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(current.submit).not.toHaveBeenCalled();

      current.setBlocker(key, false);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(current.submit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(current.submit).toHaveBeenCalledOnce();
      await current.scheduler.close();
    }
  );

  test('自主移动许可关闭后跨 30 秒不会提交候选，重新开启后恢复独立随机周期', async () => {
    vi.useFakeTimers();
    const current = fixture({ mode: 'autonomous', random: () => 0 });

    current.setAutonomousMovementAllowed(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(current.submit).not.toHaveBeenCalled();
    current.setAutonomousMovementAllowed(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(current.submit).toHaveBeenCalledOnce();
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
    expect(current.submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(current.submit).toHaveBeenCalledOnce();
    await current.scheduler.close();
  });

  test('Scheduler 不复制 actionId 状态，连续候选都交给唯一 Service 预检', async () => {
    vi.useFakeTimers();
    const current = fixture();

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(current.submit).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await current.scheduler.close();
  });

  test('模式或生命周期变化会废弃旧计时并重新抽取 10–30 秒', async () => {
    vi.useFakeTimers();
    const current = fixture({ mode: 'autonomous', random: () => 0 });
    await vi.advanceTimersByTimeAsync(9_000);
    current.invalidateLifecycle();
    expect(current.submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(current.submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(current.submit).toHaveBeenCalledOnce();
    current.setMode('passive');
    expect(vi.getTimerCount()).toBe(0);
    await current.scheduler.close();
  });
});
