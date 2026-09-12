import { expect, test, vi } from 'vitest';
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
const selection = { moodUpdate: { summary: '开心', strength: .8 }, expressionPlan: { states: [{ stateId: 'joy', score: 1, activity: null, actions: [{ actionId: 'wave', score: 1 }] }] }, requestKind: 'ambient', explicitPlayback: null, movementControl: { kind: 'keep' } };
function fixture(output: Record<string, unknown>) {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = { respond: async request => { requests.push(request); return request.responseContract ? { type: 'structured', structured_output: output } : { type: 'text', text: '你好' }; } };
  return { requests, adapter: new ConversationChatAdapter(provider) };
}
const input = { text: '表现得开心一点', history: [], behaviorContext, signal: new AbortController().signal };
test('自然运动请求收到三档位移含义和原地表现边界', async () => {
  const { adapter, requests } = fixture(selection);
  await adapter.respond({ ...input, text: '之后你隔一会儿动一下就好' });
  const instructions = requests[1]!.messages.filter(message => message.role === 'system')
    .map(message => message.content).join('\n');
  expect(instructions).toContain('0=静止 / 1=一直运动 / 2=间断运动');
  expect(instructions).toContain('停止位移不停止原地动画');
  expect(instructions).toContain('明确原地播放仍用state/action');
});
test.each(['background', 'episode', 'moving'] as const)('运动请求的%s选择不能变成原地长期跑动', async kind => {
  const state = { stateId: 'joy', score: 1, activity: kind === 'moving' ? 'moving' : null,
    actions: [{ actionId: 'wave', score: 1 }] };
  const { adapter } = fixture({ ...selection, requestKind: 'movement', explicitPlayback: null,
    movementControl: { kind: 'set_mode', mode: 1 },
    expressionPlan: kind === 'background' ? null : { states: [state] },
    backgroundSelection: { stateId: 'joy', actions: [{ actionId: 'wave', score: 1 }] }
  });
  const reply = await adapter.respond({ ...input, text: '我想让你一直动起来' });
  expect(reply).not.toHaveProperty('backgroundSelection');
  expect(reply.movementControl).toEqual(kind === 'moving' ? { kind: 'set_mode', mode: 1 } : { kind: 'keep' });
  expect(reply.expressionPlan?.states ?? []).toEqual(kind === 'moving'
    ? [expect.objectContaining({ stateId: 'joy', when: { moving: true }, lifetime: 'condition' })] : []);
});
test('运动请求保留其他真实活动候选，明确原地播放保持独立语义', async () => {
  const task = fixture({ ...selection, requestKind: 'movement', explicitPlayback: null,
    movementControl: { kind: 'move_once', target: 'random_work_area', distance: 'near' },
    expressionPlan: { states: [{ ...selection.expressionPlan.states[0], activity: 'taskRunning' }] }
  });
  expect(await task.adapter.respond(input)).toMatchObject({
    expressionPlan: { states: [{ when: { taskRunning: true }, lifetime: 'condition' }] }
  });
  const playback = fixture({ ...selection, requestKind: 'action', expressionPlan: null,
    explicitPlayback: { stateId: 'joy', actionId: 'wave' }, backgroundSelection: null
  });
  expect(await playback.adapter.respond({ ...input, text: '原地表演一下这个动作' })).toMatchObject({
    requestKind: 'action', explicitPlayback: { stateId: 'joy', actionId: 'wave' },
    movementControl: { kind: 'keep' }, expressionStatus: 'ready'
  });
});
test.each([
  { kind: 'set_mode', mode: 1 }, { kind: 'set_mode', mode: 2 },
  { kind: 'move_once', target: 'random_work_area', distance: 'near' }
])('明确原地表现不能由矛盾的%s控制额外授权位移', async movementControl => {
  const { adapter } = fixture({ ...selection, requestKind: 'action', expressionPlan: null,
    explicitPlayback: { stateId: 'joy', actionId: 'wave' }, movementControl
  });
  expect(await adapter.respond({ ...input, text: '原地播放一次开心的动作' })).toMatchObject({
    requestKind: 'action', explicitPlayback: { stateId: 'joy', actionId: 'wave' },
    movementControl: { kind: 'keep' }, expressionStatus: 'ready'
  });
});
test('明确状态允许同时停止位移，不能反向开始移动', async () => {
  const { adapter } = fixture({ ...selection, requestKind: 'state', expressionPlan: null,
    explicitPlayback: { stateId: 'joy' }, movementControl: { kind: 'set_mode', mode: 0 }
  });
  expect(await adapter.respond({ ...input, text: '停下来保持这个状态' })).toMatchObject({
    explicitPlayback: { stateId: 'joy' }, movementControl: { kind: 'set_mode', mode: 0 }
  });
});
test('精简语义转为宿主episode、阈值与零淡入，不接受模型时间字段', async () => {
  const { adapter, requests } = fixture(selection);
  expect(await adapter.respond(input)).toMatchObject({ expressionStatus: 'ready', moodUpdate: { summary: '开心', strength: .8, fadeInMs: 0 }, expressionPlan: { states: [{ lifetime: 'episode', minStrength: .02, maxStrength: 1 }] } });
  const schema = JSON.stringify(requests[1]!.responseContract!.jsonSchema);
  for (const field of ['fadeInMs', 'halfLifeMs', 'validForMs', 'when', 'lifetime', 'text']) expect(schema).not.toContain('"' + field + '"');
});
test('非固定Gate的明确状态可选择不可推断配对，但不能混进普通计划', async () => {
  const { adapter, requests } = fixture({ ...selection, expressionPlan: null, requestKind: 'state', explicitPlayback: { stateId: 'locked' } });
  expect(await adapter.respond(input)).toMatchObject({ explicitPlayback: { stateId: 'locked' }, requestKind: 'state', expressionStatus: 'ready' });
  expect(JSON.stringify(requests[1]!.messages)).toContain('locked');
  const bad = fixture({ ...selection, expressionPlan: { states: [{ stateId: 'locked', score: 1, activity: null, actions: [{ actionId: 'rest', score: 1 }] }] } });
  expect(await bad.adapter.respond(input)).toMatchObject({ expressionStatus: 'failed' });
});
test('合法明确目标不被同状态的非法普通候选连带丢弃', async () => {
  const { adapter } = fixture({
    ...selection,
    requestKind: 'state',
    explicitPlayback: { stateId: 'locked' },
    backgroundSelection: {
      stateId: 'locked', actions: [{ actionId: 'rest', score: 1 }]
    },
    expressionPlan: {
      states: [{
        stateId: 'locked', score: 2, activity: null,
        actions: [{ actionId: 'rest', score: 1 }]
      }]
    }
  });

  const reply = await adapter.respond(input);

  expect(reply).toMatchObject({
    requestKind: 'state',
    explicitPlayback: { stateId: 'locked' },
    expressionStatus: 'ready'
  });
  expect(reply.expressionPlan?.states ?? []).not.toContainEqual(
    expect.objectContaining({ stateId: 'locked' })
  );
  expect(reply).not.toHaveProperty('backgroundSelection');
});
test('未知明确目标仍失败，合法请求类型在无目标时保留用于反馈', async () => {
  const unknown = fixture({
    ...selection,
    expressionPlan: null,
    requestKind: 'state',
    explicitPlayback: { stateId: 'unknown' }
  });
  expect(await unknown.adapter.respond(input)).toMatchObject({ expressionStatus: 'failed' });

  const noMatch = fixture({
    ...selection,
    expressionPlan: null,
    requestKind: 'state',
    explicitPlayback: null
  });
  expect(await noMatch.adapter.respond(input)).toMatchObject({
    requestKind: 'state', expressionStatus: 'no_match'
  });

  const extraField = fixture({ ...selection, unexpected: true });
  expect(await extraField.adapter.respond(input)).toMatchObject({ expressionStatus: 'failed' });
});
test.each(['foreign', 'rest'])('跨状态或未知动作配对%s不接纳', async actionId => {
  const { adapter } = fixture({ ...selection, expressionPlan: { states: [{ ...selection.expressionPlan.states[0], actions: [{ actionId, score: 1 }] }] } });
  expect(await adapter.respond(input)).toMatchObject({ expressionStatus: 'failed' });
});
test('自主无正文无工具、预算拒绝零调用，成功只返回心情和计划', async () => {
  const { adapter, requests } = fixture({ moodUpdate: selection.moodUpdate, expressionPlan: selection.expressionPlan });
  expect(await adapter.respondAutonomous({ behaviorContext, idleForMs: 6000, signal: input.signal, beforeProviderCall: () => false })).toBeNull();
  expect(requests).toHaveLength(0);
  const result = await adapter.respondAutonomous({ behaviorContext, idleForMs: 6000, signal: input.signal, beforeProviderCall: () => true });
  expect(result).toMatchObject({ moodUpdate: { summary: '开心', strength: .8 }, expressionPlan: { states: [{ lifetime: 'episode' }] } });
  expect(result?.moodUpdate).not.toHaveProperty('fadeInMs');
  expect(Object.keys(result!)).toEqual(['moodUpdate', 'expressionPlan']);
  expect(requests[0]).toMatchObject({ tools: [], toolChoice: 'none' });
  expect(JSON.stringify(requests[0]!.messages)).not.toContain('locked');
});
test('长期背景独立校验并为空动作补齐本轮已展示合法动作', async () => {
  const situation = {
    idleForMs: 6000, sessionForMs: 60_000, localHour: 14,
    lastInteractionKind: 'chat' as const, interactionCount: 2,
    stateForMs: 3000, backgroundForMs: 20_000,
    activities: {}, taskPhase: null, lastTask: null
  };
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    respond: async request => {
      requests.push(request);
      return { type: 'structured', structured_output: {
        moodUpdate: null,
        expressionPlan: null,
        backgroundSelection: { stateId: 'joy', actions: [] }
      } };
    }
  };
  const adapter = new CharacterExpressionAdapter(provider);

  const result = await adapter.respond({
    behaviorContext: { ...behaviorContext, situation }, idleForMs: 6000, signal: input.signal
  }, 'autonomous');

  expect(result?.backgroundSelection).toEqual({
    stateId: 'joy', actions: [{ actionId: 'wave', score: 1 }]
  });
  expect(requests[0]!.responseContract?.jsonSchema).toMatchObject({
    required: expect.arrayContaining(['backgroundSelection']),
    properties: { backgroundSelection: expect.any(Object) }
  });
  const contextMessage = requests[0]!.messages.find(message =>
    message.role === 'system' && message.content.startsWith('Main公开情境与候选：')
  )!;
  expect(JSON.parse(contextMessage.content.slice('Main公开情境与候选：'.length)).situation).toEqual(situation);

  const invalid = new CharacterExpressionAdapter({
    respond: async () => ({ type: 'structured', structured_output: {
      moodUpdate: null,
      expressionPlan: null,
      backgroundSelection: { stateId: 'unknown', actions: [] }
    } })
  });
  await expect(invalid.respond({
    behaviorContext, idleForMs: 6000, signal: input.signal
  }, 'autonomous')).rejects.toMatchObject({ code: 'CONTROL_SCHEMA_INVALID' });
});
test('合法长期背景不被非法普通候选连带丢弃', async () => {
  const adapter = new CharacterExpressionAdapter({
    respond: async () => ({ type: 'structured', structured_output: {
      moodUpdate: null,
      backgroundSelection: {
        stateId: 'joy', actions: [{ actionId: 'wave', score: 1 }]
      },
      expressionPlan: {
        states: [{
          stateId: 'locked', score: 1, activity: null,
          actions: [{ actionId: 'rest', score: 1 }]
        }]
      }
    } })
  });

  const result = await adapter.respond({
    behaviorContext, idleForMs: 6000, signal: input.signal
  }, 'autonomous');

  expect(result?.backgroundSelection).toEqual({
    stateId: 'joy', actions: [{ actionId: 'wave', score: 1 }]
  });
  expect(result?.expressionPlan?.states ?? []).toEqual([]);
});
test('活动匹配只接纳moving且不发布心情或位移，预算回调保留', async () => {
  const { adapter, requests } = fixture({ moodUpdate: null, expressionPlan: { states: [{ ...selection.expressionPlan.states[0], activity: 'moving' }] } });
  const beforeProviderCall = vi.fn(() => true);
  const result = await adapter.respondActivity({ behaviorContext, signal: input.signal, beforeProviderCall });
  expect(result).toMatchObject({ expressionPlan: { states: [{ when: { moving: true }, lifetime: 'condition', minStrength: 0 }] } });
  expect(Object.keys(result!)).toEqual(['expressionPlan']);
  expect(beforeProviderCall).toHaveBeenCalledOnce();
  expect(requests[0]).toMatchObject({ tools: [], toolChoice: 'none' });
  const invalid = fixture({ moodUpdate: null, expressionPlan: selection.expressionPlan });
  await expect(invalid.adapter.respondActivity({ behaviorContext, signal: input.signal, beforeProviderCall: () => true })).rejects.toMatchObject({ code: 'CONTROL_SCHEMA_INVALID' });
});
test('活动准备的同源Schema只允许moving配对，保留明确无匹配', async () => {
  const { adapter, requests } = fixture({ moodUpdate: null, expressionPlan: null, backgroundSelection: null });
  await adapter.respondActivity({ behaviorContext: { ...behaviorContext, runtime: { ...behaviorContext.runtime, movementMode: 1 } },
    signal: input.signal, beforeProviderCall: () => true });
  expect(requests[0]!.messages[0]!.content).toContain('静止、待机、休息或原地表现不能标记为moving');
  expect(requests[0]!.responseContract).toMatchObject({ name: 'character_autonomy', jsonSchema: { properties: {
    moodUpdate: { type: 'null' }, backgroundSelection: { type: 'null' },
    expressionPlan: { anyOf: [expect.objectContaining({ properties: { states: expect.objectContaining({
      items: expect.objectContaining({ properties: expect.objectContaining({ activity: { const: 'moving' } }) })
    }) } }), { type: 'null' }] }
  } } });
});
test.each(['chat', 'activity'] as const)('请求%s说明用户位移和Main活动匹配均为准备，不能用未开始事实拒绝候选', async mode => {
  const requests: ModelRequest[] = [];
  const adapter = new CharacterExpressionAdapter({ respond: async request => {
    requests.push(request);
    return { type: 'structured', structured_output: mode === 'chat'
      ? { ...selection, expressionPlan: null, backgroundSelection: null }
      : { moodUpdate: null, expressionPlan: null, backgroundSelection: null } };
  } });
  await adapter.respond({ text: '我想让你一直动起来', behaviorContext, signal: input.signal }, mode);
  const instructions = requests[0]!.messages[0]!.content;
  expect(instructions).toContain('用户本轮要求位移');
  expect(instructions).toContain('Main的activity匹配');
  expect(instructions).toContain('均属于移动准备');
  expect(instructions).toContain('不能因moving=false或缺少pendingMovement漏选');
});
test('大量转义角色描述按实际请求字节裁剪且用户原文不变', async () => {
  const { adapter, requests } = fixture({ ...selection, expressionPlan: null });
  const huge = { ...behaviorContext, character: { ...behaviorContext.character, identity: { ...behaviorContext.character.identity, description: '\\"'.repeat(80000) } } };
  await adapter.respond({ ...input, behaviorContext: huge });
  for (const request of requests) {
    expect(Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools, responseSchema: request.responseContract?.jsonSchema ?? null }))).toBeLessThanOrEqual(65536);
    expect(request.messages.at(-1)?.content).toBe(input.text);
  }
});
test.each([
  ['请进入状态29', 'state', { stateId: 'state-29' }],
  ['请执行动作29', 'action', { stateId: 'state-29', actionId: 'action-29' }]
] as const)('小预算对“%s”先移除无关候选并完整保留明确目标描述', async (text, requestKind, explicitPlayback) => {
  const targetDescription = '这是用户明确要求的长期安静陪伴状态。'.repeat(12);
  const backgroundDescription = '这是当前正在保持的长期背景状态。'.repeat(12);
  const states = Array.from({ length: 30 }, (_, index) => ({
    stateId: `state-${index}`,
    name: `状态${index}`,
    description: index === 29 ? targetDescription : index === 28 ? backgroundDescription
      : `与本轮请求无关的候选${index}。`.repeat(16),
    agentInferable: true,
    tags: [],
    actions: [{
      actionId: `action-${index}`,
      name: `动作${index}`,
      description: `候选动作说明${index}。`.repeat(16),
      tags: []
    }]
  }));
  const context = {
    ...behaviorContext,
    character: { ...behaviorContext.character, states },
    expression: {
      stateId: 'state-27', actionId: 'action-27', backgroundStateId: 'state-28', mood: null
    }
  };
  const output = {
    ...selection,
    expressionPlan: null,
    requestKind,
    explicitPlayback
  };
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    respond: async request => {
      requests.push(request);
      return request.responseContract
        ? { type: 'structured' as const, structured_output: output }
        : { type: 'text' as const, text: '好。' };
    }
  };
  const adapter = new ConversationChatAdapter(provider, undefined, { inputByteBudget: 12_000 });

  const reply = await adapter.respond({ ...input, text, behaviorContext: context });

  expect(reply).toMatchObject({ explicitPlayback, expressionStatus: 'ready' });
  const contextMessage = requests[1]!.messages.find(message =>
    message.role === 'system' && message.content.startsWith('Main公开情境与候选：')
  )!;
  const projected = JSON.parse(contextMessage.content.slice('Main公开情境与候选：'.length));
  expect(projected.character.states).toContainEqual(
    expect.objectContaining({ stateId: 'state-29', description: targetDescription })
  );
  expect(projected.character.states).toContainEqual(
    expect.objectContaining({ stateId: 'state-28', description: backgroundDescription })
  );
  expect(projected.character.states.length).toBeLessThan(24);
});

