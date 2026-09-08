import { expect, test, vi } from 'vitest';
import type { ModelProvider, ModelRequest } from '@myself/agent-core';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';
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
test('大量转义角色描述按实际请求字节裁剪且用户原文不变', async () => {
  const { adapter, requests } = fixture({ ...selection, expressionPlan: null });
  const huge = { ...behaviorContext, character: { ...behaviorContext.character, identity: { ...behaviorContext.character.identity, description: '\\"'.repeat(80000) } } };
  await adapter.respond({ ...input, behaviorContext: huge });
  for (const request of requests) {
    expect(Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools, responseSchema: request.responseContract?.jsonSchema ?? null }))).toBeLessThanOrEqual(65536);
    expect(request.messages.at(-1)?.content).toBe(input.text);
  }
});
