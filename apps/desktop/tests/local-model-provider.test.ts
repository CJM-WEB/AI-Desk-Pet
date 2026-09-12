import type { ModelRequest, ToolDefinition } from '@myself/agent-core';
import { describe, expect, test, vi } from 'vitest';
import {
  LocalModelProvider,
  type LocalModelConnection,
  type LocalModelConnectionPort
} from '../src/main/providers/local-model-provider';
import { ProviderError } from '../src/main/providers/openai-provider';
import { characterExpressionResponseContract } from '../src/main/conversation/character-expression-adapter';
import { ConversationChatAdapter } from '../src/main/conversation/conversation-chat-adapter';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const connection: LocalModelConnection = {
  generation: 'generation-1',
  baseUrl: 'http://127.0.0.1:43123/v1',
  token: 'local-session-token',
  modelId: 'ai-pet-local'
};

const tools: ToolDefinition[] = [{
  type: 'function',
  function: {
    name: 'builtin.files.read_text',
    description: '读取文本文件',
    parameters: {
      type: 'object',
      properties: { relativePath: { type: 'string' } },
      required: ['relativePath'],
      additionalProperties: false
    }
  }
}];

const request: ModelRequest = {
  messages: [{ role: 'user', content: '读取 notes.txt' }],
  tools,
  toolChoice: 'auto',
  reasoningMode: 'provider_default'
};

const localBehaviorContext = {
  character: { idleStateId: 'protocol-state',
    identity: { formsOfAddress: [], dislikes: [], boundaries: [], exampleLines: [],
      name: '本地测试角色', description: '本地测试角色', background: '测试环境',
      traits: [], languageStyle: '简洁', likes: [], behavioralTendencies: []
    },
    states: [{ agentInferable: true,
      name: '开心', stateId: 'protocol-state', tags: [],
      actions: [{ name: '挥手', actionId: 'protocol-action', tags: [] }]
    }]
  },
  runtime: { chatting: false, taskRunning: false, awaitingConfirmation: false, moving: false, dragging: false, carrying: false, movementMode: 2 as const },
  proactivityMode: 'assistive' as const,
  recentActions: []
};

const structuredRequest: ModelRequest = {
  messages: [{ role: 'user', content: '保持安静陪伴' }],
  tools: [],
  toolChoice: 'none',
  reasoningMode: 'provider_default',
  responseContract: characterExpressionResponseContract
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function readyPort(getReadyConnection = () => connection): LocalModelConnectionPort {
  return { getReadyConnection };
}

const decisionJsonSchema = { anyOf: [
  { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['task'] }, text: { type: 'string', enum: [''] }
  }, required: ['kind', 'text'] },
  { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['chat'] }, text: { type: 'string', minLength: 1, maxLength: 4000 }
  }, required: ['kind', 'text'] }
] };
const emptyExpression = { kind: 'none', choice: null, mode: 'keep', target: null, distance: null };

/** HTTP 夹具按正式 Schema 区分主判别与零工具表现，不依赖两条请求的先后顺序。 */
function conversationFetch(content: string) {
  return vi.fn<FetchLike>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return jsonResponse({ choices: [{ message: { content: body.response_format?.schema.anyOf
      ? content : JSON.stringify(emptyExpression) } }] });
  });
}

function assertSingleMainAndExpression(fetchClient: ReturnType<typeof conversationFetch>): void {
  const bodies = fetchClient.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies.filter(body => body.response_format?.schema.anyOf)).toHaveLength(1);
  const expression = bodies.filter(body => body.response_format?.schema.properties?.choice);
  expect(expression).toHaveLength(1);
  expect(expression[0]).toMatchObject({ tools: [], tool_choice: 'none' });
  expect(bodies).toHaveLength(2);
}

/** 从正式适配器取得宿主入口，避免测试另造一套授权工具或提示。 */
async function officialConversationRequest(): Promise<ModelRequest> {
  let captured!: ModelRequest;
  const adapter = new ConversationChatAdapter({ respond: async input => {
    if (input.responseContract?.name === 'character_expression') {
      return { type: 'structured', structured_output: emptyExpression };
    }
    captured = input;
    return { type: 'tool_request', request: { requestId: 'captured', toolName: 'request_task_authorization', arguments: {} } };
  } });
  await adapter.respond({ history: [], text: '请查看子目录', behaviorContext: localBehaviorContext, signal: new AbortController().signal });
  return captured;
}

