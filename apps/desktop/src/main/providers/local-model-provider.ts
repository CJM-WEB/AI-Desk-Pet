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
  generation: string
): OpenAIRequestPolicy {
  return {
    body: localRequestBody,
    validateResponse(raw: unknown): void {
      assertCurrentGeneration(connectionPort, generation);
      assertNoReasoningLeak(raw);
    }
  };
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
      createRequestPolicy(this.connectionPort, connection.generation)
    );
    try {
      return await provider.respond({ ...request, reasoningMode: 'disabled' }, signal);
    } catch (error) {
      assertCurrentGeneration(this.connectionPort, connection.generation);
      throw error;
    }
  }
}
