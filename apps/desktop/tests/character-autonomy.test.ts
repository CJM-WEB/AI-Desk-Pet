import { afterEach, expect, it, vi } from 'vitest';
import type { ModelProvider, ModelRequest, ModelResponse } from '@myself/agent-core';
import { characterManifestV3Schema } from '@myself/character-runtime';
import { providerCatalog, type TaskEvent } from '@myself/shared-types';
import { resourceFields, v3Fixture } from '../../../packages/character-runtime/tests/character-v3-fixture';
import { CharacterBehaviorService } from '../src/main/characters/character-behavior-service';
import { CharacterBehaviorDirector } from '../src/main/characters/character-behavior-director';
import { createCharacterProactivityRuntime, createCharacterRuntimeClock } from '../src/main/characters/character-proactivity-runtime';
import { ConversationChatAdapter, characterAutonomyResponseContract } from '../src/main/conversation/conversation-chat-adapter';
import { createMainConversationComposition } from '../src/main/conversation/main-conversation-composition';
import { PrivacySessionRegistry } from '../src/main/agent/disclosure-policy';
import { OpenAICompatibleProvider } from '../src/main/providers/openai-provider';
import { LocalModelProvider } from '../src/main/providers/local-model-provider';
import { characterBehaviorRoles, type CharacterBehaviorBindings } from '../src/main/characters/character-behavior-bindings';
import { CharacterProactivityScheduler } from '../src/main/characters/character-proactivity-scheduler';

afterEach(() => vi.useRealTimers());
const minute = 60_000;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const noChoice = { kind: 'none', choice: null, mode: 'keep', target: null, distance: null } as const;
const response = (stateId?: string) => ({ type: 'structured' as const, structured_output: stateId
  ? { ...noChoice, kind: 'background', choice: { stateId, actionId: 'breathe' } } : { ...noChoice } });
const emptyBindings = Object.fromEntries(characterBehaviorRoles.map(role => [role, null])) as CharacterBehaviorBindings;

/** 只替换网络与窗口；使用真实组合、Director、Service 和表达引擎。 */
async function fixture(provider?: ModelProvider, mode: 0 | 1 | 2 = 0, options: { bindingsProvider?: ModelProvider; ready?: boolean; rendererReady?: boolean; enabled?: boolean; boredom?: boolean; realScheduler?: boolean } = {}) {
  let now = 0;
  const requests: ModelRequest[] = [];
  const bindingsRequests: ModelRequest[] = [];
  const events: TaskEvent[] = [];
  const manifest = characterManifestV3Schema.parse({ ...v3Fixture(), ...resourceFields });
  manifest.states[0]!.agentInferable = true;
  if (mode !== 0) manifest.states.push(
    { ...manifest.states[0]!, id: 'author-running', name: '作者自定义跑步', description: '跑步活动', agentInferable: true },
    { ...manifest.states[0]!, id: 'author-calm', name: '作者日常陪伴', description: '安静陪伴时可以持续保持', agentInferable: true }
  );
  if (options.boredom) {
    manifest.states[0]!.agentInferable = true;
    manifest.states.push({ ...manifest.states[0]!, id: 'author-lonely', name: '状态甲', description: '很久没有互动时安静蹲下，可以保持陪伴', agentInferable: true });
  }
  const motion = { getSnapshot: () => ({ revision: 0, timestampMs: now, position: { x: 0, y: 0 }, target: { x: 0, y: 0 }, direction: 'right' as const, moving: false, carrying: false }), requestIntent: vi.fn(() => null), applyTaskEvent: () => undefined, stop: () => undefined };
  const service = new CharacterBehaviorService({ store: { getActiveManifestV3: async () => manifest }, motion, now: () => now });
  await service.initialize();
  const director = new CharacterBehaviorDirector({ behavior: service, motion, now: () => now, initialGeneration: 'initial', initialSettings: { movementMode: mode, proactivityMode: 'assistive' }, saveMovementMode: async () => undefined });
  const startCurrentPlayback = () => {
    const current = service.snapshot()!.schedule.current!;
    director.applyPlaybackFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: now });
  };
  // 普通时序用例从已显示角色开始；冷启动用例显式保留 Renderer 未就绪作为负对照。
  if (options.rendererReady !== false) startCurrentPlayback();
  const privacySessions = new PrivacySessionRegistry();
  privacySessions.register('test', { incognito: false });
  let ready = options.ready ?? true;
  const composition = createMainConversationComposition({
    catalog: providerCatalog, privacySessions, sessionId: 'test', behavior: director, autonomy: director,
    readProviderSettings: async () => ({ profiles: [{ id: 'cloud', displayName: '测试模型', mode: 'preset' as const, providerId: 'deepseek', modelId: 'deepseek-chat', hasStoredSecret: true }],
      route: { primaryProfileId: 'cloud', chatProfileId: 'cloud', agentProfileId: null, visionProfileId: null, fallbackProfileIds: [], allowCrossProviderFallback: false } }),
    assertProviderReady: () => { if (!ready) throw new Error('NOT_READY'); },
    readAuthorizedRootPath: async () => null, readPrivacySettings: async () => ({}),
    createChatAdapter: () => new ConversationChatAdapter({ respond: async (request, signal) => {
      const properties = request.responseContract?.jsonSchema.properties;
      if (properties && typeof properties === 'object' && 'chatting' in properties) {
        bindingsRequests.push(request);
        return options.bindingsProvider ? options.bindingsProvider.respond(request, signal) : { type: 'structured', structured_output: {
          ...emptyBindings, moving: mode === 0 ? null : { stateId: 'author-running', actionId: 'breathe' },
          boredom: options.boredom ? { stateId: 'author-lonely', actionId: 'breathe' } : null
        } };
      }
      requests.push(request); return provider ? provider.respond(request, signal) : response();
    } }),
    createCodingTaskService: () => { throw new Error('自主请求不得创建文件任务'); }, emit: event => events.push(event)
  });
  const runtime = createCharacterProactivityRuntime({ director, advanceBehavior: () => director.advance(), now: () => now, autonomousMoodEnabled: options.enabled ?? true,
    requestAutonomousDecision: input => composition.requestAutonomousDecision(input),
    factories: { createScheduler: input => options.realScheduler
      ? new CharacterProactivityScheduler({ ...input, now: () => now, random: () => 0 })
      : { start: () => undefined, close: async () => undefined } } });
  runtime.start();
  await flush();
  return { runtime, composition, service, director, requests, bindingsRequests, events, motion, startCurrentPlayback,
    ready: (value: boolean) => { ready = value; },
    time: async (value: number) => { now = value; runtime.poll(); await flush(); },
    close: async () => { await runtime.close(); await composition.close(); } };
}