test('真实任务终态使用独立触发语义，不携带任务正文或伪造闲置时间', async () => {
  const { adapter, requests } = fixture({ moodUpdate: null, expressionPlan: null, backgroundSelection: null });
  await adapter.respondAutonomous({ behaviorContext, idleForMs: 450_000, signal: new AbortController().signal,
    beforeProviderCall: () => true, taskEvent: 'error' });
  const messages = JSON.stringify(requests[0]!.messages);
  expect(messages).toContain('task-event');
  expect(messages).toContain('error');
  expect(messages).toContain('450000');
  expect(messages).not.toContain('结合闲置时间和当前心情重新评估');
  expect(requests[0]).toMatchObject({ tools: [], toolChoice: 'none' });
});

test('表现请求向Provider明确传递持续目标一致性与候选克制约束', async () => {
  const { adapter, requests } = fixture(selection);
  await adapter.respond({ ...input, text: '请保持这个状态，直到我再叫你。' });
  const instruction = requests[1]!.messages[0]!.content;
  expect(instruction).toContain('explicitPlayback与backgroundSelection必须选择同一目标stateId');
  expect(instruction).toContain('不能把同一stateId重复放入activity=null的短时计划');
  expect(instruction).toContain('没有新依据时用null保持原背景');
  expect(requests[1]).toMatchObject({ tools: [], toolChoice: 'none', reasoningMode: 'disabled' });
});

