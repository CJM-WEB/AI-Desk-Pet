import { expect, test } from 'vitest';
import type { ModelProvider, ModelRequest } from '@myself/agent-core';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';
import { CharacterExpressionAdapter } from '../src/main/conversation/character-expression-adapter';
const behaviorContext = {
  character: { idleStateId: 'idle', identity: { name: '伙伴', description: '陪伴', background: '', traits: [], languageStyle: '', formsOfAddress: [], likes: [], dislikes: [], behavioralTendencies: [], boundaries: [], exampleLines: [] }, states: [
    { stateId: 'joy', name: '开心', agentInferable: true, tags: [], actions: [{ actionId: 'wave', name: '挥手', tags: [] }] },
    { stateId: 'locked', name: '安静', agentInferable: false, tags: [], actions: [{ actionId: 'rest', name: '休息', tags: [] }] }
  ] }, runtime: { chatting: false, taskRunning: false, awaitingConfirmation: false, moving: false, dragging: false, carrying: false, movementMode: 0 as const },
  proactivityMode: 'assistive' as const, recentActions: []
};
const choice = { stateId: 'joy', actionId: 'wave' };
const selection = { kind: 'reaction', choice, mode: 'keep', target: null, distance: null };
// 夹具只返回新平铺协议；内部表现计划由正式 Adapter 生成。
function fixture(output: Record<string, unknown>) {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = { respond: async request => {
    requests.push(request);
    return request.responseContract ? { type: 'structured', structured_output: output } : { type: 'text', text: '你好' };
  } };
  return { requests, adapter: new ConversationChatAdapter(provider), expression: new CharacterExpressionAdapter(provider) };
}
const input = { text: '表现得开心一点', history: [], behaviorContext, signal: new AbortController().signal };
const expressionRequest = (requests: ModelRequest[]) => requests.find(request => request.responseContract)!;

test('明确结束长期状态保留null并作为成功控制交付，不误报无匹配', async () => {
  const { adapter } = fixture({ ...selection, kind: 'background', choice: null });
  const reply = await adapter.respond({ ...input, text: '起来吧，不要再休息了' });
  expect(reply).toMatchObject({ backgroundSelection: null, expressionStatus: 'ready', movementControl: { kind: 'keep' } });
  expect(reply).not.toHaveProperty('explicitPlayback');
});

test('自主空背景配对不能被解释为用户要求结束长期状态', async () => {
  const { expression } = fixture({ ...selection, kind: 'background', choice: null });
  await expect(expression.respond(input, 'autonomous')).rejects.toMatchObject({ code: 'CONTROL_SCHEMA_INVALID' });
});

test('自然运动请求保留三档位移、原地表现与零工具边界', async () => {
  const { adapter, requests } = fixture(selection);
  await adapter.respond({ ...input, text: '之后你隔一会儿动一下就好' });
  const request = expressionRequest(requests);
  const instructions = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  expect(instructions).toContain('0=静止 / 1=一直运动 / 2=间断运动');
  expect(instructions).toContain('停止位移不停止原地动画');
  expect(instructions).toContain('明确原地播放仍用state/action');
  expect(request).toMatchObject({ tools: [], toolChoice: 'none', reasoningMode: 'disabled' });
  expect(request.responseContract?.jsonSchema.required).toEqual(['kind', 'choice', 'mode', 'target', 'distance']);
});

test.each(['continuous', 'intermittent', 'once'] as const)('运动%s只能产生真实moving适用候选，不能变成原地背景', async mode => {
  const { expression } = fixture({ ...selection, kind: 'movement', mode,
    target: mode === 'once' ? 'left' : null, distance: mode === 'once' ? 'near' : null });
  const reply = await expression.respond(input, 'chat');
  expect(reply).toMatchObject({ requestKind: 'movement', expressionPlan: {
    states: [{ stateId: 'joy', when: { moving: true }, lifetime: 'condition', minStrength: 0 }]
  } });
  expect(reply?.movementControl).toEqual(mode === 'once'
    ? { kind: 'move_once', target: 'left', distance: 'near' }
    : { kind: 'set_mode', mode: mode === 'continuous' ? 1 : 2 });
  expect(reply).not.toHaveProperty('backgroundSelection');
  expect(reply).not.toHaveProperty('explicitPlayback');
});

test.each(['state', 'action'] as const)('明确原地%s允许关闭推断的合法配对且不授权位移', async kind => {
  const explicit = { stateId: 'locked', actionId: 'rest' };
  const { adapter, requests } = fixture({ ...selection, kind, choice: explicit });
  expect(await adapter.respond(input)).toMatchObject({
    requestKind: kind, explicitPlayback: explicit, movementControl: { kind: 'keep' }, expressionStatus: 'ready'
  });
  expect(JSON.stringify(expressionRequest(requests).messages)).toContain('locked');
});

