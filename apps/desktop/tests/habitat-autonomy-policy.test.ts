import { describe, expect, test, vi } from 'vitest';
import type { PetHabitatSnapshot } from '../src/main/habitat/pet-habitat-store';
import { createForegroundFullscreenBlocker } from
  '../src/main/habitat/habitat-main-lifecycle';

type HabitatAutonomyPolicyModule = {
  HabitatAutonomyPolicy: new (options: {
    enterDirectory(directoryId: string, reason: 'automatic'): Promise<unknown>;
    recallToDesktop(): Promise<unknown>;
    recordFailure(code: string): void;
    now(): number;
    random(): number;
    cooldownMs: number;
  }) => {
    tick(input: {
      snapshot: PetHabitatSnapshot;
      proactivityMode: 'passive' | 'assistive' | 'autonomous';
      idle: boolean;
      habitatState: 'desktop' | 'folder-hidden' | 'folder-visible' | 'folder-lost';
      blockers: {
        taskActive: boolean;
        confirmationPending: boolean;
        chatInteracting: boolean;
        dragging: boolean;
        characterSwitching: boolean;
        foregroundFullscreen: boolean;
        appQuitting: boolean;
        bridgeDegraded: boolean;
      };
    }, sampleForegroundFullscreen?: () => Promise<boolean>): Promise<
      | { kind: 'entered'; directoryId: string }
      | { kind: 'failed'; code: string }
      | { kind: 'skipped'; reason: string }
    >;
  };
};

async function loadPolicyModule(): Promise<HabitatAutonomyPolicyModule | null> {
  try {
    return await import(new URL(
      '../src/main/habitat/habitat-autonomy-policy.ts',
      import.meta.url
    ).href) as HabitatAutonomyPolicyModule;
  } catch {
    return null;
  }
}

function snapshot(overrides: Partial<PetHabitatSnapshot> = {}): PetHabitatSnapshot {
  return {
    version: 1,
    preferences: {
      enabled: false,
      autoHideEnabled: false,
      idleDelayMs: 30_000
    },
    directories: [],
    location: { kind: 'desktop', position: null },
    ...overrides
  };
}

function enabledSnapshot(): PetHabitatSnapshot {
  return snapshot({
    preferences: {
      enabled: true,
      autoHideEnabled: true,
      idleDelayMs: 30_000
    },
    directories: [{
      id: 'directory-a',
      displayName: '目录 A',
      pathHint: 'A',
      absolutePath: 'C:\\Private\\A',
      identity: { dev: '1', ino: '1' },
      enabled: true
    }]
  });
}

const noBlockers = {
  taskActive: false,
  confirmationPending: false,
  chatInteracting: false,
  dragging: false,
  characterSwitching: false,
  foregroundFullscreen: false,
  appQuitting: false,
  bridgeDegraded: false
};

