import { expect, test, vi } from 'vitest';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';
import type { ModelProvider, ModelResponse } from '@myself/agent-core';
const context = { character: { idleStateId: 'idle', identity: { name: '伙伴', description: '', background: '', traits: [], languageStyle: '',
  formsOfAddress: [], likes: [], dislikes: [], behavioralTendencies: [], boundaries: [], exampleLines: [] }, states: [] },
  runtime: { chatting: true, taskRunning: false, awaitingConfirmation: false, moving: false, dragging: false, carrying: false, movementMode: 0 as const },
  proactivityMode: 'assistive' as const, recentActions: [] };
const noExpression = { kind: 'none', choice: null, mode: 'keep', target: null, distance: null };
const input = { text: '你好', history: [], behaviorContext: context, signal: new AbortController().signal };
test('单槽主请求先运行，普通表现之后独立交付且不阻塞正文', async () => {
  let finishMain!: (value: ModelResponse) => void;
  let finishExpression!: (value: ModelResponse) => void;
  const calls: string[] = [];
  const provider: ModelProvider = { respond: request => { const purpose = request.responseContract ? 'expression' : 'main'; calls.push(purpose);
    return new Promise(resolve => { if (purpose === 'main') finishMain = resolve; else finishExpression = resolve; }); } };
  const onExpression = vi.fn();
  const pending = new ConversationChatAdapter(provider, undefined, { singleSlot: true }).respond({ ...input, onExpression });
  expect(calls).toEqual(['main']);
  finishMain({ type: 'text', text: '你好！' });
  expect(await pending).toMatchObject({ text: '你好！' });
  expect(calls).toEqual(['main', 'expression']);
  expect(onExpression).not.toHaveBeenCalled();
  finishExpression({ type: 'structured', structured_output: noExpression });
  await vi.waitFor(() => expect(onExpression).toHaveBeenCalledOnce());
});
test('单槽任务申请使用已准备的事件用途，不在授权后与Core争用推理槽', async () => {
  const provider: ModelProvider = { respond: vi.fn(async () => ({ type: 'tool_request' as const,
    request: { requestId: 'scope', toolName: 'request_task_authorization', arguments: {} } })) };
  const reply = await new ConversationChatAdapter(provider, undefined, { singleSlot: true }).respond(input);
  expect(reply.capabilityPlan?.kind).toBe('agent_task');
  expect(provider.respond).toHaveBeenCalledOnce();
});