test.each(['continuous', 'intermittent', 'once'] as const)('明确原地动作的矛盾%s控制整包拒绝，不能授权位移', async mode => {
  const { adapter } = fixture({ ...selection, kind: 'action', mode,
    target: mode === 'once' ? 'left' : null, distance: mode === 'once' ? 'near' : null });
  const reply = await adapter.respond({ ...input, text: '原地播放一次开心的动作' });
  expect(reply).toMatchObject({ expressionStatus: 'failed' });
  expect(reply).not.toHaveProperty('movementControl');
  expect(reply).not.toHaveProperty('explicitPlayback');
});

test('明确状态可同时停止位移，停止不依赖动画匹配', async () => {
  const { adapter } = fixture({ ...selection, kind: 'state', mode: 'still' });
  expect(await adapter.respond({ ...input, text: '停下来保持这个状态' })).toMatchObject({
    explicitPlayback: choice, movementControl: { kind: 'set_mode', mode: 0 }
  });
  const stop = fixture({ ...selection, kind: 'movement', choice: null, mode: 'still' });
  expect(await stop.expression.respond(input, 'chat')).toMatchObject({
    movementControl: { kind: 'set_mode', mode: 0 }, expressionPlan: { states: [] }
  });
});

test('Main已经处理位移时保留moving候选但不重复提交运动控制', async () => {
  const { expression } = fixture({ ...selection, kind: 'movement', mode: 'continuous' });
  expect(await expression.respond({ ...input, movementControlHandled: true }, 'chat')).toMatchObject({
    movementControl: { kind: 'keep' },
    expressionPlan: { states: [{ when: { moving: true }, lifetime: 'condition' }] }
  });
});

test('反应的生命周期和强度门槛由宿主生成，不能携带模型时间或心情字段', async () => {
  const { adapter, requests } = fixture(selection);
  const reply = await adapter.respond(input);
  expect(reply).toMatchObject({ expressionStatus: 'ready', expressionPlan: {
    states: [{ lifetime: 'episode', minStrength: 0, maxStrength: 1 }]
  } });
  expect(reply).not.toHaveProperty('moodUpdate');
  expect(reply.expressionPlan?.states[0]).not.toHaveProperty('when');
  const schema = JSON.stringify(expressionRequest(requests).responseContract!.jsonSchema);
  for (const field of ['fadeInMs', 'halfLifeMs', 'validForMs', 'when', 'lifetime', 'moodUpdate', 'text', 'expressionPlan']) {
    expect(schema).not.toContain('"' + field + '"');
  }
});

test.each(['reaction', 'background'] as const)('关闭推断的状态不能进入%s', async kind => {
  const { adapter } = fixture({ ...selection, kind, choice: { stateId: 'locked', actionId: 'rest' } });
  expect(await adapter.respond(input)).toMatchObject({ expressionStatus: 'failed' });
});

test.each([
  { stateId: 'unknown', actionId: 'wave' },
  { stateId: 'joy', actionId: 'foreign' },
  { stateId: 'joy', actionId: 'rest' },
  { stateId: 'joy' }
])('未知ID、跨状态动作或缺动作的明确目标均拒绝：%j', async target => {
  const { adapter } = fixture({ ...selection, kind: 'action', choice: target });
  expect(await adapter.respond(input)).toMatchObject({ expressionStatus: 'failed' });
});

test.each(['state', 'action'] as const)('明确%s无匹配仍保留请求类型供准确反馈', async kind => {
  const { adapter } = fixture({ ...selection, kind, choice: null });
  expect(await adapter.respond(input)).toMatchObject({ requestKind: kind, expressionStatus: 'no_match' });
});

test.each([
  { unexpected: true }, { moodUpdate: { summary: '完成', strength: 1 } },
  { expressionPlan: { states: [] } }, { backgroundSelection: { stateId: 'joy', actions: [] } }
])('退役wire字段和额外字段不再作为兼容入口：%j', async extra => {
  const { adapter } = fixture({ ...selection, ...extra });
  expect(await adapter.respond(input)).toMatchObject({ expressionStatus: 'failed' });
});

test('自主请求预算拒绝零调用，成功仅交付表现且排除不可推断目录', async () => {
  const { adapter, requests } = fixture(selection);
  const autonomous = { behaviorContext, idleForMs: 6000, signal: input.signal };
  expect(await adapter.respondAutonomous({ ...autonomous, beforeProviderCall: () => false })).toBeNull();
  expect(requests).toHaveLength(0);
  const result = await adapter.respondAutonomous({ ...autonomous, beforeProviderCall: () => true });
  expect(result).toMatchObject({ expressionPlan: { states: [{ lifetime: 'episode' }] } });
  expect(Object.keys(result!)).toEqual(['expressionPlan']);
  expect(requests[0]).toMatchObject({ tools: [], toolChoice: 'none' });
  expect(JSON.stringify(requests[0]!.messages)).not.toContain('locked');
});

