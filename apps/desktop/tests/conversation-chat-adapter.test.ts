import { expect, test, vi } from 'vitest';
import type { ModelProvider, ModelResponse } from '@myself/agent-core';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';
const input = {
  text: '你好', history: [], signal: new AbortController().signal,
  behaviorContext: { character: { idleStateId: 'idle', identity: {
    name: '伙伴', description: '陪伴用户', background: '数字花园', traits: [], languageStyle: '简洁',
    formsOfAddress: [], likes: [], dislikes: [], behavioralTendencies: [], boundaries: [], exampleLines: []
  }, states: [] }, runtime: { chatting: false, taskRunning: false, awaitingConfirmation: false, moving: false, dragging: false, carrying: false, movementMode: 0 as const },
  proactivityMode: 'assistive' as const, recentActions: [] }
};
const controls = { movementControl: { kind: 'keep' }, capabilityPlan: { kind: 'chat' } };
function provider(...responses: ModelResponse[]): ModelProvider {
  return { respond: vi.fn(async () => responses.shift()!) };
}
test('独立合法正文保留原始Markdown及空白，控制错误的修复正文不能覆盖它', async () => {
  const p = provider({ type: 'text', text: '  **正文**\n', structured_output: { ...controls, expressionPlan: { states: 'bad' } } },
    { type: 'text', text: '另一正文', structured_output: controls });
  expect((await new ConversationChatAdapter(p).respond(input)).text).toBe('  **正文**\n');
  expect(p.respond).toHaveBeenCalledTimes(2);
});
test('旧行为字段被丢弃且不影响合法能力建议', async () => {
  const p = provider({ type: 'text', text: '正文', structured_output: { ...controls, capabilityPlan: { kind: 'agent_task' }, activity: '旧控制' } },
    { type: 'text', text: '修复', structured_output: { ...controls, capabilityPlan: { kind: 'agent_task' } } });
  const reply = await new ConversationChatAdapter(p).respond(input);
  expect(reply).toEqual({ text: '正文', ...controls, capabilityPlan: { kind: 'agent_task' } });
});
test('任务建议坏时保留合法运动，运动坏时保留合法任务建议', async () => {
  for (const [output, expected] of [
    [{ movementControl: { kind: 'set_mode', mode: 0 }, capabilityPlan: { kind: 'unknown' } }, { movementControl: { kind: 'set_mode', mode: 0 } }],
    [{ movementControl: { kind: 'set_mode', mode: 8 }, capabilityPlan: { kind: 'agent_task' } }, { capabilityPlan: { kind: 'agent_task' } }]
  ] as const) expect(await new ConversationChatAdapter(provider({ type: 'text', text: '正文', structured_output: output })).respond(input)).toEqual({ text: '正文', ...expected });
});
test('非法可见正文和工具响应仍失败，诊断失败不覆盖原错误', async () => {
  for (const response of [{ type: 'text', text: ' ' }, { type: 'tool_request', request: {} }] satisfies ModelResponse[]) {
    const report = vi.fn(() => { throw new Error('private-diagnostic'); });
    await expect(new ConversationChatAdapter(provider(response), report).respond(input)).rejects.toMatchObject({ code: 'RESPONSE_FORMAT_UNSUPPORTED' });
    expect(report).toHaveBeenCalledOnce();
  }
});
test('普通正文兼容不产生工具，修复取消遵守同一AbortSignal且不重发增量', async () => {
  const controller = new AbortController();
  const delta = vi.fn(); let calls = 0;
  const p: ModelProvider = { respond: async (request, signal) => {
    expect(request.tools).toEqual([]); expect(request.toolChoice).toBe('none');
    if (++calls === 1) return { type: 'text', text: '正文' };
    expect(request.onTextDelta).toBeUndefined();
    controller.abort(); throw new DOMException('Cancelled', 'AbortError');
  } };
  await expect(new ConversationChatAdapter(p).respond({ ...input, signal: controller.signal, onTextDelta: delta })).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls).toBe(2);
});

test.each([false, true])('条件建议经过正常输出或修复（%s）保留 when/lifetime 并教模型真实 pending 含义', async repair => {
  const expressionPlan = { states: [{ stateId: 'custom', score: 1, minStrength: 0, maxStrength: 1,
    when: { moving: true }, lifetime: 'condition', actions: [{ actionId: 'custom-action', score: 1, when: { carrying: false } }] }] };
  const requests: Parameters<ModelProvider['respond']>[0][] = [];
  const p: ModelProvider = { respond: async request => {
    requests.push(request);
    return { type: 'text', text: '走一小段', structured_output: { ...controls, moodUpdate: null,
      expressionPlan: repair && requests.length === 1 ? { states: 'bad' } : expressionPlan } };
  } };
  const reply = await new ConversationChatAdapter(p).respond({ ...input, text: '向左一点', movementControlHandled: true,
    behaviorContext: { ...input.behaviorContext, runtime: { ...input.behaviorContext.runtime, pendingMovement: true },
      character: { ...input.behaviorContext.character, states: [{ stateId: 'custom', name: '云游', description: '身体随空间位移轻轻摆动', tags: [], agentInferable: true,
        actions: [{ actionId: 'custom-action', name: '轻摆', tags: [] }] }] } } });
  expect(reply.expressionPlan).toMatchObject(expressionPlan);
  expect(requests).toHaveLength(repair ? 2 : 1);
  for (const request of requests) {
    expect(request.tools).toEqual([]);
    const instruction = request.messages[0]!.content;
    expect(instruction).toContain('when'); expect(instruction).toContain('lifetime');
    expect(instruction).toContain('pendingMovement'); expect(instruction).toContain('moving=true');
    expect(instruction).toContain('描述');
  }
});
