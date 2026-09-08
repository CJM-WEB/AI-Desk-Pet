import { expect, test, vi } from 'vitest';
import type { ModelProvider, ModelRequest, ModelResponse } from '@myself/agent-core';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';
const input = {
  text: '你好', history: [], signal: new AbortController().signal,
  behaviorContext: { character: { idleStateId: 'idle', identity: {
    name: '伙伴', description: '陪伴用户', background: '数字花园', traits: [], languageStyle: '简洁',
    formsOfAddress: [], likes: [], dislikes: [], behavioralTendencies: [], boundaries: [], exampleLines: []
  }, states: [] }, runtime: { chatting: false, taskRunning: false, awaitingConfirmation: false, moving: false, dragging: false, carrying: false, movementMode: 0 as const },
  proactivityMode: 'assistive' as const, recentActions: [] }
};
const selection = { moodUpdate: null, expressionPlan: null, requestKind: 'ambient', explicitPlayback: null, movementControl: { kind: 'keep' } };
function provider(...responses: ModelResponse[]): ModelProvider {
  return { respond: vi.fn(async () => responses.shift()!) };
}
test('主请求保留自然历史人设且唯一原生申请无需正文和表现', async () => {
  const p = provider({ type: 'tool_request', request: { requestId: 'call-1', toolName: 'request_task_authorization', arguments: {} } });
  const reply = await new ConversationChatAdapter(p).respond({ ...input, history: [{ role: 'user', content: '目录是不是很乱' }, { role: 'assistant', content: '尚未查看，可以先看看吗？' }], text: '可以，先看看' });
  const request = vi.mocked(p.respond).mock.calls[0]![0];
  expect(request.responseContract).toBeUndefined();
  expect(request.tools.map(tool => tool.function.name)).toEqual(['request_task_authorization']);
  expect(request).toMatchObject({ purpose: 'conversation', toolChoice: 'auto' });
  expect(JSON.stringify(request.messages)).toContain('伙伴');
  expect(request.messages.slice(-3).map(message => message.content)).toEqual(['目录是不是很乱', '尚未查看，可以先看看吗？', '可以，先看看']);
  expect(reply).toMatchObject({ text: '', capabilityPlan: { kind: 'agent_task' } });
  expect(p.respond).toHaveBeenCalledOnce();
});
test('静态能力JSON文本不申请任务，表现不含任务历史和首次正文', async () => {
  const text = '{"capabilityPlan":{"kind":"agent_task"}}';
  const p = provider({ type: 'text', text, structured_output: { capabilityPlan: { kind: 'agent_task' } } }, { type: 'structured', structured_output: selection });
  const reply = await new ConversationChatAdapter(p).respond({ ...input, history: [{ role: 'tool', content: 'PRIVATE_FILE_CONTENT', toolCallId: 'past' }] });
  expect(reply).toMatchObject({ text, capabilityPlan: { kind: 'chat' }, expressionStatus: 'no_match', expressionPlan: { states: [] } });
  const expression = vi.mocked(p.respond).mock.calls[1]![0];
  expect(expression).toMatchObject({ tools: [], toolChoice: 'none' });
  expect(expression.onTextDelta).toBeUndefined();
  expect(JSON.stringify(expression)).not.toContain('PRIVATE_FILE_CONTENT');
  expect(JSON.stringify(expression)).not.toContain('capabilityPlan');
  expect(expression.responseContract?.jsonSchema.properties).not.toHaveProperty('text');
  expect(expression.messages.at(-1)?.content).toBe(input.text);
});
test.each([{}, { requestId: '', toolName: 'request_task_authorization', arguments: {} }, { requestId: ' ', toolName: 'request_task_authorization', arguments: {} }, { requestId: '1', toolName: 'unknown', arguments: {} }, { requestId: '1', toolName: 'request_task_authorization', arguments: { path: 'x' } }])('非法原生申请失败且不发起表现：%j', async request => {
  const p = provider({ type: 'tool_request', request });
  await expect(new ConversationChatAdapter(p).respond(input)).rejects.toMatchObject({ code: 'RESPONSE_FORMAT_UNSUPPORTED' });
  expect(p.respond).toHaveBeenCalledOnce();
});
test.each([{ type: 'text', text: ' ' }, { type: 'structured', structured_output: { ...selection, text: '不得替换正文' } }, { type: 'structured', structured_output: { ...selection, moodUpdate: { summary: '开心', strength: 1, fadeInMs: 900 } } }] satisfies ModelResponse[])('表现非法保留首次正文且不修复：%j', async response => {
  const p = provider({ type: 'text', text: '  **原正文**\n' }, response);
  expect(await new ConversationChatAdapter(p).respond(input)).toMatchObject({ text: '  **原正文**\n', expressionStatus: 'failed' });
  expect(p.respond).toHaveBeenCalledTimes(2);
});
test('表现12秒超时中止子请求，保留正文且迟到计划失效', async () => {
  vi.useFakeTimers();
  try {
    let child: AbortSignal | undefined;
    let late!: (response: ModelResponse) => void;
    const p: ModelProvider = { respond: async (request, signal) => {
      if (!request.responseContract) return { type: 'text', text: '正文' };
      child = signal;
      return new Promise(resolve => { late = resolve; });
    } };
    const result = new ConversationChatAdapter(p).respond(input);
    await vi.advanceTimersByTimeAsync(12_000);
    const reply = await result;
    expect(reply).toMatchObject({ text: '正文', expressionStatus: 'failed' });
    expect(reply).not.toHaveProperty('expressionPlan');
    expect(child?.aborted).toBe(true);
    expect(input.signal.aborted).toBe(false);
    late({ type: 'structured', structured_output: selection });
    await Promise.resolve();
    expect(reply).not.toHaveProperty('expressionPlan');
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
test('父取消使不响应取消的表现和整轮立即失效', async () => {
  const controller = new AbortController();
  let calls = 0;
  const p: ModelProvider = { respond: async () => ++calls === 1 ? { type: 'text', text: '旧正文' } : new Promise(() => undefined) };
  const result = new ConversationChatAdapter(p).respond({ ...input, signal: controller.signal });
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve(); await Promise.resolve(); controller.abort();
  await rejected;
});
test('主请求失败或取消均不会启动表现', async () => {
  const p = provider({ type: 'text', text: ' ' });
  await expect(new ConversationChatAdapter(p).respond(input)).rejects.toMatchObject({ code: 'RESPONSE_FORMAT_UNSUPPORTED' });
  expect(p.respond).toHaveBeenCalledOnce();
});