test('单次动作和任务反馈提示不重置长期背景', async () => {
  const chat = fixture(selection);
  await chat.adapter.respond({ ...input, text: '只播放一次这个动作。' });
  expect(chat.requests[1]!.messages[0]!.content).toContain('单次动作backgroundSelection必须为null');
  const task = fixture({ moodUpdate: null, expressionPlan: null, backgroundSelection: null });
  await task.adapter.respondAutonomous({ behaviorContext, idleForMs: 0, taskEvent: 'success', beforeProviderCall: () => true, signal: new AbortController().signal });
  expect(task.requests[0]!.messages[0]!.content).toContain('任务终态的backgroundSelection必须为null');
});

test.each([
  { activity: 'chatting', backgroundSelection: null },
  { activity: null, backgroundSelection: { stateId: 'joy', actions: [{ actionId: 'wave', score: 1 }] } }
])('任务终态拒绝活动条件与背景改写：%j', async invalidFields => {
  const output = { moodUpdate: null, expressionPlan: { states: [{
    stateId: 'joy', score: 1, activity: invalidFields.activity, actions: [{ actionId: 'wave', score: 1 }]
  }] }, backgroundSelection: invalidFields.backgroundSelection };
  let contract: ModelRequest['responseContract'];
  const adapter = new CharacterExpressionAdapter({ respond: async request => {
    contract = request.responseContract;
    return { type: 'structured', structured_output: output };
  } });
  await expect(adapter.respond({ behaviorContext, taskEvent: 'success', signal: new AbortController().signal }, 'task-event')).rejects.toThrow('CONTROL_SCHEMA_INVALID');
  expect(contract?.validateStructuredOutput?.(output)).toBe(false);
});

