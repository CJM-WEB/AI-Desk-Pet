import { describe, expect, test, vi } from 'vitest';
import { toolRequestSchema } from '@myself/shared-types';
import { AgentLoop } from '../src/agent-loop';
import {
  CAPABILITY_CLARIFICATION_TOOL_NAME,
  parseCapabilityClarificationRequest
} from '../src/capability-clarification-tool';
import type {
  AgentEvent,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  PreparedToolRequest,
  RunContext,
  ToolDefinition,
  ToolRuntime
} from '../src/types';

const toolNames = [
  'builtin.files.list_directory',
  'builtin.files.read_text',
  'builtin.files.create_file',
  'builtin.files.create_directory',
  'builtin.files.rename_entry'
] as const;

const tools: ToolDefinition[] = toolNames.map(name => ({
  type: 'function' as const,
  function: { name, description: `${name} 工具`, parameters: { type: 'object' } }
}));

class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async respond(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const response = this.responses.shift();
    if (!response) throw new Error('测试 Provider 没有更多响应');
    return response;
  }
}

class RepairDeferredProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  private readonly responses: Array<(response: ModelResponse) => void> = [];

  respond(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    return new Promise(resolve => {
      this.responses.push(resolve);
    });
  }

  resolve(index: number, response: ModelResponse): void {
    const resolve = this.responses[index];
    if (!resolve) throw new Error('缺少待完成的模型响应');
    resolve(response);
  }
}

async function collectEvents(context: RunContext): Promise<AgentEvent[]> {
  return collect(new AgentLoop().run('请处理文件', context));
}

