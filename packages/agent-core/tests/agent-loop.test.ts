import { describe, expect, test, vi } from 'vitest';
import { AgentLoop } from '../src/agent-loop';
import type {
  AgentEvent,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  RunContext,
  ToolDefinition
} from '../src/types';

const toolNames = [
  'list_directory',
  'read_text_file',
  'create_file',
  'create_directory',
  'rename_entry'
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

async function collectEvents(context: RunContext): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of new AgentLoop().run('请处理文件', context)) events.push(event);
  return events;
}

function readRequest(requestId: string): ModelResponse {
  return {
    type: 'tool_request',
    request: {
      requestId,
      toolName: 'read_text_file',
      arguments: { relativePath: 'notes.txt' }
    }
  };
}

function context(provider: ModelProvider, signal = new AbortController().signal): RunContext {
  return {
    messages: [],
    provider,
    tools,
    writeTools: new Set(['create_file', 'create_directory', 'rename_entry']),
    executor: { executeRead: vi.fn(async () => ({ content: '文件内容' })) },
    signal
  };
}

describe('AgentLoop', () => {
  test('纯文本响应直接生成助手消息', async () => {
    const provider = new ScriptedProvider([{ type: 'text', text: '处理完成' }]);

    await expect(collectEvents(context(provider))).resolves.toEqual([
      { type: 'phase', phase: 'thinking' },
      { type: 'message', text: '处理完成' },
      { type: 'phase', phase: 'success' }
    ]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.tools).toEqual(tools);
  });

  test('读取工具执行后把结果交回模型生成最终文本', async () => {
    const provider = new ScriptedProvider([
      readRequest('read-1'),
      { type: 'text', text: 'notes.txt 的内容已读取' }
    ]);
    const runContext = context(provider);

    const events = await collectEvents(runContext);

    expect(runContext.executor.executeRead).toHaveBeenCalledOnce();
    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'read-1',
      content: '{"content":"文件内容"}'
    });
    expect(events.at(-2)).toEqual({ type: 'message', text: 'notes.txt 的内容已读取' });
  });

  test('写工具请求暂停并返回只用于 Main 的继续令牌', async () => {
    const provider = new ScriptedProvider([{
      type: 'tool_request',
      request: {
        requestId: 'write-1',
        toolName: 'create_file',
        arguments: { relativePath: 'result.txt' }
      }
    }]);
    const runContext = context(provider);

    const events = await collectEvents(runContext);

    expect(runContext.executor.executeRead).not.toHaveBeenCalled();
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
});
