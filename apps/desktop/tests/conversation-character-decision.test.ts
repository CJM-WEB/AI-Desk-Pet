import { describe, expect, it } from 'vitest';
import type { ModelProvider, ModelRequest, ModelResponse } from '@myself/agent-core';
import { selectBehaviorCandidates } from '@myself/character-runtime';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';

/** 可控 Provider 只代替网络，真实 Adapter 负责目录、请求及分区接纳。 */
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
  const controls = { movementControl: { kind: 'keep' }, capabilityPlan: { kind: 'chat' } };
  const responses: ModelResponse[] = [{ type: 'text', text: '真为你开心！', structured_output: controls }];
  const provider: ModelProvider = { respond: async request => { requests.push(request); return responses.shift()!; } };
  const input = { text: '我获奖了，想看你兴奋地甩尾巴', history: [], behaviorContext, signal: new AbortController().signal };
  return { character, behaviorContext, requests, responses, provider, input, controls };
}

describe('角色描述决策接线', () => {
  it('null 与旧省略都独立保留正文，合法无更新不发修复请求', async () => {
    for (const fields of [{ moodUpdate: null, expressionPlan: null }, {}]) {
      const f = fixture();
      f.responses.splice(0, 1, { type: 'text', text: '继续陪你聊。', structured_output: { ...f.controls, ...fields } });
      const reply = await new ConversationChatAdapter(f.provider).respond(f.input);
      expect(reply).toEqual({ text: '继续陪你聊。', ...f.controls });
      expect(f.requests).toHaveLength(1);
    }
  });
  it('修复坏计划不把首次合法 null 心情改成新事件', async () => {
    const f = fixture();
    f.responses.splice(0, 1,
      { type: 'text', text: '保留正文', structured_output: { ...f.controls, moodUpdate: null, expressionPlan: { states: '坏计划' } } },
      { type: 'text', text: '修复正文', structured_output: { ...f.controls, moodUpdate: { summary: '修复伪造的新事件', strength: 1 }, expressionPlan: { states: [] } } });
    const reply = await new ConversationChatAdapter(f.provider).respond(f.input);
    expect(reply).toMatchObject({ text: '保留正文', expressionPlan: { states: [] }, ...f.controls });
    expect(reply).not.toHaveProperty('moodUpdate');
    expect(f.requests).toHaveLength(2);
  });
  it('修复越界明确播放不能覆盖首次 null 计划，合法心情仍独立保留', async () => {
    for (const moodUpdate of [null, { summary: '新的感受', strength: .7 }]) {
      const f = fixture();
      f.responses.splice(0, 1,
        { type: 'text', text: '保留正文', structured_output: { ...f.controls, moodUpdate, expressionPlan: null,
          explicitPlayback: { stateId: 's39', actionId: 'a39' } } },
        { type: 'text', text: '修复正文', structured_output: { ...f.controls, moodUpdate: null, expressionPlan: { states: [] } } });
      const reply = await new ConversationChatAdapter(f.provider).respond(f.input);
      expect(reply).toMatchObject({ text: '保留正文', ...f.controls });
      expect(reply).not.toHaveProperty('expressionPlan');
      expect(reply).not.toHaveProperty('explicitPlayback');
      if (moodUpdate) expect(reply.moodUpdate).toMatchObject(moodUpdate);
      else expect(reply).not.toHaveProperty('moodUpdate');
      expect(f.requests).toHaveLength(2);
    }
  });
  it('未知表现字段和重复坏正文不吞独立合法建议，未知字段本身不接纳', async () => {
    const f = fixture();
    f.responses.splice(0, 1, { type: 'text', text: '首次合法正文', structured_output: {
      text: 42, activity: '退役字段', movementControl: { kind: 'set_mode', mode: 1 },
      capabilityPlan: { kind: 'agent_task' }, moodUpdate: { summary: '专注', strength: .5 }
    } });
    const reply = await new ConversationChatAdapter(f.provider).respond(f.input);
    expect(reply).toMatchObject({ text: '首次合法正文', movementControl: { kind: 'set_mode', mode: 1 },
      capabilityPlan: { kind: 'agent_task' }, moodUpdate: { summary: '专注', strength: .5 } });
    expect(reply).not.toHaveProperty('activity');
    expect(f.requests).toHaveLength(1);
  });
  it('总请求按本地上限裁剪历史及角色可选文字，保留当前输入和每个人设字段', async () => {
    const f = fixture();
    f.character.identity.description = '描述😀'.repeat(400);
    f.character.identity.background = '背景🌙'.repeat(800);
    f.character.identity.traits = Array.from({ length: 32 }, () => '开朗😀'.repeat(30));
    f.input.text = '用户当前输入😀'.repeat(300);
    f.responses.splice(0, 1,
      { type: 'text', text: '正文', structured_output: { ...f.controls, moodUpdate: { summary: '界'.repeat(240), strength: 1 }, expressionPlan: { states: 'bad' } } },
      { type: 'text', text: '修复', structured_output: f.controls });
    const input = { ...f.input, history: Array.from({ length: 16 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: '旧历史'.repeat(600) })) };
    await new ConversationChatAdapter(f.provider, () => undefined, { inputByteBudget: 19200 }).respond(input);
    const request = f.requests[0]!;
    expect(f.requests).toHaveLength(2);
    for (const sent of f.requests) expect(Buffer.byteLength(JSON.stringify({ messages: sent.messages, tools: sent.tools, responseSchema: sent.responseContract?.jsonSchema ?? null }))).toBeLessThanOrEqual(19200);
    expect(request.messages.at(-1)?.content).toBe(input.text);
    const persona = JSON.parse(request.messages[1]!.content.slice(request.messages[1]!.content.indexOf('{')));
    expect(Object.keys(persona).sort()).toEqual(Object.keys(f.character.identity).sort());
    for (const message of request.messages) expect(Array.from(message.content).some(character => character.length === 1 && /[\uD800-\uDFFF]/u.test(character))).toBe(false);
    const visible = JSON.parse(request.messages[2]!.content.slice(request.messages[2]!.content.indexOf('{'))).character.states;
    const exploration = selectBehaviorCandidates(f.character, { text: input.text, sequence: 0, currentStateId: 's0' }).states.at(-1)!;
    expect(visible.some((state: { stateId: string }) => state.stateId === exploration.stateId)).toBe(true);
  });
  it('空动作建议只使用本次发送动作的作者权重，不扩大到未发出动作', async () => {
    const f = fixture();
    f.responses.splice(0, 1, { type: 'text', text: '正文', structured_output: { ...f.controls,
      expressionPlan: { states: [{ stateId: 's39', score: 1, minStrength: 0, maxStrength: 1, actions: [] }] } } });
    const reply = await new ConversationChatAdapter(f.provider).respond(f.input);
    expect(reply.expressionPlan?.states[0]?.actions).toEqual([{ actionId: 'a39', score: 1 }]);
  });
  it.each(['未发送', '错误归属'])('模型%s的ID不能进入计划，合法心情仍保留', async kind => {
    const f = fixture();
    const provider: ModelProvider = { respond: async request => {
      f.requests.push(request);
      const content = request.messages[2]!.content;
      const catalog = JSON.parse(content.slice(content.indexOf('{'))).character;
      const hidden = f.character.states.find(state => !catalog.states.some((item: { stateId: string }) => item.stateId === state.stateId))!;
      return { type: 'text', text: '合法正文', structured_output: { ...f.controls,
        moodUpdate: { summary: '开心', strength: .8 }, expressionPlan: { states: [{
          stateId: kind === '未发送' ? hidden.stateId : 's39', score: 1, minStrength: 0, maxStrength: 1,
          actions: [{ actionId: kind === '未发送' ? hidden.actions[0]!.actionId : 'a0', score: 1 }]
        }] } } };
    } };
    const reply = await new ConversationChatAdapter(provider).respond(f.input);
    expect(reply.moodUpdate?.summary).toBe('开心'); expect(reply.expressionPlan).toBeUndefined();
    expect(f.requests).toHaveLength(2);
  });
  it('两套人设全部字段进入独立系统段，并召回目录末尾的描述', async () => {
    for (const name of ['林间伙伴', '月下诗人']) {
      const f = fixture(); f.character.identity.name = name;
      await new ConversationChatAdapter(f.provider).respond(f.input);
      const systems = f.requests[0]!.messages.filter(message => message.role === 'system');
      const persona = systems.find(message => message.content.includes('角色人设'))!;
      expect(persona).toBeDefined();
      for (const value of Object.values(f.character.identity).flat()) expect(persona.content).toContain(value);
      const wire = JSON.stringify(f.requests[0]);
      expect(wire).toContain('s39'); expect(wire).toContain('分享得奖快乐');
      expect(f.requests[0]).toMatchObject({ tools: [], toolChoice: 'none' });
    }
  });
  it('坏计划保留首个合法心情、正文、运动及 chat，修复不能追加文件任务', async () => {
    const f = fixture();
    f.responses.splice(0, 1,
      { type: 'text', text: '  **喜讯**  ', structured_output: { ...f.controls,
        moodUpdate: { summary: '开心', strength: .8 }, expressionPlan: { states: '坏计划' } } },
      { type: 'text', text: '修复正文', structured_output: { movementControl: { kind: 'set_mode', mode: 1 },
        capabilityPlan: { kind: 'agent_task' }, moodUpdate: { summary: '被改掉', strength: .1 },
        expressionPlan: { states: [{ stateId: 's39', score: 1, minStrength: .2, maxStrength: 1, actions: [{ actionId: 'a39', score: 1 }] }] } } });
    const reply = await new ConversationChatAdapter(f.provider).respond(f.input);
    expect(reply).toMatchObject({ text: '  **喜讯**  ', moodUpdate: { summary: '开心', strength: .8 },
      movementControl: { kind: 'keep' }, capabilityPlan: { kind: 'chat' }, expressionPlan: { states: [{ stateId: 's39' }] } });
    expect(f.requests).toHaveLength(2);
    for (const request of f.requests) expect(request).toMatchObject({ tools: [], toolChoice: 'none' });
  });
  it('表现无效时不吞首个合法 agent_task，修复失败也不丢合法心情', async () => {
    const f = fixture();
    f.responses.splice(0, 1,
      { type: 'text', text: '申请范围', structured_output: { ...f.controls, capabilityPlan: { kind: 'agent_task' },
        moodUpdate: { summary: '专注', strength: .5 }, expressionPlan: { states: [{ stateId: 'unknown' }] } } },
      { type: 'text', text: '坏修复', structured_output: { ...f.controls, expressionPlan: { states: '仍坏' } } });
    expect(await new ConversationChatAdapter(f.provider).respond(f.input)).toMatchObject({
      text: '申请范围', moodUpdate: { summary: '专注', strength: .5 }, capabilityPlan: { kind: 'agent_task' } });
  });
});