test.each([
  { ...selection, kind: 'action' },
  { ...selection, kind: 'movement', mode: 'continuous' },
  { ...selection, kind: 'background', mode: 'still' }
])('自主请求拒绝明确播放与运动控制：%j', async output => {
  const { expression } = fixture(output);
  await expect(expression.respond(input, 'autonomous')).rejects.toMatchObject({ code: 'CONTROL_SCHEMA_INVALID' });
});

test('长期背景使用唯一合法配对并保留真实公开情境，空选择保持已有背景', async () => {
  const situation = { idleForMs: 6000, sessionForMs: 60_000, localHour: 14,
    lastInteractionKind: 'chat' as const, interactionCount: 2, stateForMs: 3000, backgroundForMs: 20_000,
    activities: {}, taskPhase: null, lastTask: null };
  const { expression, requests } = fixture({ ...selection, kind: 'background' });
  const result = await expression.respond({ ...input, behaviorContext: { ...behaviorContext, situation }, idleForMs: 6000 }, 'autonomous');
  expect(result?.backgroundSelection).toEqual({ stateId: 'joy', actions: [{ actionId: 'wave', score: 1 }] });
  expect(result?.expressionPlan?.states).toEqual([]);
  expect(result).not.toHaveProperty('explicitPlayback');
  const message = requests[0]!.messages.find(message => message.content.startsWith('Main公开情境与候选：'))!;
  expect(JSON.parse(message.content.slice('Main公开情境与候选：'.length)).situation).toEqual(situation);
  const keep = fixture({ ...selection, kind: 'none', choice: null });
  expect(await keep.expression.respond(input, 'autonomous')).not.toHaveProperty('backgroundSelection');
});

test('明确持续选择同时生成同目标背景与明确播放，单次动作不改背景', async () => {
  const background = fixture({ ...selection, kind: 'background' });
  expect(await background.expression.respond(input, 'chat')).toMatchObject({
    requestKind: 'state', explicitPlayback: choice,
    backgroundSelection: { stateId: 'joy', actions: [{ actionId: 'wave', score: 1 }] },
    expressionPlan: { states: [] }
  });
  const action = fixture({ ...selection, kind: 'action' });
  expect(await action.expression.respond(input, 'chat')).not.toHaveProperty('backgroundSelection');
});

test('大量转义角色描述按实际请求字节裁剪且用户原文不变', async () => {
  const { adapter, requests } = fixture({ ...selection, kind: 'none', choice: null });
  const huge = { ...behaviorContext, character: { ...behaviorContext.character, identity: {
    ...behaviorContext.character.identity, description: '\\"'.repeat(80000)
  } } };
  await adapter.respond({ ...input, behaviorContext: huge });
  for (const request of requests) {
    expect(Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools,
      responseSchema: request.responseContract?.jsonSchema ?? null }))).toBeLessThanOrEqual(65536);
    expect(request.messages.at(-1)?.content).toBe(input.text);
  }
});

test.each([['请进入状态29', 'state'], ['请执行动作29', 'action']] as const)(
  '小预算对“%s”先移除无关候选并完整保留明确目标描述', async (text, kind) => {
    const targetDescription = '这是用户明确要求的长期安静陪伴状态。'.repeat(12);
    const backgroundDescription = '这是当前正在保持的长期背景状态。'.repeat(12);
    const states = Array.from({ length: 30 }, (_, index) => ({
      stateId: 'state-' + index, name: '状态' + index,
      description: index === 29 ? targetDescription : index === 28 ? backgroundDescription
        : ('与本轮请求无关的候选' + index + '。').repeat(16),
      agentInferable: true, tags: [], actions: [{ actionId: 'action-' + index, name: '动作' + index,
        description: ('候选动作说明' + index + '。').repeat(16), tags: [] }]
    }));
    const context = { ...behaviorContext, character: { ...behaviorContext.character, states },
      expression: { stateId: 'state-27', actionId: 'action-27', backgroundStateId: 'state-28', mood: null } };
    const requests: ModelRequest[] = [];
    const target = { stateId: 'state-29', actionId: 'action-29' };
    const provider: ModelProvider = { respond: async request => {
      requests.push(request);
      return request.responseContract
        ? { type: 'structured', structured_output: { ...selection, kind, choice: target } }
        : { type: 'text', text: '好。' };
    } };
    const reply = await new ConversationChatAdapter(provider, undefined, { inputByteBudget: 12_000 })
      .respond({ ...input, text, behaviorContext: context });
    expect(reply).toMatchObject({ explicitPlayback: target, expressionStatus: 'ready' });
    const message = expressionRequest(requests).messages.find(message => message.content.startsWith('Main公开情境与候选：'))!;
    const projected = JSON.parse(message.content.slice('Main公开情境与候选：'.length));
    expect(projected.character.states).toContainEqual(expect.objectContaining({ stateId: 'state-29', description: targetDescription }));
    expect(projected.character.states).toContainEqual(expect.objectContaining({ stateId: 'state-28', description: backgroundDescription }));
    expect(projected.character.states.length).toBeLessThan(24);
  }
);
