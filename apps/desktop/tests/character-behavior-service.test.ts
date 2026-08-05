import type {
  CharacterAgentBehaviorIntent,
  CharacterManifestV1,
  CharacterManifestV2,
  CharacterPlaybackFeedback
} from '@myself/character-runtime';
import type { TaskEvent } from '@myself/shared-types';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { CharacterMotionSnapshot } from '../src/shared/character-motion-ipc';

type BehaviorPlaybackEvent =
  | {
      type: 'behavior-action';
      revision: number;
      stateId: string;
      actionId: string;
      playbackToken: string;
    }
  | {
      type: 'idle-action';
      revision: number;
      actionId: string;
      playbackToken: string;
    };

type BehaviorService = {
  initialize(): Promise<void>;
  handleTaskEvent(event: TaskEvent): void;
  handleAgentIntent(intent: CharacterAgentBehaviorIntent): void;
  handleMovement(snapshot: CharacterMotionSnapshot): void;
  handleUserInteraction(): void;
  handleIdleDue(): void;
  applyPlaybackFeedback(feedback: CharacterPlaybackFeedback): void;
  handleActiveCharacterChanged(): Promise<void>;
  subscribe(listener: (event: BehaviorPlaybackEvent) => void): () => void;
  close(): void;
};

type BehaviorServiceConstructor = new (options: Record<string, unknown>) => BehaviorService;

const SEMANTICS = ['idle', 'listen', 'think', 'move', 'celebrate', 'fail'] as const;

function createManifest(id = 'first'): CharacterManifestV2 {
  return {
    version: 2,
    id,
    name: `${id} 角色`,
    thumbnailAssetId: 'thumbnail',
    compilerVersion: 'test',
    identity: {
      description: '行为服务测试角色',
      background: '测试背景',
      traits: [],
      languageStyle: '简洁',
      formsOfAddress: [],
      likes: [],
      dislikes: [],
      behavioralTendencies: [],
      boundaries: [],
      exampleLines: []
    },
    defaultSkinId: 'default-skin',
    defaultStateId: 'idle-state',
    states: SEMANTICS.map(semantic => ({
      id: `${semantic}-state`,
      name: `${semantic} 状态`,
      kind: 'primary',
      semantic,
      tags: [],
      intensity: 1,
      coexistWithStateIds: [],
      forbiddenStateIds: [],
      enterConditions: [],
      exitConditions: [],
      agentInferable: true,
      actionIds: [`${semantic}-action`]
    })),
    actions: SEMANTICS.map(semantic => ({
      id: `${semantic}-action`,
      name: `${semantic} 动作`,
      semantic,
      tags: [],
      preference: 1,
      cooldownMs: 0,
      repeatSuppressionMs: 0,
      loopPolicy: 'never',
      interrupt: 'normal',
      allowedPrimaryStateIds: [],
      forbiddenPrimaryStateIds: [],
      requiredModifierStateIds: [],
      forbiddenModifierStateIds: [],
      direction: 'any'
    })),
    skins: [{
      id: 'default-skin',
      name: '默认皮肤',
      presentations: SEMANTICS.map(semantic => ({
        actionId: `${semantic}-action`,
        fps: 20,
        frames: [{ assetId: `${semantic}-asset`, x: 0, y: 0, width: 1, height: 1 }],
        anchors: { ground: { x: 0.5, y: 1 } }
      })),
      semanticFallbacks: []
    }],
    resources: [
      { assetId: 'thumbnail', fileName: 'thumbnail.png', sha256: 'a'.repeat(64), byteLength: 1 },
      ...SEMANTICS.map(semantic => ({
        assetId: `${semantic}-asset`,
        fileName: `${semantic}.png`,
        sha256: 'a'.repeat(64),
        byteLength: 1
      }))
    ]
  };
}

