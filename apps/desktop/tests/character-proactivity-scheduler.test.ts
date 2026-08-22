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
  reflect?: (input: Readonly<{
    context: ConversationBehaviorContext;
    signal: AbortSignal;
  }>) => Promise<CharacterBehaviorPlan | null>;
}> = {}) {
  let blockers = { ...unblocked };
  let mode = options.mode ?? 'assistive';
  let listener = (): void => undefined;
  const submit = vi.fn<(
    plan: CharacterBehaviorPlan,
    source: 'local-idle' | 'reflection'
  ) => CharacterBehaviorAuthorization>(() => ({
    kind: 'play', actionId: 'blink-action', playbackToken: 'token', semantic: 'idle'
  }));
  const reflection = {
    reflect: vi.fn<(input: Readonly<{
      context: ConversationBehaviorContext;
      signal: AbortSignal;
    }>) => Promise<CharacterBehaviorPlan | null>>(options.reflect ?? (async () => null)),
    close: vi.fn(async () => undefined)
  };
  const director = {
    getChatContext: vi.fn(() => ({ ...context, proactivityMode: mode })),
    getActivityBlockers: vi.fn(() => ({ ...blockers })),
    subscribeActivityBlockers: vi.fn((next: () => void) => {
      listener = next;
      return () => { listener = (): void => undefined; };
    }),
    requestBehaviorPlan: submit
  };
  const scheduler = new CharacterProactivityScheduler({
    director,
    reflection,
    random: options.random ?? (() => 0)
  });
  return {
    director,
    reflection,
    scheduler,
    submit,
    setBlocker(key: keyof CharacterActivityBlockers, value: boolean) {
      blockers = { ...blockers, [key]: value };
      listener();
    },
    setMode(value: ConversationBehaviorContext['proactivityMode']) {
      mode = value;
      listener();
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CharacterProactivityScheduler', () => {
  test('passive 不创建主动计时器，assistive 在 20/60 秒边界只提交原地候选', async () => {
    vi.useFakeTimers();
    const passive = fixture({ mode: 'passive' });
    expect(vi.getTimerCount()).toBe(0);
    await passive.scheduler.close();

    const minimum = fixture({ random: () => 0 });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(minimum.submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(minimum.submit).toHaveBeenCalledWith({
      kind: 'play', target: { kind: 'semantic', semantic: 'idle' }
    }, 'local-idle');
    await minimum.scheduler.close();

    const maximum = fixture({ random: () => 1 });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(maximum.submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(maximum.submit.mock.calls[0]?.[0]).not.toMatchObject({ kind: 'move' });
    await maximum.scheduler.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('autonomous 在 20–60 秒产生原地或短距移动，并在 2–5 分钟触发反思', async () => {
    vi.useFakeTimers();
    const values = [0, 1, 1, 0];
    const current = fixture({ mode: 'autonomous', random: () => values.shift() ?? 0 });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(current.submit.mock.calls[0]?.[0]).toMatchObject({
      kind: 'move', distance: 'near'
    });
    await vi.advanceTimersByTimeAsync(280_000);
    expect(current.reflection.reflect).toHaveBeenCalledOnce();

    await current.scheduler.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(Object.keys(unblocked) as Array<keyof CharacterActivityBlockers>)(
    '%s blocker 暂停并保留剩余时间，恢复时不补跑',
    async key => {
      vi.useFakeTimers();
      const current = fixture();
      await vi.advanceTimersByTimeAsync(10_000);
      current.setBlocker(key, true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(current.submit).not.toHaveBeenCalled();

      current.setBlocker(key, false);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(current.submit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(current.submit).toHaveBeenCalledOnce();
      await current.scheduler.close();
    }
  );

  test('同一动作的连续候选静默跳过并重新排期', async () => {
    vi.useFakeTimers();
    const current = fixture();

    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(current.submit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await current.scheduler.close();
  });

  test('反思失败按 2/4/8/16/30 分钟退避', async () => {
    vi.useFakeTimers();
    const current = fixture({
      mode: 'autonomous',
      reflect: async () => { throw new Error('BEHAVIOR_REFLECTION_PROVIDER_ERROR'); }
    });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(current.reflection.reflect).toHaveBeenCalledTimes(1);
    for (const [index, delay] of [2, 4, 8, 16, 30].entries()) {
      await vi.advanceTimersByTimeAsync(delay * 60_000);
      expect(current.reflection.reflect).toHaveBeenCalledTimes(index + 2);
    }
    await current.scheduler.close();
  });

  test('close 中止进行中的反思并使迟到结果无效', async () => {
    vi.useFakeTimers();
    let resolve!: (value: null) => void;
    const pending = new Promise<null>(done => { resolve = done; });
    const current = fixture({ mode: 'autonomous', reflect: () => pending });

    await vi.advanceTimersByTimeAsync(120_000);
    const signal = current.reflection.reflect.mock.calls[0]![0].signal;
    current.submit.mockClear();
    await current.scheduler.close();
    expect(signal.aborted).toBe(true);
    resolve(null);
    await Promise.resolve();

    expect(current.submit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