it('无正文契约复用云端与本地传输，严格拒绝越界选择且 DeepSeek 不隐形补发', async () => {
  let output: unknown = { ...noChoice };
  const bodies: Record<string, unknown>[] = [];
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content: output === null ? '' : JSON.stringify(output) } }] }), { headers: { 'content-type': 'application/json' } });
  });
  const providers = [new OpenAICompatibleProvider({ providerId: 'deepseek', baseUrl: 'https://example.test/v1', modelId: 'test' }, async () => 'test-only', fetcher),
    new LocalModelProvider({ getReadyConnection: () => ({ generation: 'one', baseUrl: 'http://127.0.0.1:1', token: 'test-only', modelId: 'test' }) }, fetcher)];
  const request: ModelRequest = { messages: [{ role: 'system', content: '只返回 JSON' }, { role: 'system', content: '角色人设' }, { role: 'user', content: '宿主自主检查' }], tools: [], toolChoice: 'none', reasoningMode: 'disabled', responseContract: characterAutonomyResponseContract };
  for (const provider of providers) {
    const result = await provider.respond(request, new AbortController().signal);
    expect(result).toEqual({ type: 'structured', structured_output: output });
    expect(result).not.toHaveProperty('text');
  }
  expect(bodies.every(body => JSON.stringify(body.tools) === '[]' && body.tool_choice === 'none' && body.stream !== true)).toBe(true);
  expect((bodies[1]!.messages as Array<{ role: string }>).filter(message => message.role === 'system')).toHaveLength(1);
  output = { ...noChoice, kind: 'background', choice: { stateId: 'rest', actionId: 'breathe' } };
  for (const provider of providers) expect(await provider.respond(request, new AbortController().signal)).toEqual({ type: 'structured', structured_output: output });
  expect(characterAutonomyResponseContract.jsonSchema.required).toEqual(expect.arrayContaining(['kind', 'choice', 'mode', 'target', 'distance']));
  for (const forbidden of [{ text: '不能公开' }, { explicitPlayback: { stateId: 'rest' } }, { tools: [] }, { unknown: true },
    { movementControl: { kind: 'set_mode', mode: 1 } }, { capabilityPlan: { kind: 'agent_task' } }, { moodUpdate: { summary: 'x'.repeat(17_000), strength: .2 } }]) {
    output = { ...noChoice, ...forbidden };
    await expect(providers[0]!.respond(request, new AbortController().signal)).rejects.toThrow();
  }
  output = { ...noChoice, kind: 'movement', mode: 'continuous' };
  await expect(providers[0]!.respond(request, new AbortController().signal)).rejects.toThrow();
  output = null;
  const before = fetcher.mock.calls.length;
  await expect(providers[0]!.respond(request, new AbortController().signal)).rejects.toThrow();
  expect(fetcher.mock.calls.length - before).toBe(1);
});

