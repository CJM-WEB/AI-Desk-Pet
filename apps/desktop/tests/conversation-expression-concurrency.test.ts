import { expect, test, vi } from 'vitest';
import type { ModelProvider, ModelResponse } from '@myself/agent-core';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';

const context = {
  character: { idleStateId: 'idle', identity: { name: '伙伴', description: '', background: '', traits: [], languageStyle: '',
    formsOfAddress: [], likes: [], dislikes: [], behavioralTendencies: [], boundaries: [], exampleLines: [] }, states: [] },
  runtime: { moving: false, dragging: false, carrying: false, chatting: false, taskRunning: false, awaitingConfirmation: false, movementMode: 0 as const },
  proactivityMode: 'assistive' as const, recentActions: []
};
const selection: ModelResponse = { type: 'structured', structured_output: {
  kind: 'none', choice: null, mode: 'keep', target: null, distance: null
} };
const authorization: ModelResponse = { type: 'tool_request', request: { requestId: 'task-1', toolName: 'request_task_authorization', arguments: {} } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const input = () => ({ text: '看一下目录', history: [], behaviorContext: context, signal: new AbortController().signal });

test('远程主请求仍挂起时，独立表现已交付', async () => {
  const main = deferred<ModelResponse>();
  const delivered = deferred<void>();
  const events: string[] = [];
  const provider: ModelProvider = { respond: async request => {
    events.push(request.responseContract ? 'expression' : 'main');
    return request.responseContract ? selection : main.promise;
  } };
  const running = new ConversationChatAdapter(provider).respond({ ...input(), onExpression: reply => {
    expect(reply.expressionStatus).toBe('no_match'); events.push('delivered'); delivered.resolve();
  } });
  await vi.waitFor(() => expect(events).toContain('delivered'));
  expect(events).toEqual(['main', 'expression', 'delivered']);
  main.resolve({ type: 'text', text: '正文' });
  expect(await running).toMatchObject({ text: '正文' });
  await delivered.promise;
});

test('任务申请可先交付，表现随后仍独立完成', async () => {
  const expression = deferred<ModelResponse>();
  const delivered: string[] = [];
  const provider: ModelProvider = { respond: async request => request.responseContract ? expression.promise : authorization };
  const reply = await new ConversationChatAdapter(provider).respond({ ...input(), onExpression: value => { delivered.push(value.expressionStatus!); } });
  expect(reply.capabilityPlan?.kind).toBe('agent_task');
  expect(delivered).toEqual([]);
  expression.resolve(selection);
  await vi.waitFor(() => expect(delivered).toEqual(['no_match']));
});

test('单推理槽任务申请不额外推理表现，运行阶段由用途绑定承担', async () => {
  const expression = deferred<ModelResponse>();
  const events: string[] = [];
  const provider: ModelProvider = { respond: async request => {
    if (request.responseContract) { events.push('expression'); return expression.promise; }
    events.push('main'); return authorization;
  } };
  const running = new ConversationChatAdapter(provider, undefined, { singleSlot: true }).respond({
    ...input(), onExpression: () => { events.push('delivered'); }
  });
  expect((await running).capabilityPlan?.kind).toBe('agent_task');
  expect(events).toEqual(['main']);
});

test('主请求失败会撤销未交付的表现，迟到结果不能播放', async () => {
  const main = deferred<ModelResponse>(); const expression = deferred<ModelResponse>();
  let child: AbortSignal | undefined; const delivered: unknown[] = [];
  const provider: ModelProvider = { respond: async (request, signal) => {
    if (request.responseContract) { child = signal; return expression.promise; }
    return main.promise;
  } };
  const running = new ConversationChatAdapter(provider).respond({ ...input(), onExpression: reply => { delivered.push(reply); } });
  const rejected = expect(running).rejects.toMatchObject({ code: 'RESPONSE_FORMAT_UNSUPPORTED' });
  await vi.waitFor(() => expect(child).toBeDefined());
  main.resolve({ type: 'text', text: '' });
  await rejected;
  expect(child?.aborted).toBe(true);
  expression.resolve(selection);
  await Promise.resolve(); await Promise.resolve();
  expect(delivered).toEqual([]);
});
