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
async function fixture(provider: ModelProvider, singleSlot = false) {
  let now = 0;
  const events: TaskEvent[] = [];
  const motion = { getSnapshot: () => ({ revision: 0, timestampMs: now, position: { x: 0, y: 0 }, target: { x: 0, y: 0 }, direction: 'right' as const, moving: false, carrying: false }), requestIntent: vi.fn(() => null), applyTaskEvent: () => undefined, stop: () => undefined };
  const service = new CharacterBehaviorService({ store: { getActiveManifestV3: async () => manifest }, motion, now: () => now, random: () => 0 });
  await service.initialize();
  const director = new CharacterBehaviorDirector({ behavior: service, motion, now: () => now, initialGeneration: 'initial', initialSettings: { movementMode: 0, proactivityMode: 'assistive' }, saveMovementMode: async () => undefined });
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
  const coordinator = new ConversationCoordinator({ history: new ConversationHistory(), disclosureAdapter, capabilityTasks: tasks, behavior: director,
    chatTurnFactory: { create: async () => ({ adapter, profileId: 'same', providerIdentity: 'same', providerName: '诊断替身' }) },
    emit: event => { events.push(event); projection.publish(event); } });
  cleanups.push(async () => { outcome.resolve({ kind: 'completed', acted: false }); await coordinator.close(); service.close(); });
  return { coordinator, director, service, events, tasks, time: (value: number) => { now = value; director.advance(); },
    finishTask: (phase: 'success' | 'error') => { taskListener({ type: 'phase', phase }, taskGeneration); outcome.resolve({ kind: 'completed', acted: true }); } };
}


const pair = (stateId: string, actionId = `${stateId}-action`) => ({ stateId, actionId });
const bindings = { chatting: pair('state-7'), taskRunning: pair('state-6'), awaitingConfirmation: pair('state-7'),
  moving: pair('state'), success: pair('state-8'), error: pair('state-5'), praise: pair('state-8'), boredom: pair('state-3'), rest: pair('state-2') };
function isBindings(request: import('@myself/agent-core').ModelRequest) {
  return 'chatting' in ((request.responseContract?.jsonSchema as { properties?: Record<string, unknown> })?.properties ?? {});
}
test.each([false, true])('真实组合冷启动%s：用途先准备，两轮正文挂起期间均保持思考', async singleSlot => {
  let reply = deferred<ModelResponse>(); const calls: string[] = [];
  const f = await fixture({ respond: async request => {
    if (isBindings(request)) { calls.push('bindings'); return { type: 'structured', structured_output: bindings }; }
    if (request.responseContract) { calls.push('expression'); return noMatch; }
    calls.push('main'); return reply.promise;
  } }, singleSlot);
  for (let turn = 0; turn < 2; turn++) {
    reply = deferred<ModelResponse>();
    const running = f.coordinator.submit('你觉得今天怎么样？');
    await vi.waitFor(() => expect(calls.filter(item => item === 'main')).toHaveLength(turn + 1));
    expect(f.service.snapshot()?.stateId).toBe('state-7');
    expect(f.director.getChatContext().runtime).toMatchObject({ chatting: true, taskRunning: false });
    reply.resolve({ type: 'text', text: '我在。' }); await running;
  }
  expect(calls.filter(item => item === 'bindings')).toHaveLength(1);
});
test.each(['success', 'error'] as const)('真实任务%s直接表现结果，不发终态模型请求', async phase => {
  const requests: string[] = [];
  const f = await fixture({ respond: async request => {
    if (isBindings(request)) { requests.push('bindings'); return { type: 'structured', structured_output: bindings }; }
    if (request.responseContract) { requests.push('expression'); return noMatch; }
    requests.push('main'); return authorization;
  } });
  await f.coordinator.submit('读取测试目录中的文件内容');
  const card = f.events.find(event => event.type === 'capability_authorization_required');
  if (!card || card.type !== 'capability_authorization_required') throw new Error('缺少授权卡');
  expect(f.tasks.submit).not.toHaveBeenCalled();
  expect(f.director.getChatContext().runtime).toMatchObject({ awaitingConfirmation: true, taskRunning: false });
  await f.coordinator.resolveCapabilityAuthorization(card.requestId, 'confirm');
  await vi.waitFor(() => expect(f.tasks.submit).toHaveBeenCalledOnce());
  expect(f.service.snapshot()?.stateId).toBe('state-6');
  const before = requests.length;
  f.finishTask(phase);
  await vi.waitFor(() => expect(f.service.snapshot()?.stateId).toBe(phase === 'success' ? 'state-8' : 'state-5'));
  expect(requests).toHaveLength(before);
  // 结果追问虽然无需模型，也必须作为新互动结束旧结果片段并释放思考。
  await vi.waitFor(() => expect(f.events.some(event => event.type === 'phase' && event.phase === phase)).toBe(true));
  await f.coordinator.submit('上一个任务完成了吗');
  expect(requests).toHaveLength(before);
  expect(f.service.hasActiveSingleEpisode()).toBe(false);
  expect(f.director.getChatContext().runtime.chatting).toBe(false);
});
test('远程反应提前完成不会消耗慢正文的思考时间，正文结束再开心', async () => {
  const main = deferred<ModelResponse>();
  const f = await fixture({ respond: async request => {
    if (isBindings(request)) return { type: 'structured', structured_output: bindings };
    if (request.responseContract) return { type: 'structured', structured_output: { kind: 'reaction', choice: pair('state-8'), mode: 'keep', target: null, distance: null } };
    return main.promise;
  } });
  const running = f.coordinator.submit('你真棒');
  await vi.waitFor(() => expect(f.service.snapshot()?.stateId).toBe('state-7'));
  f.time(20_000);
  expect(f.service.snapshot()?.stateId).toBe('state-7');
  main.resolve({ type: 'text', text: '谢谢！' }); await running;
  expect(f.service.snapshot()?.stateId).toBe('state-8');
});

