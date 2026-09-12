import { CharacterProactivityScheduler } from '../src/main/characters/character-proactivity-scheduler';
import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import type { ModelProvider, ModelResponse } from '@myself/agent-core';
import type { TaskEvent } from '@myself/shared-types';
import { characterManifestV3Schema } from '@myself/character-runtime';
import { CharacterBehaviorService } from '../src/main/characters/character-behavior-service';
import { CharacterBehaviorDirector } from '../src/main/characters/character-behavior-director';
import { ConversationCoordinator, type ConversationCapabilityTaskPort } from '../src/main/conversation/conversation-coordinator';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';
import { ConversationEventProjection } from '../src/main/conversation/conversation-event-projection';
import { ConversationHistory } from '../src/main/conversation/conversation-history';
import { ConversationDisclosureAdapter } from '../src/main/conversation/conversation-disclosure-adapter';
import { DisclosurePolicy, PrivacySessionRegistry } from '../src/main/agent/disclosure-policy';

const manifest = characterManifestV3Schema.parse(JSON.parse(readFileSync(new URL('../resources/characters/default/compiled/manifest.json', import.meta.url), 'utf8')));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const noMatch: ModelResponse = { type: 'structured', structured_output: { kind: 'none', choice: null, mode: 'keep', target: null, distance: null } };
const authorization: ModelResponse = { type: 'tool_request', request: { requestId: 'request-native', toolName: 'request_task_authorization', arguments: {} } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }

/** 正式默认角色、Coordinator、Adapter、投影、Director、Service、Engine 全部真实；只替换 Provider 和无副作用任务端口。 */
async function fixture(provider: ModelProvider, singleSlot = false, mode: 0 | 1 | 2 = 0, withHistory = false) {
  let now = 0;
  const events: TaskEvent[] = [];
  const motion = { getSnapshot: () => ({ revision: 0, timestampMs: now, position: { x: 0, y: 0 }, target: { x: 0, y: 0 }, direction: 'right' as const, moving: false, carrying: false }), requestIntent: vi.fn(() => null), applyTaskEvent: () => undefined, stop: () => undefined };
  const service = new CharacterBehaviorService({ store: { getActiveManifestV3: async () => manifest }, motion, now: () => now, random: () => 0 });
  await service.initialize();
  const director = new CharacterBehaviorDirector({ behavior: service, motion, now: () => now, initialGeneration: 'initial', initialSettings: { movementMode: mode, proactivityMode: 'assistive' }, saveMovementMode: async () => undefined });
  const projection = new ConversationEventProjection({ behavior: director, getChatTarget: () => null, getPetTarget: () => null });
  const registry = new PrivacySessionRegistry(); registry.register('diagnosis', { incognito: false });
  const disclosureAdapter = new ConversationDisclosureAdapter({ sessionId: 'diagnosis', privacySessions: registry, disclosurePolicy: new DisclosurePolicy({ privacySessions: registry, resolveProfileProvider: () => 'same', resolveCurrentSourceProvider: () => null }) });
  const target = { profileId: 'same', providerIdentity: 'same', providerName: '诊断替身', directory: 'C:\\diagnosis', modelId: 'test', approvedCommands: [], capabilityRevision: 'test' };
  let taskListener: Parameters<ConversationCapabilityTaskPort['onEvent']>[0] = () => undefined;
  let taskGeneration = '';
  const outcome = deferred<{ kind: 'completed'; acted: boolean }>();
  const tasks: ConversationCapabilityTaskPort = { onEvent: listener => { taskListener = listener; return () => { taskListener = () => undefined; }; }, onTrustedToolResult: () => () => undefined,
    prepareSnapshot: async () => target, prepareTarget: async () => target, activateTarget: async () => undefined,
    submit: vi.fn(async input => { taskGeneration = input.generation; taskListener({ type: 'phase', phase: 'acting' }, taskGeneration); return outcome.promise; }), cancelActive: () => undefined,
    resolveAction: async () => undefined, resetForNewConversation: async () => undefined, close: async () => undefined };
  const adapter = new ConversationChatAdapter(provider, undefined, { singleSlot });
  const history = new ConversationHistory(); if (withHistory) history.append({ userText: '之前的问题', assistantText: '之前的回复', providerIdentity: 'previous' });
  const coordinator = new ConversationCoordinator({ history, disclosureAdapter, capabilityTasks: tasks, behavior: director,
    chatTurnFactory: { create: async () => ({ adapter, profileId: 'same', providerIdentity: 'same', providerName: '诊断替身' }) },
    emit: event => { events.push(event); projection.publish(event); } });
  const scheduler = new CharacterProactivityScheduler({ director, random: () => 0, now: () => now }); scheduler.start();
  cleanups.push(async () => { outcome.resolve({ kind: 'completed', acted: false }); await scheduler.close(); await coordinator.close(); service.close(); });
  return { coordinator, director, service, events, tasks, time: (value: number) => { now = value; director.advance(); },
    finishTask: (phase: 'success' | 'error') => { taskListener({ type: 'phase', phase }, taskGeneration); outcome.resolve({ kind: 'completed', acted: true }); } };
}