test('任务终态使用同源精简Schema只生成无活动条件的短时反应', async () => {
  const output = { moodUpdate: { summary: '任务完成', strength: .8 }, expressionPlan: {
    states: [{ stateId: 'joy', score: 1, activity: null, actions: [{ actionId: 'wave', score: 1 }] }]
  }, backgroundSelection: null };
  let contract: ModelRequest['responseContract'];
  const adapter = new CharacterExpressionAdapter({ respond: async request => {
    contract = request.responseContract;
    return { type: 'structured', structured_output: output };
  } });
  const result = await adapter.respond({ behaviorContext, taskEvent: 'success', signal: new AbortController().signal }, 'task-event');
  expect(result?.expressionPlan?.states[0]).toMatchObject({ stateId: 'joy', lifetime: 'episode' });
  expect(result).not.toHaveProperty('backgroundSelection');
  expect(contract?.validateStructuredOutput?.(output)).toBe(true);
  expect(contract?.jsonSchema).toMatchObject({ properties: {
    backgroundSelection: { type: 'null' },
    expressionPlan: { anyOf: [expect.objectContaining({ properties: { states: expect.objectContaining({
      items: expect.objectContaining({ properties: expect.objectContaining({ activity: { type: 'null' } }) })
    }) } }), { type: 'null' }] }
  } });
});