it('自主无新选择归一化为空表现计划，真实 Main 保持旧心情且不发正文或工具', async () => {
  const f = await fixture({ respond: async () => response() });
  try {
    f.service.applyDecision({ context: f.service.context()!, eventId: 'chat', source: 'chat', moodUpdate: { summary: '旧心情', strength: .8 } });
    const mood = f.service.snapshot()!.mood!;
    await f.time(5 * minute);
    expect(f.requests).toHaveLength(1);
    const request = f.requests[0]!;
    expect(request).toMatchObject({ tools: [], toolChoice: 'none', responseContract: { name: 'character_autonomy' } });
    expect(request.onTextDelta).toBeUndefined();
    expect(f.service.snapshot()?.mood).toMatchObject({ summary: mood.summary, revision: mood.revision, startedAtMs: mood.startedAtMs });
    expect(f.events).toEqual([]);
    expect(f.motion.requestIntent).not.toHaveBeenCalled();
    // 验证 Adapter 接纳而非上层吞掉格式错误，正式 Main 决策中不能残留 null。
    const adapter = new ConversationChatAdapter({ respond: async () => response() }, () => undefined, { inputByteBudget: 19200 });
    expect(await adapter.respondAutonomous({ behaviorContext: f.director.getChatContext(), idleForMs: 5 * minute,
      signal: new AbortController().signal, beforeProviderCall: () => true })).toEqual({ expressionPlan: { states: [] } });
  } finally { await f.close(); }
});