const pair = (stateId: string, actionId = `${stateId}-action`) => ({ stateId, actionId });
const bindings = { chatting: pair('state-7'), taskRunning: pair('state-6'), awaitingConfirmation: pair('state-7'),
  moving: pair('state'), success: pair('state-8'), error: pair('state-5'), praise: pair('state-8'), boredom: pair('state-3'), rest: pair('state-2') };
function isBindings(request: import('@myself/agent-core').ModelRequest) {
  return 'chatting' in ((request.responseContract?.jsonSchema as { properties?: Record<string, unknown> })?.properties ?? {});
}

test('披露确认结束恢复真实聊天思考，挂起正文期间不再保持确认事实', async () => {
  const main = deferred<ModelResponse>(); const calls: string[] = [];
  const f = await fixture({ respond: async request => {
    if (isBindings(request)) return { type: 'structured', structured_output: bindings };
    if (request.responseContract) return noMatch;
    calls.push('main'); return main.promise;
  } }, false, 0, true);
  await f.coordinator.submit('继续聊聊');
  const card = f.events.find(event => event.type === 'history_disclosure_required');
  if (!card || card.type !== 'history_disclosure_required') throw new Error('没有历史披露卡');
  expect(f.director.getChatContext().runtime.awaitingConfirmation).toBe(true);
  const running = f.coordinator.resolveHistoryDisclosure(card.requestId, 'current_message_only');
  await vi.waitFor(() => expect(calls).toEqual(['main']));
  expect.soft(f.director.getChatContext().runtime).toMatchObject({ chatting: true, awaitingConfirmation: false });
  main.resolve({ type: 'text', text: '好呀。' }); await running;
});

test('角色切换同步撤销旧用途预热，不让旧单槽预热继续拦住主聊天', async () => {
  const binding = deferred<ModelResponse>(); let signal: AbortSignal | undefined;
  const f = await fixture({ respond: async (request, inputSignal) => {
    if (isBindings(request)) { signal = inputSignal; return binding.promise; }
    return request.responseContract ? noMatch : { type: 'text', text: '你好。' };
  } }, true);
  const running = f.coordinator.submit('你好');
  await vi.waitFor(() => expect(signal).toBeDefined());
  await f.director.handleActiveCharacterChanged();
  expect.soft(signal?.aborted).toBe(true);
  binding.resolve({ type: 'structured', structured_output: bindings }); await running;
});

test('模式1在主回复结束与已排队开心交接时不能先启动移动', async () => {
  const main = deferred<ModelResponse>(); let reactionReturned = false;
  const f = await fixture({ respond: async request => {
    if (isBindings(request)) return { type: 'structured', structured_output: bindings };
    if (request.responseContract) { reactionReturned = true; return { type: 'structured', structured_output: { kind: 'reaction', choice: pair('state-8'), mode: 'keep', target: null, distance: null } }; }
    return main.promise;
  } }, false, 1);
  const running = f.coordinator.submit('你真棒');
  await vi.waitFor(() => expect(reactionReturned).toBe(true));
  expect(f.service.snapshot()?.stateId).toBe('state-7');
  main.resolve({ type: 'text', text: '谢谢你。' }); await running;
  expect(f.service.snapshot()?.stateId).toBe('state-8');
});
