import type { ModelProvider, ModelRequest, ModelResponse } from '@myself/agent-core';
import {
  characterChatResponseJsonSchema,
  PUBLIC_BEHAVIOR_CATALOG_UTF8_BYTE_BUDGET
} from '@myself/character-runtime';
import { describe, expect, test, vi } from 'vitest';
import { ProviderError } from '../src/main/providers/openai-provider';
import {
  ConversationChatAdapter,
  PUBLIC_CHARACTER_CHAT_SYSTEM_UTF8_BYTE_BUDGET
} from '../src/main/conversation/conversation-chat-adapter';

const behaviorContext = {
  character: {
    identity: {
      name: '小橘', description: '友好的桌面伙伴', background: '来自数字花园', traits: ['friendly'],
      languageStyle: '简洁', likes: ['阳光'], behavioralTendencies: ['主动陪伴']
    },
    states: [{
      name: '开心', stateId: 'state-754', tags: ['friendly'],
      actions: [{ name: '挥手', actionId: 'action-828', tags: ['friendly'] }]
    }]
  },
  runtime: {
    moving: false,
    dragging: false,
    carrying: false,
    movementMode: 2 as const
  },
  proactivityMode: 'assistive' as const,
  recentActions: ['挥手']
};

function 过大公开目录() {
  const actions = Array.from({ length: 100 }, (_, index) => ({
    name: `共享动作${index}`,
    actionId: 'action-1191',
    description: `动作说明${index}${'甲'.repeat(1_990)}`,
    tags: Array.from({ length: 32 }, (_, tagIndex) => `tag-${tagIndex}`)
  }));
  return {
    identity: {
      name: '压力角色', description: '角'.repeat(2_000), background: '景'.repeat(4_000),
      traits: [], languageStyle: '语'.repeat(500), likes: [], behavioralTendencies: []
    },
    states: Array.from({ length: 100 }, (_, index) => ({
      name: `共享状态${index}`,
      stateId: 'action-1647',
      description: `状态说明${index}${'乙'.repeat(1_990)}`,
      tags: [],
      actions
    }))
  };
}

function 响应为(response: ModelResponse): ModelProvider {
  return {
    respond: vi.fn(async () => response)
  };
}

function 完整控制字段(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activity: '安静陪伴',
    status: 'idle',
    movementControl: { kind: 'keep' },
    behaviorPlan: { kind: 'none' },
    capabilityPlan: { kind: 'chat' },
    ...overrides
  };
}

function 取得请求(provider: ModelProvider): ModelRequest {
  const 调用 = vi.mocked(provider.respond).mock.calls[0];
  if (!调用) throw new Error('未收到模型请求');
  return 调用[0];
}

