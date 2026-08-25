import type {
  ModelProvider,
  ModelRequest,
  ModelResponse
} from '@myself/agent-core';
import {
  OpenAICompatibleProvider,
  ProviderError,
  type FetchLike,
  type OpenAIRequestPolicy
} from './openai-provider';

export interface LocalModelConnection {
  generation: string;
  baseUrl: string;
  token: string;
  modelId: string;
}

export interface LocalModelConnectionPort {
  getReadyConnection(): LocalModelConnection;
}

const localRequestBody = {
  stream: false,
  reasoning_effort: 'none',
  chat_template_kwargs: { enable_thinking: false },
  parallel_tool_calls: false,
  parse_tool_calls: true
} as const;

function assertCurrentGeneration(
  connectionPort: LocalModelConnectionPort,
  generation: string
): void {
  try {
    if (connectionPort.getReadyConnection().generation === generation) return;
  } catch {
    // 取得初始连接后的任何非 ready 状态都表示本次调用已经失效。
  }
  throw new ProviderError('LOCAL_MODEL_CONNECTION_STALE', false);
}

function assertNoReasoningLeak(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return;
  const choices = Reflect.get(raw, 'choices');
  if (!Array.isArray(choices)) return;

  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue;
    const message = Reflect.get(choice, 'message');
    if (typeof message !== 'object' || message === null) continue;
    const content = Reflect.get(message, 'content');
    if (
      Object.prototype.hasOwnProperty.call(message, 'reasoning_content')
      || (typeof content === 'string' && /<\/?think(?:\s[^>]*)?>/iu.test(content))
    ) {
      throw new ProviderError('LOCAL_MODEL_REASONING_LEAK', false);
    }
  }
}

function createRequestPolicy(
  connectionPort: LocalModelConnectionPort,
  generation: string,
  request: ModelRequest
): OpenAIRequestPolicy {
  const streamVisibleText = request.responseContract !== undefined
    && request.tools.length === 0
    && request.toolChoice === 'none'
    && request.onTextDelta !== undefined;
  return {
    body: {
      ...localRequestBody,
      stream: streamVisibleText,
      ...(request.toolChoice === 'required' ? { temperature: 0 } : {}),
      // 锁定的 llama.cpp 支持在 json_object 中附带 Schema；只约束本地结构化回合。
      ...(request.responseContract === undefined
        ? {}
        : {
            response_format: {
              type: 'json_object',
              schema: request.responseContract.jsonSchema
            }
          })
    },
    responseMode: streamVisibleText ? 'sse' : 'json',
    ...(streamVisibleText
      ? {
          onTextDelta: (delta: string): void => {
            assertCurrentGeneration(connectionPort, generation);
            request.onTextDelta?.(delta);
          },
          validateProjectedText: (text: string): void => {
            if (/<\/?think(?:\s[^>]*)?>/iu.test(text)) {
              throw new ProviderError('LOCAL_MODEL_REASONING_LEAK', false);
            }
          }
        }
      : {}),
    validateResponse(raw: unknown): void {
      assertCurrentGeneration(connectionPort, generation);
      assertNoReasoningLeak(raw);
    }
  };
}

/** 本地角色控制不接受纯文本降级；必填字段缺失时也不能发布无控制数据的成功响应。 */
function assertStructuredResponse(
  request: ModelRequest,
  response: ModelResponse
): void {
  const contract = request.responseContract;
  if (contract === undefined) return;
  if (response.type !== 'text' || response.structured_output === undefined) {
    throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  }
  if (
    contract.validateStructuredOutput !== undefined
    && !contract.validateStructuredOutput(response.structured_output)
  ) {
    throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  }
  const required = contract.jsonSchema['required'];
  if (
    Array.isArray(required)
    && required.some(field => (
      typeof field !== 'string'
      || !Object.prototype.hasOwnProperty.call(response.structured_output, field)
    ))
  ) {
    throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  }
}

/** 本地模型只复用 OpenAI 传输协议；连接有效性与非思考约束始终由 Main 强制。 */
export class LocalModelProvider implements ModelProvider {
  constructor(
    private readonly connectionPort: LocalModelConnectionPort,
    private readonly fetchClient: FetchLike = fetch
  ) {}

  async respond(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const connection = this.connectionPort.getReadyConnection();
    const provider = new OpenAICompatibleProvider(
      {
        baseUrl: connection.baseUrl,
        modelId: connection.modelId
      },
      async () => {
        assertCurrentGeneration(this.connectionPort, connection.generation);
        return connection.token;
      },
      this.fetchClient,
      createRequestPolicy(this.connectionPort, connection.generation, request)
    );
    try {
      const response = await provider.respond({ ...request, reasoningMode: 'disabled' }, signal);
      assertStructuredResponse(request, response);
      return response;
    } catch (error) {
      assertCurrentGeneration(this.connectionPort, connection.generation);
      throw error;
    }
  }
}