async function collect(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function readRequest(requestId: string): ModelResponse {
  return {
    type: 'tool_request',
    request: {
      requestId,
      toolName: 'builtin.files.read_text',
      arguments: { relativePath: 'notes.txt' }
    }
  };
}

function createToolRuntime(): ToolRuntime {
  const executionNames: Record<string, string> = {
    'builtin.files.list_directory': 'list_directory',
    'builtin.files.read_text': 'read_text_file',
    'builtin.files.create_file': 'create_file',
    'builtin.files.create_directory': 'create_directory',
    'builtin.files.rename_entry': 'rename_entry'
  };
  const recoverable = new Set([
    'builtin.files.create_file',
    'builtin.files.create_directory',
    'builtin.files.rename_entry'
  ]);
  return {
    prepare(raw): PreparedToolRequest {
      const request = toolRequestSchema.parse(raw);
      const executionToolName = executionNames[request.toolName];
      if (!executionToolName) throw new Error('TOOL_UNKNOWN');
      const requiresConfirmation = recoverable.has(request.toolName);
      return {
        request,
        executionRequest: { ...request, toolName: executionToolName },
        risk: requiresConfirmation ? 'recoverable' : 'read',
        decision: requiresConfirmation ? 'confirm' : 'allow',
        auditSummary: `测试操作 ${String(request.arguments['relativePath'] ?? '')}`
      };
    },
    executeRead: vi.fn(async () => ({ content: '文件内容' }))
  };
}

function context(provider: ModelProvider, signal = new AbortController().signal): RunContext {
  return {
    messages: [],
    provider,
    tools,
    toolRuntime: createToolRuntime(),
    signal
  };
}

describe('AgentLoop', () => {
  test.each([
    {},
    { missingField: 'unknown' },
    { missingField: 'target_path', extra: true },
    { question: '请提供目标文件名' },
    { question: '请确认是否删除 empty 文件夹？' },
    { question: '目标文件名尚未提供。' }
  ])('澄清工具解析器拒绝不严格参数 %#', raw => {
    expect(() => parseCapabilityClarificationRequest(raw)).toThrow(
      'CAPABILITY_CLARIFICATION_INVALID'
    );
  });

  test('能力规划向 Provider 下发仅含 missingField 枚举的严格澄清 Schema', async () => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'clarification-schema',
        toolName: CAPABILITY_CLARIFICATION_TOOL_NAME,
        arguments: { missingField: 'target_path' }
      }
    }]);

    await collectEvents({
      ...context(provider),
      protocol: 'capability_planner'
    });

    expect(provider.requests[0]?.tools.at(-1)?.function.parameters).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['missingField'],
      properties: {
        missingField: {
          type: 'string',
          enum: [
            'target_path',
            'content',
            'patch',
            'command',
            'working_directory',
            'file_data_authorization'
          ]
        }
      }
    });
  });

  test('合法行为意图在助手消息之前发出', async () => {
    const intent = {
      stateIntent: { semantic: 'think' },
      actionSemantic: 'think',
      urgency: 50,
      explanation: '正在整理回应。'
    } as const;
    const events = await collectEvents(context(new ScriptedProvider([{
      type: 'text',
      text: '处理完成',
      behaviorIntent: intent
    }])));

    expect(events).toEqual([
      { type: 'phase', phase: 'thinking' },
      { type: 'behavior_intent', intent },
      { type: 'message', text: '处理完成' },
      { type: 'phase', phase: 'success' }
    ]);
  });

  test('缺少行为意图时不发出行为事件', async () => {
    const events = await collectEvents(context(new ScriptedProvider([{
      type: 'text',
      text: '处理完成'
    }])));

    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'behavior_intent'
    }));
  });

  test('非法行为意图被丢弃但保留文本成功流程', async () => {
    const events = await collectEvents(context(new ScriptedProvider([{
      type: 'text',
      text: '处理完成',
      behaviorIntent: {
        stateIntent: null,
        actionSemantic: 'dance',
        urgency: 50,
        explanation: '不应采用。'
      }
    } as unknown as ModelResponse])));

    expect(events).toEqual([
      { type: 'phase', phase: 'thinking' },
      { type: 'message', text: '处理完成' },
      { type: 'phase', phase: 'success' }
    ]);
  });

  test('结构化情绪标签在助手消息前产生明确 emotion 事件', async () => {
    const events = await collectEvents(context(new ScriptedProvider([{
      type: 'text',
      text: '处理完成',
      emotion: 'happy'
    }])));
    expect(events).toEqual([
      { type: 'phase', phase: 'thinking' },
      { type: 'emotion', label: 'happy' },
      { type: 'message', text: '处理完成' },
      { type: 'phase', phase: 'success' }
    ]);
  });

  test('未知结构化情绪标签被拒绝而不是转为自由状态', async () => {
    const provider = new ScriptedProvider([{
      type: 'text',
      text: '处理完成',
      emotion: 'unknown-emotion'
    } as unknown as ModelResponse]);
    await expect(collectEvents(context(provider))).rejects.toThrow(
      'AGENT_INVALID_EMOTION'
    );
  });

  test('只执行 ToolRuntime 准备后允许的内部读取请求', async () => {
    const provider = new ScriptedProvider([
      {
        type: 'tool_request',
        request: {
          requestId: 'read-runtime-1',
          toolName: 'builtin.files.read_text',
          arguments: { relativePath: 'notes.txt' }
        }
      },
      { type: 'text', text: '读取完成' }
    ]);
    const executeRead = vi.fn(async () => ({ content: '文件内容' }));
    const prepared: PreparedToolRequest = {
      request: {
        requestId: 'read-runtime-1',
        toolName: 'builtin.files.read_text',
        arguments: { relativePath: 'notes.txt' }
      },
      executionRequest: {
        requestId: 'read-runtime-1',
        toolName: 'read_text_file',
        arguments: { relativePath: 'notes.txt' }
      },
      risk: 'read',
      decision: 'allow',
      auditSummary: '读取文本 notes.txt'
    };
    const prepare = vi.fn(() => prepared);
    const runContext = {
      messages: [],
      provider,
      tools: [],
      toolRuntime: { prepare, executeRead },
      signal: new AbortController().signal
    } as unknown as RunContext;

    const events = await collectEvents(runContext);

    expect(prepare).toHaveBeenCalledOnce();
    expect(executeRead).toHaveBeenCalledExactlyOnceWith(prepared.executionRequest);
    expect(events).toContainEqual({ type: 'message', text: '读取完成' });
  });

  test('可恢复请求确认前不执行并携带 Main 私有执行信息', async () => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'write-runtime-1',
        toolName: 'builtin.files.create_file',
        arguments: { relativePath: 'result.txt' }
      }
    }]);
    const prepared: PreparedToolRequest = {
      request: {
        requestId: 'write-runtime-1',
        toolName: 'builtin.files.create_file',
        arguments: { relativePath: 'result.txt' }
      },
      executionRequest: {
        requestId: 'write-runtime-1',
        toolName: 'create_file',
        arguments: { relativePath: 'result.txt' }
      },
      risk: 'recoverable',
      decision: 'confirm',
      auditSummary: '创建文件 result.txt'
    };
    const executeRead = vi.fn();
    const runContext = {
      messages: [],
      provider,
      tools: [],
      toolRuntime: { prepare: vi.fn(() => prepared), executeRead },
      signal: new AbortController().signal
    } as unknown as RunContext;

    const events = await collectEvents(runContext);

    expect(executeRead).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'write_request',
      request: prepared.request,
      executionRequest: prepared.executionRequest,
      risk: 'recoverable',
      auditSummary: '创建文件 result.txt',
      continuationToken: expect.stringMatching(/^continue_/u)
    }));
  });

  test('明确拒绝的工具不执行也不要求模型纠错', async () => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'denied-1',
        toolName: 'mcp.system.delete',
        arguments: {}
      }
    }]);
    const executeRead = vi.fn();
    const runContext = {
      messages: [],
      provider,
      tools: [],
      toolRuntime: {
        prepare: vi.fn(() => ({
          request: {
            requestId: 'denied-1',
            toolName: 'mcp.system.delete',
            arguments: {}
          },
          executionRequest: {
            requestId: 'denied-1',
            toolName: 'delete',
            arguments: {}
          },
          risk: 'high',
          decision: 'deny',
          auditSummary: '删除条目'
        })),
        executeRead
      },
      signal: new AbortController().signal
    } as unknown as RunContext;

    await expect(collectEvents(runContext)).rejects.toThrow('TOOL_PERMISSION_DENIED');
    expect(provider.requests).toHaveLength(1);
    expect(executeRead).not.toHaveBeenCalled();
  });

  test('纯文本响应直接生成助手消息', async () => {
    const provider = new ScriptedProvider([{ type: 'text', text: '处理完成' }]);

    await expect(collectEvents(context(provider))).resolves.toEqual([
      { type: 'phase', phase: 'thinking' },
      { type: 'message', text: '处理完成' },
      { type: 'phase', phase: 'success' }
    ]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.tools).toEqual(tools);
    expect(provider.requests[0]).toMatchObject({
      toolChoice: 'auto',
      reasoningMode: 'provider_default'
    });
    expect(provider.requests[0]?.tools.map(tool => tool.function.name))
      .not.toContain(CAPABILITY_CLARIFICATION_TOOL_NAME);
  });

  test('带无权限结构化输出的文本响应不会进入工具运行时', async () => {
    const provider = new ScriptedProvider([{
      type: 'text',
      text: '我来散步啦',
      structured_output: { text: '我来散步啦', behaviorPlan: { kind: 'move' } }
    }]);
    const runContext = context(provider);
    const prepare = vi.spyOn(runContext.toolRuntime, 'prepare');

    await expect(collectEvents(runContext)).resolves.toEqual([
      { type: 'phase', phase: 'thinking' },
      { type: 'message', text: '我来散步啦' },
      { type: 'phase', phase: 'success' }
    ]);

    expect(prepare).not.toHaveBeenCalled();
  });

  test('文件规划在首次真实工具结果前拒绝普通文本，并在第二次违约时返回稳定错误', async () => {
    const provider = new ScriptedProvider([
      { type: 'text', text: '我没有权限执行这个文件任务' },
      { type: 'text', text: '文件已经创建完成' }
    ]);
    const runContext = { ...context(provider), protocol: 'capability_planner' as const };

    await expect(collectEvents(runContext)).rejects.toMatchObject({
      code: 'CAPABILITY_PLAN_PROTOCOL_INVALID'
    });

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]).toMatchObject({
      toolChoice: 'required',
      reasoningMode: 'disabled'
    });
    expect(provider.requests[0]?.tools.map(tool => tool.function.name))
      .toContain(CAPABILITY_CLARIFICATION_TOOL_NAME);
    expect(provider.requests[1]?.tools).toEqual(provider.requests[0]?.tools);
    expect(JSON.stringify(provider.requests[1]?.messages)).not.toContain('我没有权限执行这个文件任务');
    expect(provider.requests[1]?.messages.at(-1)).toEqual(expect.objectContaining({
      role: 'system',
      content: expect.stringContaining('CAPABILITY_PLAN_PROTOCOL_INVALID')
    }));
  });

  test('能力任务把最新真实工具失败保留为 error，即使模型返回总结文本', async () => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'shell-1',
        toolName: 'builtin.files.create_file',
        arguments: { relativePath: 'result.txt' }
      }
    }, { type: 'text', text: '命令已执行，详见输出。' }]);
    const loop = new AgentLoop();
    const runContext = { ...context(provider), protocol: 'capability_planner' as const };

    const firstEvents = await collect(loop.run('运行命令', runContext));
    const request = firstEvents.find(event => event.type === 'write_request');
    if (!request || request.type !== 'write_request') throw new Error('缺少待确认请求');
    const events = await collect(loop.resume(request.continuationToken, {
      ok: false,
      toolName: 'powershell',
      status: 'failed'
    }, runContext));

    expect(events).toContainEqual({ type: 'message', text: '命令已执行，详见输出。' });
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'error' });
  });

  test('第四轮确认恢复时以当前工具失败事实结束，且不把能力说成文件操作', async () => {
    const provider = new ScriptedProvider([
      readRequest('read-1'),
      readRequest('read-2'),
      readRequest('read-3'),
      {
        type: 'tool_request',
        request: {
          requestId: 'confirm-4',
          toolName: 'builtin.files.create_file',
          arguments: { relativePath: 'result.txt' }
        }
      }
    ]);
    const runtime = createToolRuntime();
    runtime.executeRead = vi.fn(async () => ({ ok: true, content: '已读取' }));
    const loop = new AgentLoop();
    const runContext = {
      ...context(provider),
      toolRuntime: runtime,
      protocol: 'capability_planner' as const
    };

    const firstEvents = await collect(loop.run('执行能力任务', runContext));
    const request = firstEvents.find(event => event.type === 'write_request');
    if (!request || request.type !== 'write_request') throw new Error('缺少第四轮确认');
    const events = await collect(loop.resume(request.continuationToken, {
      ok: false,
      toolName: 'powershell',
      status: 'failed'
    }, runContext));

    expect(events).toEqual([
      { type: 'message', text: '本地能力操作已结束；已达到模型响应轮次上限。' },
      { type: 'phase', phase: 'error' }
    ]);
  });

  test.each([
    ['target_path', '请提供目标文件或目录的相对路径。'],
    ['content', '请提供要写入的文件内容。'],
    ['patch', '请提供要应用的补丁内容。'],
    ['command', '请提供要执行的 PowerShell 命令。'],
    ['working_directory', '请提供要使用的工作目录。'],
    ['file_data_authorization', '请先开启文件数据授权。']
  ] as const)('文件规划按缺失字段 %s 公开宿主固定文案', async (missingField, message) => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'clarify-1',
        toolName: CAPABILITY_CLARIFICATION_TOOL_NAME,
        arguments: { missingField }
      }
    }]);
    const runtime = createToolRuntime();
    const prepare = vi.spyOn(runtime, 'prepare');
    const runContext = {
      ...context(provider),
      toolRuntime: runtime,
      protocol: 'capability_planner' as const
    };

    await expect(collectEvents(runContext)).resolves.toEqual([
      { type: 'phase', phase: 'thinking' },
      { type: 'message', text: message },
      { type: 'phase', phase: 'success' }
    ]);
    expect(prepare).not.toHaveBeenCalled();
  });

  test.each([
    { question: '请提供目标文件名', label: '旧自然语言缺参' },
    { question: '请确认是否删除指定的目标文件？', label: '旧执行确认' },
    { question: '目标文件名尚未提供。', label: '旧缺参陈述' },
    { missingField: 'unknown', label: '未知字段枚举' },
    { missingField: 'target_path', extra: true, label: '额外字段' }
  ])('文件规划拒绝旧对象或无效枚举：$label', async ({ label: _label, ...arguments_ }) => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'clarify-invalid-1',
        toolName: CAPABILITY_CLARIFICATION_TOOL_NAME,
        arguments: arguments_
      }
    }, {
      type: 'tool_request',
      request: {
        requestId: 'clarify-invalid-2',
        toolName: CAPABILITY_CLARIFICATION_TOOL_NAME,
        arguments: arguments_
      }
    }]);
    const runtime = createToolRuntime();
    const prepare = vi.spyOn(runtime, 'prepare');
    const runContext = {
      ...context(provider),
      toolRuntime: runtime,
      protocol: 'capability_planner' as const
    };

    await expect(collectEvents(runContext)).rejects.toMatchObject({
      code: 'CAPABILITY_PLAN_PROTOCOL_INVALID'
    });
    expect(provider.requests).toHaveLength(2);
    expect(prepare).not.toHaveBeenCalled();
  });

  test('文件规划把文本 JSON 澄清视为协议违约并仅修复一次', async () => {
    const provider = new ScriptedProvider([
      {
        type: 'text',
        text: '{"kind":"clarification_required","question":"请提供目标文件名"}'
      },
      {
        type: 'text',
        text: '{"kind":"clarification_required","question":"请提供目标文件名"}'
      }
    ]);
    const runContext = { ...context(provider), protocol: 'capability_planner' as const };

    await expect(collectEvents(runContext)).rejects.toMatchObject({
      code: 'CAPABILITY_PLAN_PROTOCOL_INVALID'
    });

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages.at(-1)).toEqual(expect.objectContaining({
      role: 'system',
      content: expect.stringContaining('CAPABILITY_PLAN_PROTOCOL_INVALID')
    }));
  });

  test('文件规划在修复请求等待期间中止后忽略迟到合法澄清', async () => {
    const controller = new AbortController();
    const provider = new RepairDeferredProvider();
    const runContext = {
      ...context(provider, controller.signal),
      protocol: 'capability_planner' as const
    };
    const running = collectEvents(runContext);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));

    provider.resolve(0, { type: 'text', text: '文件已经创建完成' });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    controller.abort();
    provider.resolve(1, {
      type: 'tool_request',
      request: {
        requestId: 'clarify-aborted',
        toolName: CAPABILITY_CLARIFICATION_TOOL_NAME,
        arguments: { missingField: 'target_path' }
      }
    });

    await expect(running).resolves.toEqual([
      { type: 'phase', phase: 'thinking' },
      { type: 'phase', phase: 'cancelled' }
    ]);
  });

  test.each([
    '```json\n{"kind":"clarification_required","question":"请提供文件名"}\n```',
    '{"kind":"clarification_required","question":"请提供文件名","extra":true}',
    '{"kind":"clarification_required","question":"   "}',
    `{"kind":"clarification_required","question":"${'a'.repeat(1_001)}"}`
  ])('文件规划把工具前的非法澄清文本 %s 视为协议违约', async text => {
    const provider = new ScriptedProvider([
      { type: 'text', text },
      { type: 'text', text }
    ]);
    const runContext = { ...context(provider), protocol: 'capability_planner' as const };

    await expect(collectEvents(runContext)).rejects.toMatchObject({
      code: 'CAPABILITY_PLAN_PROTOCOL_INVALID'
    });
    expect(provider.requests).toHaveLength(2);
  });

  test('读取工具执行后把结果交回模型生成最终文本', async () => {
    const provider = new ScriptedProvider([
      readRequest('read-1'),
      { type: 'text', text: 'notes.txt 的内容已读取' }
    ]);
    const runContext = { ...context(provider), protocol: 'capability_planner' as const };

    const events = await collectEvents(runContext);

    expect(runContext.toolRuntime.executeRead).toHaveBeenCalledOnce();
    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'read-1',
      content: '{"content":"文件内容"}'
    });
    expect(provider.requests[1]).toMatchObject({
      toolChoice: 'auto',
      reasoningMode: 'disabled'
    });
    expect(provider.requests[1]?.tools.map(tool => tool.function.name))
      .not.toContain(CAPABILITY_CLARIFICATION_TOOL_NAME);
    expect(events.at(-2)).toEqual({ type: 'message', text: 'notes.txt 的内容已读取' });
  });

  test('读后拒绝未下发的澄清工具且不交给工具运行时', async () => {
    const provider = new ScriptedProvider([
      readRequest('read-before-invalid-clarification'),
      {
        type: 'tool_request',
        request: {
          requestId: 'clarify-after-read',
          toolName: CAPABILITY_CLARIFICATION_TOOL_NAME,
          arguments: { missingField: 'target_path' }
        }
      }
    ]);
    const runtime = createToolRuntime();
    const prepare = vi.spyOn(runtime, 'prepare');
    const runContext = {
      ...context(provider),
      toolRuntime: runtime,
      protocol: 'capability_planner' as const
    };

    await expect(collectEvents(runContext)).rejects.toThrow('AGENT_INVALID_TOOL_REQUEST');
    expect(prepare).toHaveBeenCalledOnce();
  });

  test('写工具请求暂停并返回只用于 Main 的继续令牌', async () => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'write-1',
        toolName: 'builtin.files.create_file',
        arguments: { relativePath: 'result.txt' }
      }
    }]);
    const runContext = context(provider);

    const events = await collectEvents(runContext);

    expect(runContext.toolRuntime.executeRead).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'write_request',
      request: expect.objectContaining({ requestId: 'write-1' }),
      continuationToken: expect.stringMatching(/^continue_/u)
    }));
    expect(events).toContainEqual({ type: 'phase', phase: 'awaiting_confirmation' });
  });

  test('无效工具请求只允许模型修正一次', async () => {
    const invalid = {
      type: 'tool_request' as const,
      request: { requestId: 'bad-1', toolName: 'delete_everything', arguments: {} }
    };
    const provider = new ScriptedProvider([invalid, { type: 'text', text: '已修正' }]);

    const events = await collectEvents(context(provider));

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages.at(-1)).toEqual(expect.objectContaining({
      role: 'system',
      content: expect.stringContaining('INVALID_TOOL_REQUEST')
    }));
    expect(events).toContainEqual({ type: 'message', text: '已修正' });
  });

  test('第二次无效工具请求立即失败', async () => {
    const invalid = {
      type: 'tool_request' as const,
      request: { requestId: 'bad-1', toolName: 'delete_everything', arguments: {} }
    };
    const provider = new ScriptedProvider([invalid, invalid]);

    await expect(collectEvents(context(provider))).rejects.toThrow('AGENT_INVALID_TOOL_REQUEST');
    expect(provider.requests).toHaveLength(2);
  });

  test('最多请求四次模型响应且绝不发起第五次', async () => {
    const provider = new ScriptedProvider([
      readRequest('read-1'),
      readRequest('read-2'),
      readRequest('read-3'),
      readRequest('read-4'),
      { type: 'text', text: '不应被请求' }
    ]);

    await expect(collectEvents(context(provider))).rejects.toThrow('AGENT_MAX_TURNS');
    expect(provider.requests).toHaveLength(4);
  });

  test('开始前已中止时产生取消状态且不调用模型', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new ScriptedProvider([{ type: 'text', text: '不应被请求' }]);

    await expect(collectEvents(context(provider, controller.signal))).resolves.toEqual([
      { type: 'phase', phase: 'cancelled' }
    ]);
    expect(provider.requests).toHaveLength(0);
  });

  test('确认后单次消费继续令牌并把真实工具结果交回模型', async () => {
    const provider = new ScriptedProvider([
      {
        type: 'tool_request',
        request: {
          requestId: 'write-1',
          toolName: 'builtin.files.create_file',
          arguments: { relativePath: 'result.txt' }
        }
      },
      { type: 'text', text: 'result.txt 已创建' }
    ]);
    const runContext = context(provider);
    const loop = new AgentLoop();
    const paused = await collect(loop.run('创建 result.txt', runContext));
    const writeEvent = paused.find(event => event.type === 'write_request');
    if (!writeEvent || writeEvent.type !== 'write_request') throw new Error('缺少写请求事件');

    const resumed = await collect(loop.resume(
      writeEvent.continuationToken,
      { ok: true, toolName: 'create_file', targetRelativePath: 'result.txt' },
      runContext
    ));

    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'write-1',
      content: '{"ok":true,"toolName":"create_file","targetRelativePath":"result.txt"}'
    });
    expect(provider.requests[1]).toMatchObject({
      tools: [],
      toolChoice: 'none',
      reasoningMode: 'provider_default'
    });
    expect(resumed).toEqual([
      { type: 'phase', phase: 'thinking' },
      { type: 'message', text: 'result.txt 已创建' },
      { type: 'phase', phase: 'success' }
    ]);
    await expect(collect(loop.resume(
      writeEvent.continuationToken,
      { ok: true },
      runContext
    ))).rejects.toThrow('ACTION_EXPIRED');
  });

  test('写入结果续跑后拒绝模型再次调用工具，且不重复准备写入', async () => {
    const provider = new ScriptedProvider([
      {
        type: 'tool_request',
        request: {
          requestId: 'write-once-1',
          toolName: 'builtin.files.create_file',
          arguments: { relativePath: 'result.txt' }
        }
      },
      {
        type: 'tool_request',
        request: {
          requestId: 'write-once-2',
          toolName: 'builtin.files.create_file',
          arguments: { relativePath: 'again.txt' }
        }
      }
    ]);
    const runtime = createToolRuntime();
    const prepare = vi.spyOn(runtime, 'prepare');
    const runContext = { ...context(provider), toolRuntime: runtime };
    const loop = new AgentLoop();
    const paused = await collect(loop.run('创建 result.txt', runContext));
    const writeEvent = paused.find(event => event.type === 'write_request');
    if (!writeEvent || writeEvent.type !== 'write_request') throw new Error('缺少写请求事件');

    await expect(collect(loop.resume(
      writeEvent.continuationToken,
      { ok: true, toolName: 'create_file', targetRelativePath: 'result.txt' },
      runContext
    ))).rejects.toThrow('AGENT_FINALIZATION_TOOL_REQUEST');

    expect(provider.requests[1]).toMatchObject({ tools: [], toolChoice: 'none' });
    expect(prepare).toHaveBeenCalledOnce();
  });

  test('丢弃继续令牌后不能恢复', async () => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'write-1',
        toolName: 'builtin.files.create_directory',
        arguments: { relativePath: 'output' }
      }
    }]);
    const runContext = context(provider);
    const loop = new AgentLoop();
    const paused = await collect(loop.run('创建 output', runContext));
    const writeEvent = paused.find(event => event.type === 'write_request');
    if (!writeEvent || writeEvent.type !== 'write_request') throw new Error('缺少写请求事件');

    loop.discard(writeEvent.continuationToken);

    await expect(collect(loop.resume(
      writeEvent.continuationToken,
      { ok: true },
      runContext
    ))).rejects.toThrow('ACTION_EXPIRED');
  });

  test('第四次响应才请求写操作时不发起第五次模型调用', async () => {
    const provider = new ScriptedProvider([
      readRequest('read-1'),
      readRequest('read-2'),
      readRequest('read-3'),
      {
        type: 'tool_request',
        request: {
          requestId: 'write-4',
          toolName: 'builtin.files.create_file',
          arguments: { relativePath: 'result.txt' }
        }
      },
      { type: 'text', text: '不应被请求' }
    ]);
    const runContext = context(provider);
    const loop = new AgentLoop();
    const paused = await collect(loop.run('读取后创建文件', runContext));
    const writeEvent = paused.find(event => event.type === 'write_request');
    if (!writeEvent || writeEvent.type !== 'write_request') throw new Error('缺少写请求事件');

    await expect(collect(loop.resume(
      writeEvent.continuationToken,
      { ok: true },
      runContext
    ))).resolves.toEqual([
      { type: 'message', text: '本地能力操作已结束；已达到模型响应轮次上限。' },
      { type: 'phase', phase: 'success' }
    ]);
    expect(provider.requests).toHaveLength(4);
  });
});
