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

afterEach(() => vi.useRealTimers());
const minute = 60_000;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const response = (summary = '安静地陪伴') => ({ type: 'structured' as const, structured_output: { moodUpdate: { summary, strength: .8 }, expressionPlan: null } });

/** 只替换网络与窗口；使用真实组合、Director、Service 和表达引擎。 */
async function fixture(provider?: ModelProvider) {
  let now = 0;
  const requests: ModelRequest[] = [];
  const events: TaskEvent[] = [];
  const manifest = characterManifestV3Schema.parse({ ...v3Fixture(), ...resourceFields });
  const motion = { getSnapshot: () => ({ revision: 0, timestampMs: now, position: { x: 0, y: 0 }, target: { x: 0, y: 0 }, direction: 'right' as const, moving: false, carrying: false }), requestIntent: vi.fn(() => null), applyTaskEvent: () => undefined, stop: () => undefined };
  const service = new CharacterBehaviorService({ store: { getActiveManifestV3: async () => manifest }, motion, now: () => now });
  await service.initialize();
  const director = new CharacterBehaviorDirector({ behavior: service, motion, initialGeneration: 'initial', initialSettings: { movementMode: 0, proactivityMode: 'assistive' }, saveMovementMode: async () => undefined });
  const privacySessions = new PrivacySessionRegistry();
  privacySessions.register('test', { incognito: false });
  let ready = true;
  const composition = createMainConversationComposition({
    catalog: providerCatalog, privacySessions, sessionId: 'test', behavior: director, autonomy: director,
    readProviderSettings: async () => ({ profiles: [{ id: 'cloud', displayName: '测试模型', mode: 'preset' as const, providerId: 'deepseek', modelId: 'deepseek-chat', hasStoredSecret: true }],
      route: { primaryProfileId: 'cloud', chatProfileId: 'cloud', agentProfileId: null, visionProfileId: null, fallbackProfileIds: [], allowCrossProviderFallback: false } }),
    assertProviderReady: () => { if (!ready) throw new Error('NOT_READY'); },
    readAuthorizedRootPath: async () => null, readPrivacySettings: async () => ({}),
    createChatAdapter: () => new ConversationChatAdapter({ respond: async (request, signal) => { requests.push(request); return provider ? provider.respond(request, signal) : response(); } }),
    createCodingTaskService: () => { throw new Error('自主请求不得创建文件任务'); }, emit: event => events.push(event)
  });
  const runtime = createCharacterProactivityRuntime({ director, advanceBehavior: () => director.advance(), now: () => now,
    requestAutonomousDecision: input => composition.requestAutonomousDecision(input),
    factories: { createScheduler: () => ({ start: () => undefined, close: async () => undefined }) } });
  runtime.start();
  return { runtime, composition, service, director, requests, events, motion,
    ready: (value: boolean) => { ready = value; },
    time: async (value: number) => { now = value; runtime.poll(); await flush(); },
    close: async () => { await runtime.close(); await composition.close(); } };
}

it('无正文契约复用云端与本地传输，严格拒绝额外字段且 DeepSeek 不隐形补发', async () => {
  let output: unknown = { moodUpdate: { summary: '有点困', strength: .4 }, expressionPlan: { states: [] } };
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
  output = { moodUpdate: null, expressionPlan: null };
  for (const provider of providers) expect(await provider.respond(request, new AbortController().signal)).toEqual({ type: 'structured', structured_output: output });
  expect(characterAutonomyResponseContract.jsonSchema.required).toEqual(expect.arrayContaining(['moodUpdate', 'expressionPlan']));
  for (const forbidden of [{ text: '不能公开' }, { explicitPlayback: { stateId: 'rest' } }, { tools: [] }, { unknown: true },
    { movementControl: { kind: 'set_mode', mode: 1 } }, { capabilityPlan: { kind: 'agent_task' } }, { moodUpdate: { summary: 'x'.repeat(17_000), strength: .2 } }]) {
    output = { moodUpdate: null, expressionPlan: null, ...forbidden };
    await expect(providers[0]!.respond(request, new AbortController().signal)).rejects.toThrow();
  }
  output = { moodUpdate: null };
  await expect(providers[0]!.respond(request, new AbortController().signal)).rejects.toThrow();
  output = null;
  const before = fetcher.mock.calls.length;
  await expect(providers[0]!.respond(request, new AbortController().signal)).rejects.toThrow();
  expect(fetcher.mock.calls.length - before).toBe(1);
});

it('自主 null 归一化为无更新，真实 Main 保持旧心情且不发正文或工具', async () => {
  const f = await fixture({ respond: async () => ({ type: 'structured', structured_output: { moodUpdate: null, expressionPlan: null } }) });
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
    const adapter = new ConversationChatAdapter({ respond: async () => ({ type: 'structured', structured_output: { moodUpdate: null, expressionPlan: null } }) }, () => undefined, { inputByteBudget: 19200 });
    expect(await adapter.respondAutonomous({ behaviorContext: f.director.getChatContext(), idleForMs: 5 * minute,
      signal: new AbortController().signal, beforeProviderCall: () => true })).toEqual({});
  } finally { await f.close(); }
});

it('应用本次运行预算在真正调用时扣除，0 档推进且 reset 与开关不清额度', async () => {
  const f = await fixture();
  try {
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

it('真实互动和超时中止旧自主请求，失败取消仍占次数且迟到结果不覆盖新心情', async () => {
  vi.useFakeTimers();
  const pending: Array<{ resolve(value: ModelResponse): void; signal: AbortSignal }> = [];
  const f = await fixture({ respond: async (_request, signal) => new Promise(resolve => pending.push({ resolve, signal })) });
  try {
    await f.time(5 * minute); expect(pending).toHaveLength(1);
    f.runtime.noteUserInteraction(); await f.director.prepareUserPrompt('你好');
    expect(pending[0]!.signal.aborted).toBe(true);
    f.director.setDragging(true); await f.time(20 * minute); expect(pending).toHaveLength(1);
    f.director.setDragging(false); await f.time(20 * minute); expect(pending).toHaveLength(2);
    pending[0]!.resolve(response('迟到')); await flush();
    expect(f.service.snapshot()?.mood).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pending[1]!.signal.aborted).toBe(true);
    await f.time(35 * minute); expect(pending).toHaveLength(3);
    pending[2]!.resolve(response('现在')); await flush();
    pending[1]!.resolve(response('超时旧心情')); await flush();
    expect(f.service.snapshot()?.mood?.summary).toBe('现在');
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