test('任务结果追问清除未陪伴背景，并拒绝上一轮迟到表现且不再请求模型', async () => {
  const late = deferred<ModelResponse>(); let lateSignal: AbortSignal | undefined; let requestCount = 0;
  const f = await fixture({ respond: async (request, signal) => {
    requestCount++;
    if (isBindings(request)) return { type: 'structured', structured_output: bindings };
    if (request.messages.at(-1)?.content === '普通聊天') {
      if (request.responseContract) { lateSignal = signal; return late.promise; }
      return { type: 'text', text: '我在。' };
    }
    return request.responseContract ? noMatch : authorization;
  } });
  await f.coordinator.submit('读取测试目录中的文件内容');
  const card = f.events.find(event => event.type === 'capability_authorization_required');
  if (!card || card.type !== 'capability_authorization_required') throw new Error('缺少授权卡');
  await f.coordinator.resolveCapabilityAuthorization(card.requestId, 'confirm');
  await vi.waitFor(() => expect(f.tasks.submit).toHaveBeenCalledOnce());
  f.finishTask('success');
  await vi.waitFor(() => expect(f.events.some(event => event.type === 'phase' && event.phase === 'success')).toBe(true));
  await f.coordinator.submit('普通聊天');
  expect(lateSignal).toBeDefined();
  f.time(300_000); expect(f.director.applyIdleBindings(300_000)).toBe(true);
  const before = requestCount;
  await f.coordinator.submit('上一个任务完成了吗');
  expect(requestCount).toBe(before);
  expect(lateSignal?.aborted).toBe(true);
  expect(f.service.snapshot()?.background).toBeNull();
  late.resolve({ type: 'structured', structured_output: { kind: 'reaction', choice: pair('state-8'), mode: 'keep', target: null, distance: null } });
  await vi.waitFor(() => expect(f.service.hasActiveSingleEpisode()).toBe(false));
  expect(f.service.snapshot()?.stateId).toBe('idle');
});

test('结果追问在表现结束通知内同步关闭时，旧调用不能复活会话或发布成功', async () => {
  const f = await fixture({ respond: async request => isBindings(request)
    ? { type: 'structured', structured_output: bindings } : request.responseContract ? noMatch : authorization });
  await f.coordinator.submit('读取测试目录中的文件内容');
  const card = f.events.find(event => event.type === 'capability_authorization_required');
  if (!card || card.type !== 'capability_authorization_required') throw new Error('缺少授权卡');
  await f.coordinator.resolveCapabilityAuthorization(card.requestId, 'confirm');
  await vi.waitFor(() => expect(f.tasks.submit).toHaveBeenCalledOnce());
  f.finishTask('success');
  await vi.waitFor(() => expect(f.events.some(event => event.type === 'phase' && event.phase === 'success')).toBe(true));
  const finish = f.director.handleChatResponseFinished.bind(f.director);
  vi.spyOn(f.director, 'handleChatResponseFinished').mockImplementationOnce(() => {
    finish(); void f.coordinator.close();
  });
  const before = f.events.length;
  await f.coordinator.submit('上一个任务完成了吗');
  expect(f.events.slice(before).some(event => event.type === 'phase' && event.phase === 'success')).toBe(false);
  await expect(f.coordinator.submit('继续聊天')).rejects.toMatchObject({ code: 'CONVERSATION_CLOSED' });
});