describe('ConversationChatAdapter', () => {
  test.each(['首次', '修复'])('%s完整控制字段含未知外层时只保留首次正文，不产出任务建议', async stage => {
    const unknownOuter = 完整控制字段({
      capabilityPlan: { kind: 'agent_task' }, permission: 'approved'
    });
    const responses: ModelResponse[] = [
      { type: 'text', text: '首次正文', structured_output: stage === '首次'
        ? unknownOuter
        : 完整控制字段({ behaviorPlan: { kind: 'none', emotion: 'neutral' } }) },
      { type: 'text', text: '修复正文', structured_output: stage === '修复' ? unknownOuter : {} }
    ];
    const provider: ModelProvider = { respond: vi.fn(async () => responses.shift()!) };
    await expect(new ConversationChatAdapter(provider).respond({
      history: [], text: '帮我看看 note.txt', behaviorContext, signal: new AbortController().signal
    })).resolves.toEqual({ text: '首次正文' });
    expect(provider.respond).toHaveBeenCalledTimes(2);
  });

  test.each(['合法任务', '非法能力', '未知外层', '修复任务'])('控制修复保留合法独立建议且不提升非法候选：%s', async kind => {
    const first = 完整控制字段({
      behaviorPlan: { kind: 'none', emotion: 'neutral' },
      capabilityPlan: kind === '修复任务' ? { kind: 'chat' } : {
        kind: 'agent_task', ...(kind === '非法能力' ? { authorized: true } : {})
      },
      ...(kind === '未知外层' ? { permission: 'approved' } : {})
    });
    const responses: ModelResponse[] = [
      { type: 'text', text: '首次正文', structured_output: first },
      { type: 'text', text: '修复正文', structured_output: 完整控制字段({
        behaviorPlan: { kind: 'none', emotion: 'calm' },
        capabilityPlan: { kind: kind === '修复任务' ? 'agent_task' : 'chat' }
      }) }
    ];
    const provider: ModelProvider = { respond: vi.fn(async () => responses.shift()!) };
    const reply = await new ConversationChatAdapter(provider).respond({ history: [], text: '帮我看看 note.txt', behaviorContext, signal: new AbortController().signal });
    expect(reply).toEqual({
      text: '首次正文', activity: '安静陪伴', status: 'idle', movementControl: { kind: 'keep' },
      behaviorPlan: { kind: 'none', emotion: 'calm' }, emotion: 'calm',
      capabilityPlan: { kind: kind === '合法任务' || kind === '修复任务' ? 'agent_task' : 'chat' }
    });
    expect(provider.respond).toHaveBeenCalledTimes(2);
    for (const [request] of vi.mocked(provider.respond).mock.calls) {
      expect(request).toMatchObject({ tools: [], toolChoice: 'none' });
    }
  });

  test('表现情绪无效且修复仍失败时保留严格任务建议，不提交任何表现控制', async () => {
    const provider = 响应为({ type: 'text', text: '准备读取。', structured_output: 完整控制字段({
      behaviorPlan: { kind: 'none', emotion: 'neutral' },
      capabilityPlan: { kind: 'agent_task' }
    }) });
    const reply = await new ConversationChatAdapter(provider).respond({ history: [], text: '帮我看看 note.txt 里写了什么，把内容显示给我。', behaviorContext, signal: new AbortController().signal });
    expect(reply).toEqual({ text: '准备读取。', capabilityPlan: { kind: 'agent_task' } });
  });

  test.each(['capability', 'outer'])('表现降级不接纳带未知字段的%s候选', async kind => {
    const output = 完整控制字段({ behaviorPlan: { kind: 'none', emotion: 'neutral' },
      capabilityPlan: { kind: 'agent_task', ...(kind === 'capability' ? { authorized: true } : {}) },
      ...(kind === 'outer' ? { permission: 'approved' } : {})
    });
    const reply = await new ConversationChatAdapter(响应为({ type: 'text', text: '准备读取。', structured_output: output })).respond({ history: [], text: '帮我看看 note.txt', behaviorContext, signal: new AbortController().signal });
    expect(reply).toEqual({ text: '准备读取。' });
  });

  test('控制字段损坏时保留首次正文、只记录稳定子码并以无工具请求修复一次', async () => {
    const sensitiveValues = [
      'sk-private-chat-key',
      'C:\\Users\\Alice\\Documents\\secret.txt',
      '绝密文件正文',
      '{"raw":"provider response"}'
    ];
    const responses: ModelResponse[] = [{
      type: 'text',
      text: '首次正文保持可见。',
      structured_output: {
        text: '首次正文保持可见。',
        activity: '安静陪伴',
        rawProviderResponse: sensitiveValues.join('|')
      }
    }, {
      type: 'text',
      text: '修复回合不得替换首次正文。',
      structured_output: {
        text: '修复回合不得替换首次正文。',
        activity: '安静陪伴',
        status: 'idle',
        movementControl: { kind: 'keep' },
        behaviorPlan: { kind: 'none' },
        capabilityPlan: { kind: 'chat' }
      }
    }];
    const provider: ModelProvider = {
      respond: vi.fn(async () => responses.shift()!)
    };
    const diagnostics = vi.fn();

    await expect(new ConversationChatAdapter(provider, diagnostics).respond({
      history: [], text: '普通聊天', behaviorContext,
      signal: new AbortController().signal
    })).resolves.toEqual({
      text: '首次正文保持可见。',
      activity: '安静陪伴',
      status: 'idle',
      movementControl: { kind: 'keep' },
      behaviorPlan: { kind: 'none' },
      capabilityPlan: { kind: 'chat' }
    });

    expect(provider.respond).toHaveBeenCalledTimes(2);
    for (const [repairRequest] of vi.mocked(provider.respond).mock.calls) {
      expect(repairRequest).toMatchObject({ tools: [], toolChoice: 'none' });
    }
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(diagnostics.mock.calls[0]?.[0]).toMatchObject({
      code: 'CONTROL_SCHEMA_INVALID',
      stage: 'chat_control'
    });
    const serializedDiagnostics = JSON.stringify(diagnostics.mock.calls);
    for (const sensitiveValue of sensitiveValues) {
      expect(serializedDiagnostics).not.toContain(sensitiveValue);
    }
  });

  test('控制字段连续损坏时正文仍成功且丢弃所有控制副作用', async () => {
    const responses: ModelResponse[] = [{
      type: 'text',
      text: '正文仍然成功。',
      emotion: 'happy',
      structured_output: {
        activity: '不得执行',
        status: 'move',
        movementControl: { kind: 'move_once', target: 'random_work_area', distance: 'far' },
        behaviorPlan: { kind: 'play_state', state: '开心', action: '挥手' }
      }
    }, {
      type: 'text',
      text: '修复回合仍未返回控制计划。',
      emotion: 'happy'
    }];
    const provider: ModelProvider = {
      respond: vi.fn(async () => responses.shift()!)
    };
    const diagnostics = vi.fn();

    await expect(new ConversationChatAdapter(provider, diagnostics).respond({
      history: [], text: '普通聊天', behaviorContext,
      signal: new AbortController().signal
    })).resolves.toEqual({ text: '正文仍然成功。' });

    expect(provider.respond).toHaveBeenCalledTimes(2);
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(diagnostics.mock.calls[0]?.[0]).toMatchObject({ code: 'CONTROL_SCHEMA_INVALID' });
  });

  test('纯文本缺少控制计划时保留正文、记录一次并丢弃旧情绪副作用', async () => {
    const provider = 响应为({
      type: 'text',
      text: '纯文本仍然可见。',
      emotion: 'happy'
    });
    const diagnostics = vi.fn();

    await expect(new ConversationChatAdapter(provider, diagnostics).respond({
      history: [], text: '普通聊天', behaviorContext,
      signal: new AbortController().signal
    })).resolves.toEqual({ text: '纯文本仍然可见。' });

    expect(provider.respond).toHaveBeenCalledTimes(2);
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(diagnostics.mock.calls[0]?.[0]).toMatchObject({ code: 'CONTROL_SCHEMA_INVALID' });
  });

  test('CONTROL_SCHEMA_INVALID reporter 抛错时仍保留正文回退', async () => {
    const provider = 响应为({
      type: 'text',
      text: '正文仍然保留。',
      emotion: 'happy'
    });
    const diagnostics = vi.fn(() => {
      throw new Error('sink failed');
    });

    await expect(new ConversationChatAdapter(provider, diagnostics).respond({
      history: [], text: '普通聊天', behaviorContext,
      signal: new AbortController().signal
    })).resolves.toEqual({ text: '正文仍然保留。' });

    expect(provider.respond).toHaveBeenCalledTimes(2);
    expect(diagnostics).toHaveBeenCalledOnce();
  });

  test('用固定系统消息、历史和当前用户文本发起无工具聊天请求', async () => {
    const provider = 响应为({ type: 'text', text: '你好！' });
    const adapter = new ConversationChatAdapter(provider);
    const history = [{ role: 'assistant' as const, content: '上一轮回复' }];

    await expect(adapter.respond({
      history,
      text: '这一轮问题',
      behaviorContext,
      signal: new AbortController().signal
    })).resolves.toEqual({ text: '你好！' });

    expect(取得请求(provider)).toEqual({
      messages: [
        {
          role: 'system',
          content: expect.stringContaining('AI 桌宠')
        },
        ...history,
        { role: 'user', content: '这一轮问题' }
      ],
      tools: [],
      toolChoice: 'none',
      reasoningMode: 'provider_default',
      responseContract: {
        type: 'json_object',
        name: 'character_chat',
        jsonSchema: expect.objectContaining({
          required: expect.arrayContaining(['capabilityPlan']),
          properties: expect.objectContaining({ capabilityPlan: expect.any(Object) })
        }),
        textField: 'text',
        allowPlainTextFallback: true
      }
    });
    expect(取得请求(provider).messages[0]?.content).toContain('用户使用的语言');
    expect(取得请求(provider).messages[0]?.content).toContain('可见上下文');
    expect(取得请求(provider).messages[0]?.content).toContain('尚未执行的文件操作');
    expect(取得请求(provider).messages[0]?.content).toContain('capabilityPlan');
    expect(取得请求(provider).messages[0]?.content).toContain('movementControl');
    expect(取得请求(provider).messages[0]?.content).toContain('10–30 秒');
    expect(取得请求(provider).messages[0]?.content).toContain(
      'mode=2 时 behaviorPlan 不得描述正在移动'
    );
    expect(取得请求(provider).messages[0]?.content).toContain('"identity":{"name":"小橘"');
    expect(取得请求(provider).messages[0]?.content).toContain('"movementMode":2');
    expect(取得请求(provider).messages[0]?.content).toContain('"proactivityMode":"assistive"');
    expect(取得请求(provider).messages[0]?.content).toContain('"recentActions":["挥手"]');
    expect(取得请求(provider).messages[0]?.content).toContain('json');
    expect(取得请求(provider).messages[0]?.content).toContain(
      '{"text":"我会陪着你。","activity":"安静陪伴","status":"idle","movementControl":{"kind":"keep"},"behaviorPlan":{"kind":"none","emotion":"calm"},"capabilityPlan":{"kind":"chat"}}'
    );
    expect(取得请求(provider).messages[0]?.content).not.toContain('路由字段');
    expect(取得请求(provider).messages[0]?.content).not.toContain('禁止 Markdown');
  });

  test('Provider 与本地模型共用严格能力计划且聊天阶段始终不公告工具', async () => {
    const provider = 响应为({
      type: 'text',
      text: '需要进入本地任务。',
      structured_output: 完整控制字段({
        capabilityPlan: { kind: 'agent_task' }
      })
    });

    await expect(new ConversationChatAdapter(provider).respond({
      history: [],
      text: '请整理当前目录并生成摘要',
      behaviorContext,
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      capabilityPlan: { kind: 'agent_task' }
    });
    expect(取得请求(provider)).toMatchObject({ tools: [], toolChoice: 'none' });
  });

  test('非法能力计划只保留正文且绝不升级为本地任务', async () => {
    const provider = 响应为({
      type: 'text',
      text: '普通回复。',
      structured_output: {
        capabilityPlan: {
          kind: 'agent_task', command: 'Remove-Item -Recurse C:\\'
        }
      }
    });

    await expect(new ConversationChatAdapter(provider).respond({
      history: [], text: '讨论自动化方案', behaviorContext, signal: new AbortController().signal
    })).resolves.toEqual({ text: '普通回复。' });
  });

  test('原样返回中文、Markdown、代码块和已归一化情绪', async () => {
    const provider = 响应为({
      type: 'text',
      text: '  当然可以。\n\n```ts\nconst 宠物 = "你好";\n```\n',
      emotion: 'happy',
      structured_output: 完整控制字段()
    });
    const adapter = new ConversationChatAdapter(provider);

    await expect(adapter.respond({
      history: [],
      text: '给我一个例子',
      behaviorContext,
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      text: '  当然可以。\n\n```ts\nconst 宠物 = "你好";\n```\n',
      emotion: 'happy'
    });
  });

  test('拒绝 behaviorPlan 越权提交运动策略', async () => {
    const provider = 响应为({
      type: 'text',
      text: '我向左走一点。',
      structured_output: {
        text: '我向左走一点。',
        behaviorPlan: { kind: 'move', direction: 'left', distance: 'near' }
      }
    });
    const adapter = new ConversationChatAdapter(provider);

    await expect(adapter.respond({
      history: [],
      text: '向左走一点',
      behaviorContext,
      signal: new AbortController().signal
    })).resolves.toEqual({ text: '我向左走一点。' });
  });

  test.each([
    ['停止不动', { kind: 'set_mode', mode: 0 }],
    ['一直运动', { kind: 'set_mode', mode: 1 }],
    ['时不时动一下', { kind: 'set_mode', mode: 2 }],
    ['跑远一点', { kind: 'move_once', target: 'random_work_area', distance: 'far' }]
  ] as const)('只把“%s”的严格 movementControl 交给 Main', async (text, movementControl) => {
    const provider = 响应为({
      type: 'text',
      text: '好的。',
      structured_output: 完整控制字段({
        text: '好的。',
        movementControl,
        behaviorPlan: { kind: 'none' }
      })
    });

    await expect(new ConversationChatAdapter(provider).respond({
      history: [], text, behaviorContext, signal: new AbortController().signal
    })).resolves.toMatchObject({
      text: '好的。',
      movementControl,
      behaviorPlan: { kind: 'none' }
    });
  });

  test('忽略非法隐藏 movementControl 但保留可见正文', async () => {
    const provider = 响应为({
      type: 'text',
      text: '正文仍然可见。',
      structured_output: {
        text: '正文仍然可见。',
        movementControl: { kind: 'move_once', target: { x: 1, y: 2 }, distance: 'far' }
      }
    });

    await expect(new ConversationChatAdapter(provider).respond({
      history: [], text: '测试', behaviorContext, signal: new AbortController().signal
    })).resolves.toEqual({ text: '正文仍然可见。' });
  });

  test('隐藏 activity/status 仅随回复交给 Main，不出现在可见正文', async () => {
    const provider = 响应为({
      type: 'text',
      text: '我来活动一下。',
      structured_output: 完整控制字段({
        text: '我来活动一下。',
        activity: '轻快移动',
        status: 'move'
      })
    });

    await expect(new ConversationChatAdapter(provider).respond({
      history: [], text: '请你移动', behaviorContext, signal: new AbortController().signal
    })).resolves.toMatchObject({
      text: '我来活动一下。', activity: '轻快移动', status: 'move'
    });
  });

  test('隐藏 activity/status 任一无效时丢弃整组控制副作用', async () => {
    const provider = 响应为({
      type: 'text',
      text: '正文保持可用。',
      structured_output: {
        activity: '  轻快移动  ',
        status: '跑'.repeat(121)
      }
    });

    await expect(new ConversationChatAdapter(provider).respond({
      history: [], text: '请你移动', behaviorContext, signal: new AbortController().signal
    })).resolves.toEqual({ text: '正文保持可用。' });
  });

  test('JSON 契约要求隐藏 activity/status，且不把它们作为可见文本字段', () => {
    expect(characterChatResponseJsonSchema.required).toEqual(
      expect.arrayContaining(['text', 'activity', 'status'])
    );
    expect(characterChatResponseJsonSchema.properties).toHaveProperty('activity');
    expect(characterChatResponseJsonSchema.properties).toHaveProperty('status');
  });

  test('序列化上下文保留状态动作层级且不发送旧扁平聚合', async () => {
    const provider = 响应为({ type: 'text', text: '好的' });
    const adapter = new ConversationChatAdapter(provider);
    const states = [{
      name: '自定义待机', stateId: 'state-17705', tags: ['friendly'], actions: [{
        name: '自定义巡游', actionId: 'action-17779', description: '在桌面上巡游',
        tags: ['locomotion', 'friendly']
      }]
    }];

    await adapter.respond({
      history: [],
      text: '走一走',
      behaviorContext: {
        ...behaviorContext,
        character: {
          ...behaviorContext.character,
          states
        }
      },
      signal: new AbortController().signal
    });

    const system = 取得请求(provider).messages[0]?.content ?? '';
    const contextStart = system.lastIndexOf('{"character":');
    expect(contextStart).toBeGreaterThanOrEqual(0);
    const serializedContext = JSON.parse(system.slice(contextStart)) as {
      character: Record<string, unknown>;
    };
    expect(serializedContext.character.states).toEqual(states);
    expect(serializedContext.character).not.toHaveProperty('candidates');
    expect(serializedContext.character).not.toHaveProperty('stateNames');
    expect(serializedContext.character).not.toHaveProperty('actionNames');
    expect(serializedContext.character).not.toHaveProperty('tags');
  });

  test('首次与修复请求在最大公开上下文下均守住系统预算并保留完整历史和当前正文', async () => {
    const provider = 响应为({ type: 'text', text: '好的' });
    const text = '甲'.repeat(4_000);

    await new ConversationChatAdapter(provider).respond({
      history: [{ role: 'user', content: '先前问题' }, { role: 'assistant', content: '先前回答' }],
      text,
      behaviorContext: {
        ...behaviorContext,
        character: 过大公开目录(),
        recentActions: Array.from({ length: 4 }, () => '动'.repeat(120))
      },
      signal: new AbortController().signal
    });

    const request = 取得请求(provider);
    const system = request.messages[0]?.content ?? '';
    const contextStart = system.lastIndexOf('{"character":');
    const context = JSON.parse(system.slice(contextStart)) as typeof behaviorContext;
    expect(provider.respond).toHaveBeenCalledTimes(2);
    for (const [actual] of vi.mocked(provider.respond).mock.calls) {
      expect(new TextEncoder().encode(actual.messages[0]?.content ?? '').byteLength)
        .toBeLessThanOrEqual(PUBLIC_CHARACTER_CHAT_SYSTEM_UTF8_BYTE_BUDGET);
      expect(actual.messages.slice(1)).toEqual([
        { role: 'user', content: '先前问题' }, { role: 'assistant', content: '先前回答' },
        { role: 'user', content: text }
      ]);
      expect(actual).toMatchObject({ tools: [], toolChoice: 'none' });
    }
    expect(new TextEncoder().encode(JSON.stringify(context.character)).byteLength)
      .toBeLessThanOrEqual(PUBLIC_BEHAVIOR_CATALOG_UTF8_BYTE_BUDGET);
    expect(request.messages.at(-1)).toEqual({ role: 'user', content: text });
  });

  test('把 JSON Output 行为计划中的合法情绪投影为聊天情绪', async () => {
    const provider = 响应为({
      type: 'text',
      text: '今天真开心。',
      structured_output: 完整控制字段({
        text: '今天真开心。',
        behaviorPlan: { kind: 'none', emotion: 'happy' }
      })
    });
    const adapter = new ConversationChatAdapter(provider);

    await expect(adapter.respond({
      history: [],
      text: '我今天很开心',
      behaviorContext,
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      text: '今天真开心。',
      emotion: 'happy',
      behaviorPlan: { kind: 'none', emotion: 'happy' }
    });
  });

  test('保留合法 play_state 层级计划且不恢复旧扁平 play 计划', async () => {
    const provider = 响应为({
      type: 'text',
      text: '我来挥挥手。',
      structured_output: 完整控制字段({
        text: '我来挥挥手。',
        behaviorPlan: {
          kind: 'play_state', state: '开心', action: '挥手', duration: 'brief', emotion: 'happy'
        }
      })
    });

    await expect(new ConversationChatAdapter(provider).respond({
      history: [], text: '开心地挥挥手', behaviorContext,
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      text: '我来挥挥手。',
      emotion: 'happy',
      behaviorPlan: {
        kind: 'play_state', state: '开心', action: '挥手', duration: 'brief', emotion: 'happy'
      }
    });

    const legacyProvider = 响应为({
      type: 'text', text: '正文保留。',
      structured_output: {
        behaviorPlan: { kind: 'play', target: { kind: 'action_name', name: '挥手' } }
      }
    });
    await expect(new ConversationChatAdapter(legacyProvider).respond({
      history: [], text: '测试旧计划', behaviorContext,
      signal: new AbortController().signal
    })).resolves.toEqual({ text: '正文保留。' });
  });

  test('丢弃非法行为计划及同组情绪并保留正文', async () => {
    const provider = 响应为({
      type: 'text',
      text: '正文仍然可见。',
      emotion: 'calm',
      structured_output: {
        text: '正文仍然可见。',
        behaviorPlan: { kind: 'move', direction: 'outside', distance: 'near' }
      }
    });
    const adapter = new ConversationChatAdapter(provider);

    await expect(adapter.respond({
      history: [],
      text: '测试非法计划',
      behaviorContext,
      signal: new AbortController().signal
    })).resolves.toEqual({ text: '正文仍然可见。' });
  });

  test('普通聊天忽略旧 behaviorIntent 元数据', async () => {
    const provider = 响应为({
      type: 'text',
      text: '只保留正文。',
      behaviorIntent: {
        stateIntent: { semantic: 'move' },
        actionSemantic: 'move',
        urgency: 100,
        explanation: '普通聊天不得消费旧意图。'
      }
    });
    const adapter = new ConversationChatAdapter(provider);

    await expect(adapter.respond({
      history: [],
      text: '普通聊天',
      behaviorContext,
      signal: new AbortController().signal
    })).resolves.toEqual({ text: '只保留正文。' });
  });

  test.each([
    ['空白正文', ' \n\t '],
    ['超过 Unicode 字符上限的正文', `${'😀'.repeat(8_000)}好`]
  ])('拒绝%s且错误不暴露原始正文', async (_名称, text) => {
    const provider = 响应为({ type: 'text', text });
    const adapter = new ConversationChatAdapter(provider);

    const error = await adapter.respond({
      history: [],
      text: '测试输入',
      behaviorContext,
      signal: new AbortController().signal
    }).catch(reason => reason);

    expect(error).toMatchObject({
      code: 'RESPONSE_FORMAT_UNSUPPORTED',
      retryable: false
    });
    expect(String(error)).not.toContain(text);
  });

  test('拒绝工具调用且错误不暴露工具内容', async () => {
    const provider = 响应为({
      type: 'tool_request',
      request: {
        requestId: 'private-request',
        toolName: 'read_file',
        arguments: { path: 'private-content' }
      }
    });
    const diagnostics = vi.fn();
    const adapter = new ConversationChatAdapter(provider, diagnostics);

    const error = await adapter.respond({
      history: [],
      text: '测试输入',
      behaviorContext,
      signal: new AbortController().signal
    }).catch(reason => reason);

    expect(error).toMatchObject({
      code: 'RESPONSE_FORMAT_UNSUPPORTED',
      retryable: false
    });
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      code: 'RESPONSE_FORMAT_UNSUPPORTED',
      stage: 'chat_control'
    }), undefined);
    expect(String(error)).not.toContain('private-content');
  });

  test('保留取消和超时错误的既有分类', async () => {
    const abortError = new DOMException('取消', 'AbortError');
    const timeoutError = new ProviderError('PROVIDER_TIMEOUT', true);
    const abortProvider: ModelProvider = {
      respond: vi.fn(async () => { throw abortError; })
    };
    const timeoutProvider: ModelProvider = {
      respond: vi.fn(async () => { throw timeoutError; })
    };

    await expect(new ConversationChatAdapter(abortProvider).respond({
      history: [],
      text: '取消',
      behaviorContext,
      signal: new AbortController().signal
    })).rejects.toBe(abortError);
    await expect(new ConversationChatAdapter(timeoutProvider).respond({
      history: [],
      text: '超时',
      behaviorContext,
      signal: new AbortController().signal
    })).rejects.toBe(timeoutError);
  });

  test('控制修复被取消时传播取消而不返回首次任务建议', async () => {
    const abortError = new DOMException('取消', 'AbortError');
    const provider: ModelProvider = { respond: vi.fn()
      .mockResolvedValueOnce({ type: 'text', text: '准备读取。', structured_output: 完整控制字段({
        behaviorPlan: { kind: 'none', emotion: 'neutral' }, capabilityPlan: { kind: 'agent_task' }
      }) })
      .mockRejectedValueOnce(abortError) };
    await expect(new ConversationChatAdapter(provider).respond({
      history: [], text: '帮我看看 note.txt', behaviorContext, signal: new AbortController().signal
    })).rejects.toBe(abortError);
    expect(provider.respond).toHaveBeenCalledTimes(2);
  });
});