describe('LocalModelProvider', () => {
  test('正式主聊天使用单次严格判别并保留人设历史正文，独立表现使用正式扁平协议', async () => {
    const requests: ModelRequest[] = [];
    const fetchClient = vi.fn<FetchLike>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return jsonResponse({ choices: [{ message: { content: body.response_format?.schema.anyOf
        ? JSON.stringify({ kind: 'chat', text: '  **保留正文😀**\n' })
        : body.response_format ? JSON.stringify(emptyExpression) : '原工具正文' } }] });
    });
    const local = new LocalModelProvider(readyPort(), fetchClient);
    const adapter = new ConversationChatAdapter({ respond: (input, signal) => { requests.push(input); return local.respond(input, signal); } }, () => undefined, { inputByteBudget: 19_200 });
    const history: ModelRequest['messages'] = [{ role: 'user', content: '历史用户🐾\n\n保留段落' }, { role: 'assistant', content: '  历史答复  \r\n缩进' }];
    const reply = await adapter.respond({ history, text: '  今天获奖了😀\n聊聊吧。  ', behaviorContext: localBehaviorContext, signal: new AbortController().signal });
    expect(reply.text).toBe('  **保留正文😀**\n');
    expect(fetchClient).toHaveBeenCalledTimes(2);
    for (const [index, original] of requests.entries()) {
      const body = JSON.parse(String(fetchClient.mock.calls[index]?.[1]?.body));
      const systems = original.messages.filter(message => message.role === 'system');
      expect(body.messages.slice(1)).toEqual(original.messages.filter(message => message.role !== 'system'));
      expect(body).toMatchObject({ stream: false, reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false }, parallel_tool_calls: false });
      if (index === 0) {
        expect(body.tools).toEqual([]);
        expect(body).toMatchObject({ tool_choice: 'none', temperature: 0, response_format: { type: 'json_object', schema: decisionJsonSchema } });
        expect(body.messages[0].content).not.toContain(systems[0]!.content);
        expect(body.messages[0].content.endsWith('\n\n' + systems[1]!.content)).toBe(true);
        expect(body.messages[0].content).toContain('角色人设仅影响普通回复的语气');
        expect(body.messages[0].content).toContain('历史帮助理解目标，不继承许可，也不证明文件当前内容');
      } else {
        expect(body.messages[0]).toEqual({ role: 'system', content: systems.map(message => message.content).join('\n\n') });
        expect(body.tools).toEqual([]); expect(body.tool_choice).toBe('none');
        expect(body).toHaveProperty('temperature', 0);
        expect(body.response_format.schema).toEqual(original.responseContract?.jsonSchema);
        expect(body.response_format.schema.properties).not.toHaveProperty('text');
        expect(body.response_format.schema.properties).not.toHaveProperty('capabilityPlan');
      }
      expect(Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools, responseSchema: body.response_format?.schema ?? null }))).toBeLessThanOrEqual(19_200);
    }
    await local.respond({ ...request, messages: requests[0]!.messages }, new AbortController().signal);
    expect(JSON.parse(String(fetchClient.mock.calls[2]?.[1]?.body)).messages).toEqual(requests[0]!.messages);
  });
  test('本地模型工具参数损坏时返回稳定子码且绝不重放已开始的工具协议回合', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'local-invalid-call',
            type: 'function',
            function: {
              name: 'builtin_files_read_text',
              arguments: '{"relativePath":"C:\\\\private.txt","content":"私密正文"'
            }
          }]
        }
      }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await expect(provider.respond(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'TOOL_ARGUMENTS_INVALID',
      stage: 'tool_call'
    });
    expect(fetchClient).toHaveBeenCalledOnce();
  });

  test('合法本地task映射为空参数申请，独立表现保持零工具且主判别不重试', async () => {
    const fetchClient = conversationFetch('{"kind":"task","text":""}');
    const adapter = new ConversationChatAdapter(new LocalModelProvider(readyPort(), fetchClient));
    expect(await adapter.respond({ history: [], text: '请查看目录', behaviorContext: localBehaviorContext, signal: new AbortController().signal })).toEqual({
      text: '', capabilityPlan: { kind: 'agent_task' }, expressionPlan: { states: [] },
      requestKind: 'ambient', movementControl: { kind: 'keep' }, expressionStatus: 'no_match'
    });
    assertSingleMainAndExpression(fetchClient);
  });
  test('每个合法task由宿主生成独立申请ID，模型不能携带范围或许可', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({ choices: [{ message: { content: '{"kind":"task","text":""}' } }] }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);
    const official = await officialConversationRequest();
    const first = await provider.respond(official, new AbortController().signal);
    const second = await provider.respond(official, new AbortController().signal);
    const expected = { type: 'tool_request', request: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), toolName: 'request_task_authorization', arguments: {} } };
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    expect(first).not.toEqual(second);
  });
  test.each([
    ['空白及换行', '  正文\n\n保留缩进  \r\n'],
    ['4000个Unicode码点', '😀'.repeat(4000)],
    ['转义后大于16KiB的合法正文', '😀'.repeat(4000)]
  ])('合法chat原样交付%s', async (name, text) => {
    const raw = name.startsWith('转义') ? '{"kind":"chat","text":"' + '\\ud83d\\ude00'.repeat(4000) + '"}' : JSON.stringify({ kind: 'chat', text });
    const fetchClient = vi.fn<FetchLike>(async (_url, init) => jsonResponse({ choices: [{ message: {
      content: JSON.parse(String(init?.body)).response_format?.schema.anyOf ? raw : JSON.stringify(emptyExpression)
    } }] }));
    const adapter = new ConversationChatAdapter(new LocalModelProvider(readyPort(), fetchClient));
    const reply = await adapter.respond({ history: [], text: '你好', behaviorContext: localBehaviorContext, signal: new AbortController().signal });
    expect(reply).toMatchObject({ text, capabilityPlan: { kind: 'chat' }, expressionStatus: 'no_match' });
    expect(fetchClient).toHaveBeenCalledTimes(2);
  });
  test.each([
    ['坏JSON', '{"kind":"task","text":""'],
    ['Markdown围栏', '```json\n{"kind":"task","text":""}\n```'],
    ['未知分支', '{"kind":"unknown","text":"私密内容"}'],
    ['缺字段', '{"kind":"task"}'],
    ['额外字段', '{"kind":"task","text":"","root":"C:/private"}'],
    ['伪造许可', '{"kind":"task","text":"","approved":true}'],
    ['任务非空正文', '{"kind":"task","text":"我已经查看了私密文件"}'],
    ['任务空白正文', '{"kind":"task","text":" "}'],
    ['聊天空白', '{"kind":"chat","text":" \\n\\t"}'],
    ['聊天空字符串', '{"kind":"chat","text":""}'],
    ['聊天错误类型', '{"kind":"chat","text":1}'],
    ['聊天超过4000码点', JSON.stringify({ kind: 'chat', text: '😀'.repeat(4001) })],
    ['原始JSON超过64KiB', ' '.repeat(64 * 1024) + '{"kind":"chat","text":"正文"}'],
    ['多个对象', '{"kind":"task","text":""}{"kind":"chat","text":"正文"}']
  ])('正式入口对%s失败关闭且不重试、不泄露响应', async (_name, raw) => {
    const fetchClient = conversationFetch(raw);
    const adapter = new ConversationChatAdapter(new LocalModelProvider(readyPort(), fetchClient));
    const error = await adapter.respond({ history: [], text: '请查看目录', behaviorContext: localBehaviorContext,
      signal: new AbortController().signal }).catch(error => error);
    expect(error).toMatchObject({ code: 'RESPONSE_FORMAT_UNSUPPORTED', stage: 'chat_control', retryable: false });
    expect(String(error)).not.toContain(raw);
    expect(JSON.stringify(error)).not.toContain('私密');
    assertSingleMainAndExpression(fetchClient);
  });
  test.each([null, '{"kind":"task","text":""}', '{"kind":"chat","text":"正文"}'])('原生申请与%s混合时稳定拒绝且不回退', async content => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({ choices: [{ message: { content,
      tool_calls: [{ id: 'model-generated-id', type: 'function', function: { name: 'request_task_authorization', arguments: '{}' } }]
    } }] }));
    const official = await officialConversationRequest();
    // 历史保留同名工具，使失败不能仅依赖工具名codec恰好不认识该调用。
    official.messages.splice(-1, 0, { role: 'assistant', content: '', toolRequest: {
      requestId: 'old-request', toolName: 'request_task_authorization', arguments: {}
    } }, { role: 'tool', toolCallId: 'old-request', content: '{"approved":false}' });
    await expect(new LocalModelProvider(readyPort(), fetchClient).respond(official, new AbortController().signal))
      .rejects.toMatchObject({ code: 'RESPONSE_FORMAT_UNSUPPORTED', retryable: false });
    expect(fetchClient).toHaveBeenCalledOnce();
  });
  test('仅替换准确宿主system，人设和其他system相对顺序与原文保持', async () => {
    const official = await officialConversationRequest();
    const host = official.messages[0]!;
    const before = { role: 'system' as const, content: '  前置系统\r\n内容' };
    const after = { role: 'system' as const, content: '后置系统\n\n原样' };
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({ choices: [{ message: { content: '{"kind":"task","text":""}' } }] }));
    await new LocalModelProvider(readyPort(), fetchClient).respond({ ...official, messages: [before, host, ...official.messages.slice(1), after] }, new AbortController().signal);
    const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    expect(body.messages[0].content.startsWith(before.content + '\n\n')).toBe(true);
    expect(body.messages[0].content.endsWith('\n\n' + official.messages[1]!.content + '\n\n' + after.content)).toBe(true);
    expect(body.messages[0].content).not.toContain(host.content);
    expect(body.messages.slice(1)).toEqual(official.messages.filter(message => message.role !== 'system'));
  });
  test.each(['无工具', '其他工具', '两个工具', '非主请求', '不同宿主', '非system宿主', '重复宿主', '非空参数', '增量回调', 'required'])(
    '%s保持既有协议，不通过局部文本或不匹配工具触发判别', async variant => {
      const official = await officialConversationRequest();
      let input: ModelRequest = official;
      if (variant === '无工具') input = { ...official, tools: [], toolChoice: 'none' };
      if (variant === '其他工具') input = { ...official, tools };
      if (variant === '两个工具') input = { ...official, tools: [...official.tools, ...tools] };
      if (variant === '非主请求') { input = { ...official }; delete input.purpose; }
      if (variant === '不同宿主') input = { ...official, messages: official.messages.map((message, index) => index === 0 ? { ...message, content: message.content + '额外指示' } : message) };
      if (variant === '非system宿主') input = { ...official, messages: official.messages.map((message, index) => index === 0 ? { role: 'user', content: message.content } : message) };
      if (variant === '重复宿主') input = { ...official, messages: [official.messages[0]!, ...official.messages] };
      if (variant === '非空参数') input = { ...official, tools: [{ ...official.tools[0]!, function: { ...official.tools[0]!.function,
        parameters: { type: 'object', additionalProperties: false, properties: { root: { type: 'string' } }, required: [] } } }] };
      if (variant === '增量回调') input = { ...official, onTextDelta: vi.fn() };
      if (variant === 'required') input = { ...official, toolChoice: 'required' };
      const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({ choices: [{ message: { content: '保持正文' } }] }));
      await expect(new LocalModelProvider(readyPort(), fetchClient).respond(input, new AbortController().signal)).resolves.toEqual({ type: 'text', text: '保持正文' });
      const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
      expect(body).not.toHaveProperty('response_format');
      expect(body.tool_choice).toBe(input.toolChoice);
      expect(body.tools).toHaveLength(input.tools.length);
      expect(body.messages.some((message: { content: string }) => message.content.includes(input.messages[0]!.content))).toBe(true);
    }
  );
  test('已有响应契约与任务工具冲突仍拒绝，不以本地判别覆盖原校验', async () => {
    const official = await officialConversationRequest();
    const fetchClient = vi.fn<FetchLike>();
    await expect(new LocalModelProvider(readyPort(), fetchClient).respond({ ...official, responseContract: structuredRequest.responseContract! }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_CONTRACT_CONFLICT' });
    expect(fetchClient).not.toHaveBeenCalled();
  });
  test.each(['取消', 'generation'])('正式入口在HTTP返回后%s时拒绝迟到申请', async variant => {
    const controller = new AbortController();
    let current = connection;
    const fetchClient = vi.fn<FetchLike>(async () => {
      if (variant === '取消') controller.abort();
      else current = { ...connection, generation: 'generation-late' };
      return jsonResponse({ choices: [{ message: { content: '{"kind":"task","text":""}' } }] });
    });
    const provider = new LocalModelProvider(readyPort(() => current), fetchClient);
    await expect(provider.respond(await officialConversationRequest(), controller.signal)).rejects.toMatchObject(
      variant === '取消' ? { name: 'AbortError' } : { code: 'LOCAL_MODEL_CONNECTION_STALE', retryable: false });
    expect(fetchClient).toHaveBeenCalledOnce();
  });
  test('合法响应完成解析后generation变化仍不能生成申请', async () => {
    let checks = 0;
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({ choices: [{ message: { content: '{"kind":"task","text":""}' } }] }));
    const provider = new LocalModelProvider(readyPort(() => ++checks <= 3 ? connection : { ...connection, generation: 'generation-after-parse' }), fetchClient);
    await expect(provider.respond(await officialConversationRequest(), new AbortController().signal)).rejects.toMatchObject({ code: 'LOCAL_MODEL_CONNECTION_STALE' });
  });
  test('正式判别JSON的Unicode转义不能隐藏思考标签', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({ choices: [{ message: {
      content: '{"kind":"chat","text":"\\u003cthink\\u003e私密思考\\u003c/think\\u003e正文"}'
    } }] }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);
    const error = await provider.respond(await officialConversationRequest(), new AbortController().signal).catch(error => error);
    expect(error).toMatchObject({ code: 'LOCAL_MODEL_REASONING_LEAK', retryable: false });
    expect(JSON.stringify(error)).not.toContain('私密思考');
    expect(fetchClient).toHaveBeenCalledOnce();
  });
  test('完整本地Schema计入预算，临界历史只按完整回合裁剪', async () => {
    const official = await officialConversationRequest();
    const bodies: Array<Record<string, any>> = [];
    const fetchClient = vi.fn<FetchLike>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ choices: [{ message: { content: '{"kind":"task","text":""}' } }] });
    });
    const provider = new LocalModelProvider(readyPort(), fetchClient);
    await provider.respond(official, new AbortController().signal);
    const base = bodies[0]!;
    expect(base.response_format?.schema).toEqual(decisionJsonSchema);
    const recent = [{ role: 'user' as const, content: '最近用户' }, { role: 'assistant' as const, content: '最近回复' }];
    const oldest = [{ role: 'user' as const, content: '最旧用户' }, { role: 'assistant' as const, content: '' }];
    const messages = [base.messages[0], ...oldest, ...recent, base.messages.at(-1)];
    const beforePadding = Buffer.byteLength(JSON.stringify({ messages, tools: [], responseSchema: null }));
    oldest[1]!.content = 'x'.repeat(19_200 - beforePadding - 20);
    expect(Buffer.byteLength(JSON.stringify({ messages, tools: [], responseSchema: null }))).toBeLessThan(19_200);
    expect(Buffer.byteLength(JSON.stringify({ messages, tools: [], responseSchema: decisionJsonSchema }))).toBeGreaterThan(19_200);
    await provider.respond({ ...official, messages: [...official.messages.slice(0, -1), ...oldest, ...recent, official.messages.at(-1)!] }, new AbortController().signal);
    const bounded = bodies[1]!;
    expect(bounded.messages.slice(1)).toEqual([...recent, official.messages.at(-1)]);
    expect(Buffer.byteLength(JSON.stringify({ messages: bounded.messages, tools: bounded.tools, responseSchema: bounded.response_format?.schema }))).toBeLessThanOrEqual(19_200);
  });
  test('过大公开角色目录不会挤占本地当前用户正文的固定输入预算', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: JSON.stringify({ kind: 'chat', text: '收到。' }) } }]
    }));
    const adapter = new ConversationChatAdapter(new LocalModelProvider(readyPort(), fetchClient), () => undefined, { inputByteBudget: 19_200 });
    const text = '甲'.repeat(4_000);
    const actions = Array.from({ length: 100 }, (_, index) => ({
      name: `共享动作${index}`, actionId: 'action-7391', description: '动'.repeat(2_000), tags: []
    }));

    await adapter.respond({
      history: [],
      text,
      behaviorContext: {
        ...localBehaviorContext,
        character: {
          ...localBehaviorContext.character,
          identity: {
            ...localBehaviorContext.character.identity,
            description: '角'.repeat(2_000),
            background: '景'.repeat(4_000)
          },
          states: Array.from({ length: 100 }, (_, index) => ({
            agentInferable: true,
            name: `共享状态${index}`, stateId: 'action-7933', description: '态'.repeat(2_000),
            tags: [], actions
          }))
        }
      },
      signal: new AbortController().signal
    });

    const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: text });
    expect(Math.ceil(Buffer.byteLength(JSON.stringify({
      messages: body.messages,
      tools: [],
      responseSchema: body.response_format?.schema ?? null
    }), 'utf8') / 3)).toBeLessThanOrEqual(6_400);
  });

  test('固定关闭思考、流式和并行工具调用并使用当前私有连接', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await expect(provider.respond(request, new AbortController().signal)).resolves.toEqual({
      type: 'text',
      text: '完成'
    });

    const [url, init] = fetchClient.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://127.0.0.1:43123/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer local-session-token');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'ai-pet-local',
      stream: false,
      reasoning_effort: 'none',
      chat_template_kwargs: { enable_thinking: false },
      parallel_tool_calls: false,
      parse_tool_calls: true
    });
  });

  test('通过既有 OpenAI 工具名 codec 解码内部工具名', async () => {
    const fetchClient = vi.fn<FetchLike>(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      return jsonResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call-local-1',
              type: 'function',
              function: {
                name: body.tools[0].function.name,
                arguments: '{"relativePath":"notes.txt"}'
              }
            }]
          }
        }]
      });
    });
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await expect(provider.respond(request, new AbortController().signal)).resolves.toEqual({
      type: 'tool_request',
      request: {
        requestId: 'call-local-1',
        toolName: 'builtin.files.read_text',
        arguments: { relativePath: 'notes.txt' }
      }
    });
  });

  test('非表现请求中 required 工具规划固定 temperature 0，auto 与 none 保持现有采样策略', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchClient = vi.fn<FetchLike>(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ choices: [{ message: { content: '完成' } }] });
    });
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await provider.respond({ ...request, toolChoice: 'required' }, new AbortController().signal);
    await provider.respond(request, new AbortController().signal);
    await provider.respond({
      ...request,
      tools: [],
      toolChoice: 'none'
    }, new AbortController().signal);

    expect(requestBodies[0]).toMatchObject({ tool_choice: 'required', temperature: 0 });
    expect(requestBodies[1]).toMatchObject({ tool_choice: 'auto' });
    expect(requestBodies[1]).not.toHaveProperty('temperature');
    expect(requestBodies[2]).toMatchObject({ tool_choice: 'none' });
    expect(requestBodies[2]).not.toHaveProperty('temperature');
  });

  test.each(['character_expression', 'character_autonomy'] as const)('Qwen 的 %s 决策固定采样以减少同义请求随机分叉', async name => {
    const fetchClient = vi.fn<FetchLike>(async () => {
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(emptyExpression) } }] });
    });
    await new LocalModelProvider(readyPort(), fetchClient).respond({
      ...structuredRequest, responseContract: { ...structuredRequest.responseContract!, name }
    }, new AbortController().signal);
    expect(JSON.parse(String(fetchClient.mock.calls[0]![1]?.body))).toMatchObject({ temperature: 0, tool_choice: 'none' });
  });

  test('独立表现把响应契约作为 llama.cpp JSON Schema 约束发送', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify(emptyExpression)
        }
      }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await expect(provider.respond(
      structuredRequest,
      new AbortController().signal
    )).resolves.toMatchObject({
      type: 'structured', structured_output: emptyExpression
    });

    const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    expect(body.response_format).toEqual({
      type: 'json_object',
      schema: characterExpressionResponseContract.jsonSchema
    });
  });

  test('带工具请求即使提供增量接收器也保持非流式', async () => {
    const onTextDelta = vi.fn();
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await provider.respond({ ...request, onTextDelta }, new AbortController().signal);

    expect(JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body))).toMatchObject({
      stream: false
    });
    expect(onTextDelta).not.toHaveBeenCalled();
  });

  test('本地输入超预算时只删除最旧完整回合并保留最近回合与当前用户', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);
    const messages: ModelRequest['messages'] = [
      { role: 'system', content: '固定系统消息' },
      { role: 'user', content: `最旧用户-${'旧'.repeat(7_000)}` },
      { role: 'assistant', content: `最旧回复-${'答'.repeat(7_000)}` },
      { role: 'user', content: '最近用户' },
      { role: 'assistant', content: '最近回复' },
      { role: 'user', content: '当前用户输入' }
    ];

    await provider.respond({ ...request, messages }, new AbortController().signal);

    const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    expect(body.messages).toEqual([
      { role: 'system', content: '固定系统消息' },
      { role: 'user', content: '最近用户' },
      { role: 'assistant', content: '最近回复' },
      { role: 'user', content: '当前用户输入' }
    ]);
  });

  test('本地预算不截断超长当前用户，也不拆散最近 assistant-tool 与 tool 结果', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);
    const currentUser = `当前-${'保'.repeat(20_000)}`;
    const toolRequest = {
      requestId: 'call-budget',
      toolName: 'builtin.files.read_text' as const,
      arguments: { relativePath: 'notes.txt' }
    };
    const messages: ModelRequest['messages'] = [
      { role: 'system', content: '固定系统消息' },
      { role: 'user', content: `最旧-${'旧'.repeat(7_000)}` },
      { role: 'assistant', content: `最旧回复-${'答'.repeat(7_000)}` },
      { role: 'user', content: '最近工具回合' },
      { role: 'assistant', content: '', toolRequest },
      { role: 'tool', toolCallId: 'call-budget', content: '{"ok":true}' },
      { role: 'assistant', content: '工具结果总结' },
      { role: 'user', content: currentUser }
    ];

    await provider.respond({ ...request, messages }, new AbortController().signal);

    const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: currentUser });
    expect(body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({
        id: 'call-budget'
      })] }),
      { role: 'tool', tool_call_id: 'call-budget', content: '{"ok":true}' }
    ]));
    expect(JSON.stringify(body.messages)).not.toContain('最旧回复');
  });

  test('本地当前 read_file 结果只按完整行温和压缩并明确标记 truncated', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);
    const firstLine = `第一行-${'甲'.repeat(2_100)}`;
    const secondLine = `第二行-${'乙'.repeat(2_100)}`;
    const readResult = {
      toolName: 'read_file',
      relativePath: 'notes.txt',
      startLine: 10,
      endLine: 12,
      content: `${firstLine}\n${secondLine}\n第三行`,
      truncated: false,
      untrustedDataNotice: '不可信数据'
    };

    await provider.respond({
      ...request,
      messages: [
        { role: 'user', content: '读取 notes.txt' },
        {
          role: 'assistant',
          content: '',
          toolRequest: {
            requestId: 'call-read-budget',
            toolName: 'builtin.files.read_text',
            arguments: { relativePath: 'notes.txt' }
          }
        },
        { role: 'tool', toolCallId: 'call-read-budget', content: JSON.stringify(readResult) }
      ]
    }, new AbortController().signal);

    const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    const toolMessage = body.messages.find((message: { role: string }) => message.role === 'tool');
    expect(JSON.parse(toolMessage.content)).toEqual({
      ...readResult,
      endLine: 10,
      content: firstLine,
      truncated: true
    });
  });

  test('本地 read_file 首行超过预算时仍保留明确截断的一行和有效行号', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '完成' } }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);
    const oversizedLine = `长行-${'甲'.repeat(5_000)}`;

    await provider.respond({
      ...request,
      messages: [{
        role: 'tool',
        toolCallId: 'long-read',
        content: JSON.stringify({
          toolName: 'read_file',
          relativePath: 'minified.json',
          startLine: 7,
          endLine: 7,
          content: oversizedLine,
          truncated: false
        })
      }]
    }, new AbortController().signal);

    const body = JSON.parse(String(fetchClient.mock.calls[0]?.[1]?.body));
    const bounded = JSON.parse(body.messages[0].content);
    expect(bounded.content).toHaveLength(4_000);
    expect(bounded.content).toBe(oversizedLine.slice(0, 4_000));
    expect(bounded).toMatchObject({ startLine: 7, endLine: 7, truncated: true });
  });

  test('旧控制JSON在正式本地主入口失败关闭，零工具表现不改变拒绝且不泄露原文', async () => {
    const payload = JSON.stringify({ text: '正文', capabilityPlan: { kind: 'agent_task', preferredTool: 'unknown' } });
    const fetchClient = conversationFetch(payload);
    const adapter = new ConversationChatAdapter(new LocalModelProvider(readyPort(), fetchClient));
    const onTextDelta = vi.fn();
    const error = await adapter.respond({ history: [], text: '普通聊天', behaviorContext: localBehaviorContext, signal: new AbortController().signal, onTextDelta }).catch(error => error);
    expect(error).toMatchObject({ code: 'RESPONSE_FORMAT_UNSUPPORTED', stage: 'chat_control', retryable: false });
    expect(String(error)).not.toContain(payload);
    assertSingleMainAndExpression(fetchClient);
    expect(onTextDelta).not.toHaveBeenCalled();
  });
  test.each([
    ['字符串', 'reasoning-canary-string'],
    ['空字符串', ''],
    ['null', null],
    ['数字', 0],
    ['对象', { detail: 'reasoning-canary-object' }]
  ])('reasoning_content 字段存在且值为%s时稳定拒绝', async (_name, reasoningContent) => {
    const contentCanary = `content-canary-${_name}`;
    const rawResponse = {
      choices: [{
        message: {
          content: contentCanary,
          reasoning_content: reasoningContent
        }
      }]
    };
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse(rawResponse));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    const error = await provider.respond(request, new AbortController().signal)
      .catch(reason => reason as unknown);
    expect(error).toMatchObject({
      code: 'LOCAL_MODEL_REASONING_LEAK',
      retryable: false
    });
    const observableError = error as Error;
    expect(String(error)).not.toContain(contentCanary);
    expect(observableError.message).not.toContain(contentCanary);
    expect(observableError.stack ?? '').not.toContain(contentCanary);
    expect(JSON.stringify(error)).not.toContain('reasoning-canary');
  });

  test('reasoning_content 字段不存在时接受普通文本', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '普通正文' } }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    await expect(provider.respond(request, new AbortController().signal)).resolves.toEqual({
      type: 'text',
      text: '普通正文'
    });
  });

  test('稳定拒绝 think 标签且错误不泄露正文', async () => {
    const contentCanary = '<think>reasoning-canary-think</think>最终答案';
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: contentCanary } }]
    }));
    const provider = new LocalModelProvider(readyPort(), fetchClient);

    const error = await provider.respond(request, new AbortController().signal)
      .catch(reason => reason as unknown);
    expect(error).toMatchObject({
      code: 'LOCAL_MODEL_REASONING_LEAK',
      retryable: false
    });
    expect(String(error)).not.toContain(contentCanary);
    expect(JSON.stringify(error)).not.toContain('reasoning-canary-think');
  });

  test('Runtime 未 ready 时不发送请求', async () => {
    const fetchClient = vi.fn<FetchLike>();
    const port = readyPort(() => {
      throw new ProviderError('LOCAL_MODEL_NOT_READY', true);
    });
    const provider = new LocalModelProvider(port, fetchClient);

    await expect(provider.respond(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'LOCAL_MODEL_NOT_READY'
    });
    expect(fetchClient).not.toHaveBeenCalled();
  });

  test('发送前 generation 已变化时不发送请求', async () => {
    const fetchClient = vi.fn<FetchLike>();
    const port = readyPort(vi.fn()
      .mockReturnValueOnce(connection)
      .mockReturnValueOnce({ ...connection, generation: 'generation-2' }));
    const provider = new LocalModelProvider(port, fetchClient);

    await expect(provider.respond(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'LOCAL_MODEL_CONNECTION_STALE',
      retryable: false
    });
    expect(fetchClient).not.toHaveBeenCalled();
  });

  test('取得连接后 Runtime 转为未 ready 时按失效连接拒绝且不发送请求', async () => {
    let ready = true;
    const fetchClient = vi.fn<FetchLike>();
    const port = readyPort(() => {
      if (ready) {
        ready = false;
        return connection;
      }
      throw new ProviderError('LOCAL_MODEL_NOT_READY', true);
    });
    const provider = new LocalModelProvider(port, fetchClient);

    await expect(provider.respond(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'LOCAL_MODEL_CONNECTION_STALE',
      retryable: false
    });
    expect(fetchClient).not.toHaveBeenCalled();
  });

  test('请求期间 generation 变化时拒绝迟到结果', async () => {
    const fetchClient = vi.fn<FetchLike>(async () => jsonResponse({
      choices: [{ message: { content: '迟到结果' } }]
    }));
    const port = readyPort(vi.fn()
      .mockReturnValueOnce(connection)
      .mockReturnValueOnce(connection)
      .mockReturnValueOnce({ ...connection, generation: 'generation-2' }));
    const provider = new LocalModelProvider(port, fetchClient);

    await expect(provider.respond(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'LOCAL_MODEL_CONNECTION_STALE',
      retryable: false
    });
    expect(fetchClient).toHaveBeenCalledOnce();
  });

  test.each([
    ['网络异常', () => Promise.reject(new Error('connection reset'))],
    ['HTTP 503', () => Promise.resolve(jsonResponse({ error: 'unavailable' }, 503))]
  ] as const)('请求期间 generation 变化时以失效连接覆盖%s', async (_name, response) => {
    let currentConnection = connection;
    const fetchClient = vi.fn<FetchLike>(async () => {
      currentConnection = { ...connection, generation: 'generation-2' };
      return response();
    });
    const provider = new LocalModelProvider(
      readyPort(() => currentConnection),
      fetchClient
    );

    await expect(provider.respond(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'LOCAL_MODEL_CONNECTION_STALE',
      retryable: false
    });
    expect(fetchClient).toHaveBeenCalledOnce();
  });
});
