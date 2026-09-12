import { describe, expect, it } from 'vitest';
import type { ModelProvider, ModelRequest, ModelResponse } from '@myself/agent-core';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';

/** 可控 Provider 只代替网络，真实 Adapter 负责独立表现目录、请求及严格接纳。 */
function fixture() {
  const character = { idleStateId: 's0', identity: { name: '林间伙伴', description: '爱分享的狐狸',
    background: '从山林来', traits: ['热情'], languageStyle: '短句', formsOfAddress: ['朋友'],
    likes: ['阳光'], dislikes: ['争吵'], behavioralTendencies: ['摇尾巴'], boundaries: ['不辱骂'], exampleLines: ['今天真好！'] },
    states: Array.from({ length: 40 }, (_, i) => ({ stateId: `s${i}`, name: `姿态${i}`, agentInferable: true,
      description: i === 39 ? '听到获奖喜讯，兴奋地甩尾巴' : `休息姿态${i}`, tags: [],
      actions: [{ actionId: `a${i}`, name: `动作${i}`, description: i === 39 ? '分享得奖快乐时大幅甩尾' : '安静等候', tags: [] }] })) };
  const behaviorContext = { character, runtime: { chatting: false, taskRunning: false, awaitingConfirmation: false, moving: false, dragging: false, carrying: false, movementMode: 0 as const },
    proactivityMode: 'assistive' as const, recentActions: [],
    expression: { stateId: 's0', actionId: 'a0', mood: null } };
  const requests: ModelRequest[] = [];
  const controls = { kind: 'none', choice: null, mode: 'keep', target: null, distance: null };
  const responses: ModelResponse[] = [{ type: 'text', text: '真为你开心！' }, { type: 'structured', structured_output: controls }];
  const provider: ModelProvider = { respond: async request => { requests.push(request); return responses.shift()!; } };
  const input = { text: '我获奖了，想看你兴奋地甩尾巴', history: [], behaviorContext, signal: new AbortController().signal };
  return { character, behaviorContext, requests, responses, provider, input, controls };
}


/** 通过实际表现消息查找公开目录，不依赖system数组位置。 */
function catalogFrom(request: ModelRequest) {
  const message = request.messages.find(message => message.content.startsWith('Main公开情境与候选：'))!;
  return JSON.parse(message.content.slice(message.content.indexOf('{'))).character;
}
describe('独立角色描述决策接线', () => {
  it('按实际请求字节预算裁剪历史与角色文字，主请求保留当前原文', async () => {
    const f = fixture();
    f.character.identity.description = '描述😀'.repeat(400);
    f.character.identity.background = '背景🌙'.repeat(800);
    f.input.text = '用户当前输入😀'.repeat(300);
    await new ConversationChatAdapter(f.provider, () => undefined, { inputByteBudget: 19200 }).respond({ ...f.input,
      history: Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: '旧历史'.repeat(600) })) });
    expect(f.requests).toHaveLength(2);
    for (const request of f.requests) expect(Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools, responseSchema: request.responseContract?.jsonSchema ?? null }))).toBeLessThanOrEqual(19200);
    expect(f.requests[0]!.messages.at(-1)?.content).toBe(f.input.text);
  });
  it('精简反应只接纳本轮描述召回并实际发送的合法动作配对', async () => {
    const f = fixture();
    f.responses[1] = { type: 'structured', structured_output: { ...f.controls,
      kind: 'reaction', choice: { stateId: 's39', actionId: 'a39' } } };
    const reply = await new ConversationChatAdapter(f.provider).respond(f.input);
    expect(reply.expressionPlan?.states[0]?.actions).toEqual([{ actionId: 'a39', score: 1 }]);
    expect(catalogFrom(f.requests[1]!).states).toContainEqual(expect.objectContaining({ stateId: 's39' }));
  });
  it.each(['未发送', '错误归属'])('模型%s的配对整份表现拒绝且保留主正文', async kind => {
    const f = fixture();
    const provider: ModelProvider = { respond: async request => {
      if (!request.responseContract) return { type: 'text', text: '合法正文' };
      const catalog = catalogFrom(request);
      const hidden = f.character.states.find(state => !catalog.states.some((item: { stateId: string }) => item.stateId === state.stateId))!;
      return { type: 'structured', structured_output: { ...f.controls, kind: 'reaction',
        choice: { stateId: kind === '未发送' ? hidden.stateId : 's39',
          actionId: kind === '未发送' ? hidden.actions[0]!.actionId : 'a0' } } };
    } };
    expect(await new ConversationChatAdapter(provider).respond(f.input)).toEqual({ text: '合法正文', capabilityPlan: { kind: 'chat' }, expressionStatus: 'failed' });
  });
  it('角色全部人设字段进入独立system消息，描述召回目录末尾候选', async () => {
    const f = fixture();
    await new ConversationChatAdapter(f.provider).respond(f.input);
    const persona = f.requests[1]!.messages.find(message => message.content.startsWith('角色公开人设：'))!;
    const parsed = JSON.parse(persona.content.slice(persona.content.indexOf('{')));
    expect(parsed).toEqual(f.character.identity);
    expect(catalogFrom(f.requests[1]!).states).toContainEqual(expect.objectContaining({ stateId: 's39', actions: [expect.objectContaining({ actionId: 'a39' })] }));
  });
});