function createLegacyManifest(id = 'legacy'): CharacterManifestV1 {
  return {
    version: 1,
    id,
    name: '兼容角色',
    thumbnailAssetId: 'atlas',
    compilerVersion: 'test',
    resources: [{
      assetId: 'atlas',
      fileName: 'atlas.png',
      sha256: 'a'.repeat(64),
      byteLength: 1
    }],
    states: [{
      id: 'idle',
      kind: 'core',
      actions: [{
        id: 'legacy-idle',
        name: '兼容待机',
        fps: 8,
        loop: true,
        weight: 1,
        frames: [{ assetId: 'atlas', x: 0, y: 0, width: 1, height: 1 }],
        anchors: { ground: { x: 0.5, y: 1 } }
      }]
    }]
  };
}

function snapshot(moving = false, direction: 'left' | 'right' = 'right'): CharacterMotionSnapshot {
  return {
    revision: 7,
    timestampMs: 0,
    position: { x: 0, y: 0 },
    target: { x: moving ? 100 : 0, y: 0 },
    direction,
    moving,
    carrying: false
  };
}

function tokenFactory(prefix = 'behavior-token'): () => string {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** 通过高强度状态把残留 thinking 信号转换为可观察的错误动作。 */
function createResultSignalSensitiveManifest(
  phase: 'success' | 'error'
): CharacterManifestV2 {
  const manifest = createManifest();
  const semantic = phase === 'success' ? 'celebrate' : 'fail';
  const actionId = `stale-${phase}-action`;
  const stateId = `stale-${phase}-state`;
  manifest.actions.push({
    ...manifest.actions.find(action => action.semantic === semantic)!,
    id: actionId,
    name: `残留 ${phase} 动作`
  });
  manifest.states.push({
    ...manifest.states.find(state => state.semantic === semantic)!,
    id: stateId,
    name: `残留 ${phase} 状态`,
    intensity: 100,
    actionIds: [actionId],
    enterConditions: [{
      mode: 'all',
      clauses: [
        { kind: 'signal', signal: 'thinking' },
        { kind: 'signal', signal: phase === 'success' ? 'task-success' : 'task-failure' }
      ]
    }]
  });
  manifest.skins[0]!.presentations.push({
    actionId,
    fps: 20,
    frames: [{ assetId: `${actionId}-asset`, x: 0, y: 0, width: 1, height: 1 }],
    anchors: { ground: { x: 0.5, y: 1 } }
  });
  manifest.resources.push({
    assetId: `${actionId}-asset`,
    fileName: `${actionId}.png`,
    sha256: 'a'.repeat(64),
    byteLength: 1
  });
  return manifest;
}

async function loadConstructor(): Promise<BehaviorServiceConstructor> {
  const module = await import('../src/main/characters/character-behavior-service').catch(() => null) as null | {
    CharacterBehaviorService?: BehaviorServiceConstructor;
  };
  expect(module?.CharacterBehaviorService, 'Main 应实现唯一行为权威服务')
    .toBeTypeOf('function');
  return module!.CharacterBehaviorService!;
}

function createFixture(overrides: {
  getV2?: () => Promise<CharacterManifestV2>;
  getV1?: () => Promise<CharacterManifestV1>;
} = {}) {
  let now = 0;
  const currentSnapshot = snapshot();
  const store = {
    getActiveManifestV2: vi.fn(overrides.getV2 ?? (async () => createManifest())),
    getActive: vi.fn(overrides.getV1 ?? (async () => createLegacyManifest()))
  };
  const motion = {
    getSnapshot: vi.fn(() => structuredClone(currentSnapshot)),
    requestIntent: vi.fn(),
    applyTaskEvent: vi.fn(),
    pollIdle: vi.fn(() => null),
    issueIdlePlayback: vi.fn(() => 'legacy-token-1'),
    confirmIdlePlayback: vi.fn()
  };
  const reportError = vi.fn();
  return {
    store,
    motion,
    reportError,
    now: () => now,
    setNow: (value: number) => { now = value; },
    options: {
      store,
      motion,
      now: () => now,
      random: () => 0,
      createPlaybackToken: tokenFactory(),
      idleIntervalMs: 1_000,
      reportError
    }
  };
}

describe('Main 角色行为权威服务', () => {
  let Constructor: BehaviorServiceConstructor;

  beforeEach(async () => {
    Constructor = await loadConstructor();
  });

  test('初始化读取 V2 清单并发出默认状态动作', async () => {
    const fixture = createFixture();
    const service = new Constructor(fixture.options);
    const events: BehaviorPlaybackEvent[] = [];
    service.subscribe(event => events.push(event));

    await service.initialize();

    expect(fixture.store.getActiveManifestV2).toHaveBeenCalledOnce();
    expect(events).toEqual([{
      type: 'behavior-action',
      revision: 1,
      stateId: 'idle-state',
      actionId: 'idle-action',
      playbackToken: 'behavior-token-1'
    }]);
  });

  test.each([
    [{ type: 'phase', phase: 'listening' }, 'listen-action'],
    [{ type: 'phase', phase: 'thinking' }, 'think-action'],
    [{ type: 'phase', phase: 'success' }, 'celebrate-action'],
    [{ type: 'phase', phase: 'error' }, 'fail-action']
  ] as const)('TaskEvent %o 只由 Main 映射为 %s', async (event, actionId) => {
    const fixture = createFixture();
    const service = new Constructor(fixture.options);
    const events: BehaviorPlaybackEvent[] = [];
    service.subscribe(next => events.push(next));
    await service.initialize();

    service.handleTaskEvent(event);

    expect(events.at(-1)).toMatchObject({ type: 'behavior-action', actionId });
    expect(fixture.motion.applyTaskEvent).toHaveBeenCalledWith(event);
  });

  test.each(['idle', 'cancelled'] as const)(
    'listening→thinking→%s 显式停用任务信号并恢复默认动作',
    async phase => {
      const fixture = createFixture();
      const service = new Constructor(fixture.options);
      const events: BehaviorPlaybackEvent[] = [];
      service.subscribe(event => events.push(event));
      await service.initialize();
      events.splice(0);

      service.handleTaskEvent({ type: 'phase', phase: 'listening' });
      service.handleTaskEvent({ type: 'phase', phase: 'thinking' });
      service.handleTaskEvent({ type: 'phase', phase });

      expect(events.at(-1)).toMatchObject({
        stateId: 'idle-state',
        actionId: 'idle-action'
      });
    }
  );

  test.each([
    ['success', 'celebrate-action'],
    ['error', 'fail-action']
  ] as const)(
    'thinking→%s 先停用 thinking，不让旧信号选中高强度残留状态',
    async (phase, actionId) => {
      const fixture = createFixture({
        getV2: async () => createResultSignalSensitiveManifest(phase)
      });
      const service = new Constructor(fixture.options);
      const events: BehaviorPlaybackEvent[] = [];
      service.subscribe(event => events.push(event));
      await service.initialize();
      events.splice(0);

      service.handleTaskEvent({ type: 'phase', phase: 'thinking' });
      service.handleTaskEvent({ type: 'phase', phase });

      expect(events.at(-1)).toMatchObject({ actionId });
    }
  );

  test('高层 Agent 意图参与引擎决策但不直接指定文件动作', async () => {
    const fixture = createFixture();
    const service = new Constructor(fixture.options);
    const events: BehaviorPlaybackEvent[] = [];
    service.subscribe(event => events.push(event));
    await service.initialize();

    service.handleAgentIntent({
      stateIntent: { semantic: 'celebrate' },
      actionSemantic: 'celebrate',
      urgency: 60,
      explanation: '任务完成后庆祝'
    });

    expect(events.at(-1)).toMatchObject({ actionId: 'celebrate-action' });
  });

  test('运动快照只在 moving 边沿改变时决策', async () => {
    const fixture = createFixture();
    const service = new Constructor(fixture.options);
    const events: BehaviorPlaybackEvent[] = [];
    service.subscribe(event => events.push(event));
    await service.initialize();
    events.splice(0);

    service.handleMovement(snapshot(false));
    service.handleMovement(snapshot(true, 'left'));
    const countAfterStart = events.length;
    service.handleMovement(snapshot(true, 'left'));
    service.handleMovement(snapshot(false, 'left'));

    expect(countAfterStart).toBe(1);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ actionId: 'move-action' });
  });

  test('用户交互只产生本地信号并重新计算空闲期限', async () => {
    const fixture = createFixture();
    const service = new Constructor(fixture.options);
    const events: BehaviorPlaybackEvent[] = [];
    service.subscribe(event => events.push(event));
    await service.initialize();
    events.splice(0);

    fixture.setNow(900);
    service.handleUserInteraction();
    fixture.setNow(1_000);
    service.handleIdleDue();

    expect(events).toHaveLength(1);
    fixture.setNow(1_900);
    service.handleIdleDue();
    expect(events).toHaveLength(2);
  });

  test('pending_action 和 acting 阻止随机待机且不产生动作', async () => {
    const fixture = createFixture();
    const service = new Constructor(fixture.options);
    const events: BehaviorPlaybackEvent[] = [];
    service.subscribe(event => events.push(event));
    await service.initialize();
    events.splice(0);

    service.handleTaskEvent({
      type: 'pending_action',
      action: {
        actionId: 'action-1',
        conversationId: 'conversation-1',
        risk: 'write',
        summary: '写入文件',
        targetRelativePath: 'note.txt',
        createdAt: '2026-08-06T00:00:00.000Z',
        expiresAt: '2026-08-06T00:10:00.000Z'
      }
    });
    fixture.setNow(10_000);
    service.handleIdleDue();
    service.handleTaskEvent({ type: 'phase', phase: 'acting' });
    service.handleIdleDue();

    expect(events).toEqual([]);
    expect(fixture.motion.applyTaskEvent).toHaveBeenCalledTimes(2);
  });

  test('move 语义只在引擎真正排程后请求封闭 wander 意图', async () => {
    const fixture = createFixture();
    const service = new Constructor(fixture.options);
    await service.initialize();

    service.handleAgentIntent({
      stateIntent: { semantic: 'move' },
      actionSemantic: 'move',
      urgency: 80,
      explanation: '需要在桌面上漫步'
    });

    expect(fixture.motion.requestIntent).toHaveBeenCalledExactlyOnceWith('wander');
  });

  test('播放反馈由当前引擎令牌单次鉴权', async () => {
    const fixture = createFixture();
    const service = new Constructor(fixture.options);
    await service.initialize();
    const feedback: CharacterPlaybackFeedback = {
      playbackToken: 'behavior-token-1',
      actionId: 'idle-action',
      status: 'started',
      occurredAtMs: 10
    };

    expect(() => service.applyPlaybackFeedback(feedback)).not.toThrow();
    expect(() => service.applyPlaybackFeedback(feedback))
      .toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
  });

  test('活动角色切换撤销旧令牌并发出新角色默认动作', async () => {
    let active = createManifest('first');
    const fixture = createFixture({ getV2: async () => active });
    const service = new Constructor(fixture.options);
    const events: BehaviorPlaybackEvent[] = [];
    service.subscribe(event => events.push(event));
    await service.initialize();
    active = createManifest('second');

    await service.handleActiveCharacterChanged();

    expect(events.at(-1)).toEqual({
      type: 'behavior-action',
      revision: 1,
      stateId: 'idle-state',
      actionId: 'idle-action',
      playbackToken: 'behavior-token-2'
    });
    expect(() => service.applyPlaybackFeedback({
      playbackToken: 'behavior-token-1',
      actionId: 'idle-action',
      status: 'started',
      occurredAtMs: 10
    })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
  });

  test('活动角色异步读取期间立即隔离旧引擎和旧播放令牌', async () => {
    const fixture = createFixture();
    const service = new Constructor(fixture.options);
    const events: BehaviorPlaybackEvent[] = [];
    service.subscribe(event => events.push(event));
    await service.initialize();
    events.splice(0);
    fixture.motion.requestIntent.mockClear();
    const pendingManifest = deferred<CharacterManifestV2>();
    fixture.store.getActiveManifestV2.mockReturnValueOnce(pendingManifest.promise);

    const switching = service.handleActiveCharacterChanged();
    expect(() => service.applyPlaybackFeedback({
      playbackToken: 'behavior-token-1',
      actionId: 'idle-action',
      status: 'started',
      occurredAtMs: 10
    })).toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
    service.handleTaskEvent({ type: 'phase', phase: 'listening' });
    service.handleMovement(snapshot(true));
    service.handleAgentIntent({
      stateIntent: { semantic: 'celebrate' },
      actionSemantic: 'celebrate',
      urgency: 60,
      explanation: '切换期间不应由旧角色执行'
    });
    service.handleUserInteraction();
    expect(events).toEqual([]);
    expect(fixture.motion.requestIntent).not.toHaveBeenCalled();

    pendingManifest.resolve(createManifest('second'));
    await switching;

    expect(events).toEqual([{
      type: 'behavior-action',
      revision: 1,
      stateId: 'idle-state',
      actionId: 'idle-action',
      playbackToken: 'behavior-token-2'
    }]);
  });

  test('V2 读取失败时错误脱敏且仅使用 V1 待机兼容路径', async () => {
    const fixture = createFixture({
      getV2: async () => { throw new Error('ENOENT: C:\\private\\manifest.json'); }
    });
    fixture.motion.pollIdle.mockReturnValue({
      stateId: 'idle',
      action: createLegacyManifest().states[0]!.actions[0]!,
      reason: 'matched'
    } as never);
    const service = new Constructor(fixture.options);
    const events: BehaviorPlaybackEvent[] = [];
    service.subscribe(event => events.push(event));
    await service.initialize();
    fixture.setNow(1_000);

    service.handleIdleDue();

    expect(fixture.reportError).toHaveBeenCalledWith('CHARACTER_BEHAVIOR_V2_UNAVAILABLE');
    expect(JSON.stringify(fixture.reportError.mock.calls)).not.toContain('private');
    expect(fixture.motion.pollIdle).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1, id: 'legacy' }),
      'right',
      expect.any(Function)
    );
    expect(events).toEqual([{
      type: 'idle-action',
      revision: 7,
      actionId: 'legacy-idle',
      playbackToken: 'legacy-token-1'
    }]);
  });

  test('切换读取失败不中断当前播放器', async () => {
    const fixture = createFixture();
    const service = new Constructor(fixture.options);
    const events: BehaviorPlaybackEvent[] = [];
    service.subscribe(event => events.push(event));
    await service.initialize();
    events.splice(0);
    fixture.store.getActiveManifestV2.mockRejectedValueOnce(
      new Error('EACCES: C:\\private\\manifest.json')
    );

    await expect(service.handleActiveCharacterChanged()).resolves.toBeUndefined();

    expect(events).toEqual([]);
    expect(fixture.reportError).toHaveBeenCalledWith('CHARACTER_BEHAVIOR_V2_UNAVAILABLE');
  });

  test('切换时 V2 与 V1 均失败后不再用旧角色引擎产生动作', async () => {
    const fixture = createFixture();
    const service = new Constructor(fixture.options);
    const events: BehaviorPlaybackEvent[] = [];
    service.subscribe(event => events.push(event));
    await service.initialize();
    events.splice(0);
    fixture.store.getActiveManifestV2.mockRejectedValueOnce(new Error('V2_READ_FAILED'));
    fixture.store.getActive.mockRejectedValueOnce(new Error('V1_READ_FAILED'));

    await service.handleActiveCharacterChanged();
    service.handleUserInteraction();

    expect(events).toEqual([]);
  });

  test('关闭后不再处理信号或通知订阅者', async () => {
    const fixture = createFixture();
    const service = new Constructor(fixture.options);
    const listener = vi.fn();
    service.subscribe(listener);
    await service.initialize();
    listener.mockClear();

    service.close();
    service.handleUserInteraction();
    service.handleMovement(snapshot(true));
    service.handleIdleDue();

    expect(listener).not.toHaveBeenCalled();
    expect(fixture.motion.requestIntent).not.toHaveBeenCalled();
  });
});