function createPolicy(module: HabitatAutonomyPolicyModule, now = () => 0) {
  const enterDirectory = vi.fn(async () => undefined);
  const recallToDesktop = vi.fn(async () => undefined);
  const recordFailure = vi.fn();
  return {
    policy: new module.HabitatAutonomyPolicy({
      enterDirectory,
      recallToDesktop,
      recordFailure,
      now,
      random: () => 0,
      cooldownMs: 60_000
    }),
    enterDirectory,
    recallToDesktop,
    recordFailure
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

describe('Main 自动藏身策略', () => {
  test('唯一 idleDelay 到点后才采样，并在 5000ms 当次允许策略进入', async () => {
    const module = await loadPolicyModule();
    expect(module).not.toBeNull();
    if (!module) return;
    let now = 0;
    let samples = 0;
    const harness = createPolicy(module, () => now);
    const foreground = createForegroundFullscreenBlocker({
      sample: async () => { samples += 1; return false; },
      close: async () => undefined
    });
    const input = {
      snapshot: snapshot({
        preferences: { enabled: true, autoHideEnabled: true, idleDelayMs: 5_000 },
        directories: enabledSnapshot().directories
      }),
      proactivityMode: 'autonomous' as const,
      idle: true,
      habitatState: 'desktop' as const,
      blockers: noBlockers
    };
    const sampleForeground = () => foreground.sampleIfEligible(true);

    await expect(harness.policy.tick(input, sampleForeground)).resolves.toEqual({
      kind: 'skipped', reason: 'idle-delay'
    });
    now = 4_999;
    await expect(harness.policy.tick(input, sampleForeground)).resolves.toEqual({
      kind: 'skipped', reason: 'idle-delay'
    });
    expect(samples).toBe(0);
    now = 5_000;
    await expect(harness.policy.tick(input, sampleForeground)).resolves.toEqual({
      kind: 'entered', directoryId: 'directory-a'
    });
    expect(samples).toBe(1);
    expect(harness.enterDirectory).toHaveBeenCalledOnce();
  });

  test('默认关闭时不触发目录进入', async () => {
    const module = await loadPolicyModule();
    expect(module, '应提供独立的 Main 自动藏身策略').not.toBeNull();
    if (!module) return;
    const harness = createPolicy(module);

    const result = await harness.policy.tick({
      snapshot: snapshot(),
      proactivityMode: 'autonomous',
      idle: true,
      habitatState: 'desktop',
      blockers: noBlockers
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'disabled' });
    expect(harness.enterDirectory).not.toHaveBeenCalled();
  });

  test.each([
    ['被动模式', { proactivityMode: 'passive' as const }, 'proactivity-mode'],
    ['辅助模式', { proactivityMode: 'assistive' as const }, 'proactivity-mode'],
    ['无启用目录', {
      snapshot: snapshot({
        preferences: { enabled: true, autoHideEnabled: true, idleDelayMs: 30_000 }
      })
    }, 'no-directory'],
    ['不在桌面', { habitatState: 'folder-hidden' as const }, 'not-desktop']
  ])('%s 不启动自动进入', async (_label, override, reason) => {
    const module = await loadPolicyModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const harness = createPolicy(module);

    const result = await harness.policy.tick({
      snapshot: enabledSnapshot(),
      proactivityMode: 'autonomous',
      idle: true,
      habitatState: 'desktop',
      blockers: noBlockers,
      ...override
    });

    expect(result).toEqual({ kind: 'skipped', reason });
    expect(harness.enterDirectory).not.toHaveBeenCalled();
  });

  test('连续空闲达到配置阈值后才进入启用目录', async () => {
    const module = await loadPolicyModule();
    expect(module).not.toBeNull();
    if (!module) return;
    let currentTime = 1_000;
    const harness = createPolicy(module, () => currentTime);
    const input = {
      snapshot: enabledSnapshot(),
      proactivityMode: 'autonomous' as const,
      idle: true,
      habitatState: 'desktop' as const,
      blockers: noBlockers
    };

    await expect(harness.policy.tick(input)).resolves.toEqual({
      kind: 'skipped', reason: 'idle-delay'
    });
    currentTime = 30_999;
    await expect(harness.policy.tick(input)).resolves.toEqual({
      kind: 'skipped', reason: 'idle-delay'
    });
    currentTime = 31_000;
    await expect(harness.policy.tick(input)).resolves.toEqual({
      kind: 'entered', directoryId: 'directory-a'
    });

    expect(harness.enterDirectory).toHaveBeenCalledOnce();
    expect(harness.enterDirectory).toHaveBeenCalledWith('directory-a', 'automatic');
  });

  test.each(Object.keys(noBlockers) as Array<keyof typeof noBlockers>)(
    '%s 阻止自动进入并重置连续空闲计时',
    async blocker => {
      const module = await loadPolicyModule();
      expect(module).not.toBeNull();
      if (!module) return;
      let currentTime = 0;
      const harness = createPolicy(module, () => currentTime);
      const input = {
        snapshot: enabledSnapshot(),
        proactivityMode: 'autonomous' as const,
        idle: true,
        habitatState: 'desktop' as const,
        blockers: noBlockers
      };

      await harness.policy.tick(input);
      currentTime = 30_000;
      await expect(harness.policy.tick({
        ...input,
        blockers: { ...noBlockers, [blocker]: true }
      })).resolves.toEqual({ kind: 'skipped', reason: 'blocked' });
      currentTime = 60_000;
      await expect(harness.policy.tick(input)).resolves.toEqual({
        kind: 'skipped', reason: 'idle-delay'
      });
      currentTime = 90_000;
      await expect(harness.policy.tick(input)).resolves.toEqual({
        kind: 'entered', directoryId: 'directory-a'
      });
    }
  );

  test('候选只取启用配置，并受冷却和连续同目录抑制', async () => {
    const module = await loadPolicyModule();
    expect(module).not.toBeNull();
    if (!module) return;
    let currentTime = 0;
    const enterDirectory = vi.fn(async () => undefined);
    const policy = new module.HabitatAutonomyPolicy({
      enterDirectory,
      recallToDesktop: vi.fn(async () => undefined),
      recordFailure: vi.fn(),
      now: () => currentTime,
      random: () => 0.99,
      cooldownMs: 60_000
    });
    const configured = enabledSnapshot();
    configured.directories = [
      { ...configured.directories[0]!, id: 'disabled', enabled: false },
      { ...configured.directories[0]!, id: 'directory-b' },
      { ...configured.directories[0]!, id: 'directory-c' }
    ];
    const activeInput = {
      snapshot: configured,
      proactivityMode: 'autonomous' as const,
      idle: true,
      habitatState: 'desktop' as const,
      blockers: noBlockers
    };

    await policy.tick(activeInput);
    currentTime = 30_000;
    await expect(policy.tick(activeInput)).resolves.toEqual({
      kind: 'entered', directoryId: 'directory-c'
    });
    currentTime = 40_000;
    await policy.tick({ ...activeInput, idle: false });
    await policy.tick(activeInput);
    currentTime = 70_000;
    await expect(policy.tick(activeInput)).resolves.toEqual({
      kind: 'skipped', reason: 'cooldown'
    });
    currentTime = 100_000;
    await expect(policy.tick(activeInput)).resolves.toEqual({
      kind: 'entered', directoryId: 'directory-b'
    });

    expect(enterDirectory.mock.calls).toEqual([
      ['directory-c', 'automatic'],
      ['directory-b', 'automatic']
    ]);
  });

  test.each([
    ['NaN', Number.NaN, 'directory-a'],
    ['正无穷', Number.POSITIVE_INFINITY, 'directory-a'],
    ['负无穷', Number.NEGATIVE_INFINITY, 'directory-a'],
    ['负数', -0.5, 'directory-a'],
    ['上界 1', 1, 'directory-b']
  ])('random 返回%s时稳定夹紧或回退，不向策略外抛错', async (_label, random, directoryId) => {
    const module = await loadPolicyModule();
    expect(module).not.toBeNull();
    if (!module) return;
    const enterDirectory = vi.fn(async () => undefined);
    const policy = new module.HabitatAutonomyPolicy({
      enterDirectory,
      recallToDesktop: vi.fn(async () => undefined),
      recordFailure: vi.fn(),
      now: () => 0,
      random: () => random,
      cooldownMs: 0
    });
    const configured = enabledSnapshot();
    configured.preferences.idleDelayMs = 0;
    configured.directories.push({
      ...configured.directories[0]!,
      id: 'directory-b'
    });

    await expect(policy.tick({
      snapshot: configured,
      proactivityMode: 'autonomous',
      idle: true,
      habitatState: 'desktop',
      blockers: noBlockers
    })).resolves.toEqual({ kind: 'entered', directoryId });
    expect(enterDirectory).toHaveBeenCalledWith(directoryId, 'automatic');
  });

  test('自动进入未完成时后续 tick 不启动第二个目录事务', async () => {
    const module = await loadPolicyModule();
    expect(module).not.toBeNull();
    if (!module) return;
    let currentTime = 0;
    const entering = deferred<void>();
    const enterDirectory = vi.fn(() => entering.promise);
    const policy = new module.HabitatAutonomyPolicy({
      enterDirectory,
      recallToDesktop: vi.fn(async () => undefined),
      recordFailure: vi.fn(),
      now: () => currentTime,
      random: () => 0,
      cooldownMs: 0
    });
    const configured = enabledSnapshot();
    configured.preferences.idleDelayMs = 1_000;
    configured.directories.push({
      ...configured.directories[0]!,
      id: 'directory-b'
    });
    const input = {
      snapshot: configured,
      proactivityMode: 'autonomous' as const,
      idle: true,
      habitatState: 'desktop' as const,
      blockers: noBlockers
    };

    await policy.tick(input);
    currentTime = 1_000;
    const first = policy.tick(input);
    await vi.waitFor(() => expect(enterDirectory).toHaveBeenCalledOnce());
    currentTime = 2_000;

    await expect(policy.tick(input)).resolves.toEqual({
      kind: 'skipped', reason: 'busy'
    });
    expect(enterDirectory).toHaveBeenCalledOnce();

    entering.resolve();
    await expect(first).resolves.toEqual({
      kind: 'entered', directoryId: 'directory-a'
    });
  });

  test.each([
    ['稳定错误', Object.assign(new Error('HABITAT_DIRECTORY_UNAVAILABLE'), {
      code: 'HABITAT_DIRECTORY_UNAVAILABLE'
    }), 'HABITAT_DIRECTORY_UNAVAILABLE'],
    ['私有错误', new Error('C:\\Private\\A failed'), 'HABITAT_OPERATION_FAILED']
  ])('自动进入%s时只记录稳定码并召回 desktop', async (_label, failure, code) => {
    const module = await loadPolicyModule();
    expect(module).not.toBeNull();
    if (!module) return;
    let currentTime = 0;
    const enterDirectory = vi.fn(async () => { throw failure; });
    const recallToDesktop = vi.fn(async () => undefined);
    const recordFailure = vi.fn();
    const policy = new module.HabitatAutonomyPolicy({
      enterDirectory,
      recallToDesktop,
      recordFailure,
      now: () => currentTime,
      random: () => 0,
      cooldownMs: 60_000
    });
    const input = {
      snapshot: enabledSnapshot(),
      proactivityMode: 'autonomous' as const,
      idle: true,
      habitatState: 'desktop' as const,
      blockers: noBlockers
    };

    await policy.tick(input);
    currentTime = 30_000;
    await expect(policy.tick(input)).resolves.toEqual({ kind: 'failed', code });

    expect(recallToDesktop).toHaveBeenCalledOnce();
    expect(recordFailure).toHaveBeenCalledWith(code);
    expect(JSON.stringify(recordFailure.mock.calls)).not.toContain('Private');
  });
});