it('应用本次运行预算在真正调用时扣除，0 档推进且 reset 与开关不清额度', async () => {
  const f = await fixture();
  try {
    f.service.applyDecision({ context: f.service.context()!, eventId: '原有心情', source: 'chat', moodUpdate: { summary: '安静地陪伴', strength: .8 } });
    await f.time(5 * minute - 1); expect(f.requests).toHaveLength(0);
    f.ready(false); await f.time(5 * minute); expect(f.requests).toHaveLength(0);
    f.ready(true); await f.time(6 * minute); expect(f.requests).toHaveLength(1);
    expect(f.service.snapshot()?.mood?.summary).toBe('安静地陪伴');
    await f.time(7 * minute);
    const strength = f.service.snapshot()!.mood!.strength;
    f.runtime.setAutonomousMoodEnabled(false); await f.time(9 * minute);
    expect(f.requests).toHaveLength(1);
    expect(f.service.snapshot()!.mood!.strength).toBeLessThan(strength);
    f.runtime.setAutonomousMoodEnabled(true);
    await f.time(21 * minute - 1); expect(f.requests).toHaveLength(1);
    for (const t of [21, 36, 51]) await f.time(t * minute);
    expect(f.requests).toHaveLength(4);
    await f.composition.resetForConfigurationChange();
    f.runtime.setAutonomousMoodEnabled(false); f.runtime.setAutonomousMoodEnabled(true);
    await f.time(60 * minute); expect(f.requests).toHaveLength(4);
    await f.time(66 * minute); expect(f.requests).toHaveLength(5);
    expect(f.events).toEqual([expect.objectContaining({ type: 'conversation_reset' })]);
    expect(f.requests.every(request => request.tools.length === 0 && request.toolChoice === 'none' && request.onTextDelta === undefined && request.responseContract?.name === 'character_autonomy')).toBe(true);
    expect(f.motion.requestIntent).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('真实互动和超时中止旧自主请求，失败取消仍占次数且迟到结果不覆盖新背景', async () => {
  vi.useFakeTimers();
  const pending: Array<{ resolve(value: ModelResponse): void; signal: AbortSignal }> = [];
  const f = await fixture({ respond: async (_request, signal) => new Promise(resolve => pending.push({ resolve, signal })) }, 2);
  try {
    await f.time(5 * minute); expect(pending).toHaveLength(1);
    f.runtime.noteUserInteraction(); await f.director.prepareUserPrompt('你好');
    expect(pending[0]!.signal.aborted).toBe(true);
    f.director.setDragging(true); await f.time(20 * minute); expect(pending).toHaveLength(1);
    f.director.setDragging(false); f.director.handleChatResponseFinished(); await f.time(20 * minute); expect(pending).toHaveLength(2);
    pending[0]!.resolve(response('rest')); await flush();
    expect(f.service.snapshot()?.background).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pending[1]!.signal.aborted).toBe(true);
    await f.time(35 * minute); expect(pending).toHaveLength(3);
    pending[2]!.resolve(response('author-calm')); await flush();
    pending[1]!.resolve(response('rest')); await flush();
    expect(f.service.snapshot()?.background?.stateId).toBe('author-calm');
    await f.time(50 * minute); expect(pending).toHaveLength(4);
    f.runtime.invalidate(); await f.time(59 * minute); expect(pending).toHaveLength(4);
    expect(f.events).toEqual([]);
  } finally { await f.close(); }
});

it('单一宿主时间域一次消费休眠，忽略运行中墙钟跳变且心情继续衰减', async () => {
  expect(createCharacterRuntimeClock).toBeTypeOf('function');
  let mono = 0; let wall = 10_000;
  const clock = createCharacterRuntimeClock({ monotonicNow: () => mono, wallNow: () => wall });
  const f = await fixture();
  try {
    f.service.applyDecision({ context: f.service.context()!, eventId: 'chat', source: 'chat', moodUpdate: { summary: '开心', strength: 1 } });
    wall += 999_999; mono += 1_000; expect(clock.now()).toBe(1_000);
    clock.suspend(); wall += 300_000; clock.resume();
    expect(clock.now()).toBe(301_000);
    clock.resume(); expect(clock.now()).toBe(301_000);
    await f.time(clock.now()); expect(f.service.snapshot()?.mood?.strength).toBeLessThan(.51);
    clock.suspend(); wall -= 1_000_000; mono += 1_000; clock.resume();
    expect(clock.now()).toBe(302_000);
    clock.suspend(); wall += 7 * 24 * 60 * minute; clock.resume();
    expect(clock.now()).toBe(302_000 + 24 * 60 * minute);
  } finally { await f.close(); }
});


it.each([0, 1, 2] as const)('模式%i启动只准备完整用途，关闭心情也不影响准备成功', async mode => {
  const f = await fixture(undefined, mode, { enabled: false });
  try {
    expect(f.bindingsRequests).toHaveLength(1); expect(f.requests).toHaveLength(0);
    expect(f.bindingsRequests[0]).toMatchObject({ tools: [], toolChoice: 'none' });
    expect(f.director.needsBehaviorBindings()).toBe(false);
    await f.time(40 * minute); expect(f.bindingsRequests).toHaveLength(1);
    expect(f.motion.requestIntent).not.toHaveBeenCalled();
    f.runtime.invalidate(); await f.time(40 * minute + 1); expect(f.bindingsRequests).toHaveLength(2);
  } finally { await f.close(); }
});

it('完整用途准备后，模式2仍等待同token首帧才真正提交位移', async () => {
  const f = await fixture(undefined, 2, { enabled: false, rendererReady: false });
  try {
    expect(f.bindingsRequests).toHaveLength(1); expect(f.service.snapshot()?.mood).toBeNull();
    f.director.requestIntermittentMovement(); expect(f.service.snapshot()?.schedule.current?.stateId).toBe('rest');
    expect(f.director.getActivityBlockers().rendererUnready).toBe(true);
    f.startCurrentPlayback();
    f.director.requestIntermittentMovement(); expect(f.motion.requestIntent).not.toHaveBeenCalled();
    const current = f.service.snapshot()!.schedule.current!;
    expect(current.stateId).toBe('author-running');
    f.director.applyPlaybackFeedback({ playbackToken: current.playbackToken, actionId: current.actionId, status: 'started', occurredAtMs: 0 });
    expect(f.motion.requestIntent).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

it.each([0, 1, 2] as const)('真实Scheduler与完整用途冷启动模式%i，不依赖先聊天注入移动计划', async mode => {
  vi.useFakeTimers();
  const f = await fixture(undefined, mode, { enabled: false, realScheduler: true, rendererReady: false });
  try {
    expect(f.bindingsRequests).toHaveLength(1); expect(f.motion.requestIntent).not.toHaveBeenCalled();
    expect(f.director.needsBehaviorBindings()).toBe(false);
    expect(f.director.getActivityBlockers().rendererUnready).toBe(true);
    await f.time(4_000); await vi.advanceTimersByTimeAsync(4_000);
    expect(f.service.snapshot()?.schedule.current?.stateId).toBe('rest');
    expect(f.motion.requestIntent).not.toHaveBeenCalled();
    f.startCurrentPlayback();
    if (mode !== 1) { await f.time(14_000); await vi.advanceTimersByTimeAsync(10_000); }
    if (mode === 0) { expect(f.motion.requestIntent).not.toHaveBeenCalled(); return; }
    const current = f.service.snapshot()!.schedule.current!; expect(current.stateId).toBe('author-running');
    f.startCurrentPlayback();
    expect(f.motion.requestIntent).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

it('用途准备失败与loading按一分钟恢复，成功后不重试且不消费心情五分钟时钟', async () => {
  let attempts = 0;
  const f = await fixture(undefined, 0, { ready: false, bindingsProvider: { respond: async () => {
    if (++attempts === 1) throw new Error('一次格式失败');
    return { type: 'structured', structured_output: emptyBindings };
  } } });
  try {
    expect(f.bindingsRequests).toHaveLength(0); f.ready(true); await f.time(1000); expect(f.bindingsRequests).toHaveLength(0);
    await f.time(minute); expect(f.bindingsRequests).toHaveLength(1); await f.time(2 * minute - 1); expect(f.bindingsRequests).toHaveLength(1);
    await f.time(2 * minute); expect(f.bindingsRequests).toHaveLength(2); expect(f.director.needsBehaviorBindings()).toBe(false);
    await f.time(5 * minute); expect(f.bindingsRequests).toHaveLength(2); expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
});

it('用途准备失败每小时最多四次，准备额度用尽仍能在五分钟自主重评', async () => {
  const f = await fixture(undefined, 0, { bindingsProvider: { respond: async () => { throw new Error('匹配失败'); } } });
  try {
    for (const t of [1, 2, 3]) await f.time(t * minute);
    f.runtime.invalidate(); await f.time(4 * minute); expect(f.bindingsRequests).toHaveLength(4);
    await f.time(5 * minute); expect(f.requests).toHaveLength(1);
    await f.time(60 * minute); expect(f.bindingsRequests).toHaveLength(5);
  } finally { await f.close(); }
});

it('互动或配置失效撤销用途准备，迟到旧表不能覆盖当前角色', async () => {
  const pending: Array<{ resolve(value: ModelResponse): void; signal: AbortSignal }> = [];
  const f = await fixture(undefined, 2, { bindingsProvider: { respond: async (_request, signal) => new Promise(resolve => pending.push({ resolve, signal })) } });
  try {
    expect(pending).toHaveLength(1); f.runtime.noteUserInteraction(); await f.director.prepareUserPrompt('你好');
    expect(pending[0]!.signal.aborted).toBe(true);
    pending[0]!.resolve({ type: 'structured', structured_output: { ...emptyBindings, moving: { stateId: 'author-running', actionId: 'breathe' } } }); await flush();
    expect(f.director.needsBehaviorBindings()).toBe(true);
    f.director.handleChatResponseFinished(); await f.time(minute); expect(pending).toHaveLength(2); f.runtime.invalidate();
    pending[1]!.resolve({ type: 'structured', structured_output: emptyBindings }); await flush();
    expect(pending[1]!.signal.aborted).toBe(true); expect(f.director.needsBehaviorBindings()).toBe(true);
  } finally { await f.close(); }
});

it('五分钟先按描述用途显示无聊，模型空响应与idle建议不抹掉持续背景', async () => {
  let alreadyBored = false; let autonomousCalls = 0;
  const f = await fixture({ respond: async () => {
    alreadyBored = f.service.snapshot()?.background?.stateId === 'author-lonely';
    return ++autonomousCalls === 1 ? response() : response('rest');
  } }, 0, { boredom: true });
  try {
    await f.time(5 * minute); expect(f.requests).toHaveLength(1); expect(alreadyBored).toBe(true);
    expect(f.service.snapshot()?.background?.stateId).toBe('author-lonely');
    await f.time(20 * minute); expect(f.service.snapshot()?.background?.stateId).toBe('author-lonely');
  } finally { await f.close(); }
});
