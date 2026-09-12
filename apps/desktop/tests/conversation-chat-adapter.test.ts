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
test('主请求保留自然历史人设，原生任务申请同时具有独立表现', async () => {
  const p = provider({ type: 'tool_request', request: { requestId: 'call-1', toolName: 'request_task_authorization', arguments: {} } });
  const reply = await new ConversationChatAdapter(p).respond({ ...input, history: [{ role: 'user', content: '目录是不是很乱' }, { role: 'assistant', content: '尚未查看，可以先看看吗？' }], text: '可以，先看看' });
  const request = vi.mocked(p.respond).mock.calls[0]![0];
  expect(request.responseContract).toBeUndefined();
  expect(request.tools.map(tool => tool.function.name)).toEqual(['request_task_authorization']);
  expect(request).toMatchObject({ purpose: 'conversation', toolChoice: 'auto' });
  expect(JSON.stringify(request.messages)).toContain('伙伴');
  expect(request.messages.slice(-3).map(message => message.content)).toEqual(['目录是不是很乱', '尚未查看，可以先看看吗？', '可以，先看看']);
  expect(reply).toMatchObject({ text: '', capabilityPlan: { kind: 'agent_task' } });
  expect(vi.mocked(p.respond).mock.calls.filter(([request]) => !request.responseContract)).toHaveLength(1);
  expect(vi.mocked(p.respond).mock.calls[1]?.[0]).toMatchObject({ tools: [], toolChoice: 'none' });
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
test.each([{}, { requestId: '', toolName: 'request_task_authorization', arguments: {} }, { requestId: ' ', toolName: 'request_task_authorization', arguments: {} }, { requestId: '1', toolName: 'unknown', arguments: {} }, { requestId: '1', toolName: 'request_task_authorization', arguments: { path: 'x' } }])('非法原生申请失败且不重试主请求：%j', async request => {
  const p = provider({ type: 'tool_request', request });
  await expect(new ConversationChatAdapter(p).respond(input)).rejects.toMatchObject({ code: 'RESPONSE_FORMAT_UNSUPPORTED' });
  expect(vi.mocked(p.respond).mock.calls.filter(([request]) => !request.responseContract)).toHaveLength(1);
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
test('主请求格式失败不因并行表现而被改写为成功', async () => {
  const p = provider({ type: 'text', text: ' ' });
  await expect(new ConversationChatAdapter(p).respond(input)).rejects.toMatchObject({ code: 'RESPONSE_FORMAT_UNSUPPORTED' });
  expect(vi.mocked(p.respond).mock.calls.filter(([request]) => !request.responseContract)).toHaveLength(1);
});

test('非零运动控制缺少移动动作时，使用原用户短句补一次活动匹配', async () => {
  const movementContext = {
    ...input.behaviorContext,
    character: {
      ...input.behaviorContext.character,
      states: [{ stateId: 'run', name: '跑动', agentInferable: true, tags: [], actions: [{ actionId: 'run-action', name: '跑步', tags: [] }] }]
    }
  };
  const movement = { ...selection, requestKind: 'movement' as const, expressionPlan: null,
    movementControl: { kind: 'set_mode' as const, mode: 1 as const }, backgroundSelection: null };
  const activity = { moodUpdate: null, expressionPlan: { states: [{ stateId: 'run', score: 1,
    activity: 'moving' as const, actions: [{ actionId: 'run-action', score: 1 }] }] }, backgroundSelection: null };
  const p: ModelProvider = { respond: vi.fn(async request => {
    if (!request.responseContract) return { type: 'text' as const, text: '好的' };
    const schema = request.responseContract.jsonSchema as any;
    const isActivity = schema.properties?.expressionPlan?.anyOf?.[0]?.properties?.states?.items?.properties?.activity?.const === 'moving';
    return { type: 'structured' as const, structured_output: isActivity ? activity : movement };
  }) };

  const reply = await new ConversationChatAdapter(p).respond({ ...input, text: '请一直跑起来', behaviorContext: movementContext });

  expect(reply).toMatchObject({ movementControl: { kind: 'set_mode', mode: 1 }, expressionStatus: 'ready',
    expressionPlan: { states: [{ stateId: 'run', when: { moving: true } }] } });
  const activityRequest = vi.mocked(p.respond).mock.calls.at(-1)?.[0];
  expect(activityRequest?.responseContract?.jsonSchema).toMatchObject({ properties: {
    expressionPlan: { anyOf: [expect.objectContaining({ properties: { states: expect.any(Object) } }), { type: 'null' }] }
  } });
  expect(activityRequest?.messages.at(-1)?.content).toBe('请一直跑起来');
});

test('没有合法移动动作时，非零控制不改变持久模式并返回无匹配', async () => {
  const movement = { ...selection, requestKind: 'movement' as const, expressionPlan: null,
    movementControl: { kind: 'set_mode' as const, mode: 2 as const }, backgroundSelection: null };
  const emptyActivity = { moodUpdate: null, expressionPlan: null, backgroundSelection: null };
  const p: ModelProvider = { respond: vi.fn(async request => {
    if (!request.responseContract) return { type: 'text' as const, text: '好的' };
    const schema = request.responseContract.jsonSchema as any;
    const isActivity = schema.properties?.expressionPlan?.anyOf?.[0]?.properties?.states?.items?.properties?.activity?.const === 'moving';
    return { type: 'structured' as const, structured_output: isActivity ? emptyActivity : movement };
  }) };

  const reply = await new ConversationChatAdapter(p).respond({ ...input, text: '偶尔走动一下' });

  expect(reply).toMatchObject({ movementControl: { kind: 'keep' }, expressionStatus: 'no_match' });
  expect(p.respond).toHaveBeenCalledTimes(3);
});

test('显式移动意图即使表现首响应为keep，也会复用原句匹配moving动作', async () => {
  const movementContext = {
    ...input.behaviorContext,
    character: {
      ...input.behaviorContext.character,
      states: [{ stateId: 'run', name: '跑动', agentInferable: true, tags: [], actions: [{ actionId: 'run-action', name: '跑步', tags: [] }] }]
    }
  };
  const idleExpression = { ...selection, movementControl: { kind: 'keep' as const }, expressionPlan: null };
  const activity = { moodUpdate: null, expressionPlan: { states: [{ stateId: 'run', score: 1,
    activity: 'moving' as const, actions: [{ actionId: 'run-action', score: 1 }] }] }, backgroundSelection: null };
  const p: ModelProvider = { respond: vi.fn(async request => {
    if (!request.responseContract) return { type: 'text' as const, text: '好的' };
    const schema = request.responseContract.jsonSchema as any;
    const isActivity = schema.properties?.expressionPlan?.anyOf?.[0]?.properties?.states?.items?.properties?.activity?.const === 'moving';
    return { type: 'structured' as const, structured_output: isActivity ? activity : idleExpression };
  }) };

  const reply = await new ConversationChatAdapter(p).respond({ ...input, text: '去走一圈', behaviorContext: movementContext,
    movementIntentRequested: true });

  expect(reply).toMatchObject({ movementControl: { kind: 'keep' }, expressionStatus: 'ready',
    expressionPlan: { states: [{ stateId: 'run', when: { moving: true } }] } });
  expect(vi.mocked(p.respond).mock.calls.at(-1)?.[0].messages.at(-1)?.content).toBe('去走一圈');
});
