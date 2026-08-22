import {
  decodeResponseContractText,
  type ModelResponseContract,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ToolDefinition
} from '@myself/agent-core';
import {
  characterEmotionLabelSchema,
  type ProviderProfile
} from '@myself/shared-types';
import { characterAgentBehaviorIntentSchema } from '@myself/character-runtime';
import { z } from 'zod';
import {
  createOpenAIToolNameCodec,
  type OpenAIToolNameCodec
} from './openai-tool-name-codec';

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type AdditionalParameterValue = string | number | boolean;

export interface ProviderAdapterConfig {
  baseUrl: string;
  modelId: string;
  providerId?: string;
  additionalParameters?: Record<string, AdditionalParameterValue>;
}

type OpenAICompatibleConfig = ProviderAdapterConfig | ProviderProfile;

const compatibleResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
      metadata: z.object({
        emotion: z.unknown().optional(),
        behaviorIntent: z.unknown().optional()
      }).optional(),
      tool_calls: z.array(z.object({
        id: z.string().min(1),
        type: z.literal('function'),
        function: z.object({
          name: z.string().min(1),
          arguments: z.string()
        })
      })).optional()
    })
  })).min(1)
});

const toolArgumentsSchema = z.record(z.unknown());

export class ProviderError extends Error {
  readonly name = 'ProviderError';

  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly status: number | undefined = undefined
  ) {
    super(code);
  }
}

function chatCompletionsUrl(baseUrl: string): URL {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL('chat/completions', normalizedBase);
}

function resolveOpenAIConfig(config: OpenAICompatibleConfig): ProviderAdapterConfig {
  if ('modelId' in config) return config;
  return {
    baseUrl: config.baseUrl,
    modelId: config.model
  };
}

export function normalizeHttpError(status: number): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError('PROVIDER_AUTHENTICATION_FAILED', false, status);
  }
  if (status === 404) return new ProviderError('PROVIDER_ENDPOINT_NOT_FOUND', false, status);
  if (status === 429) return new ProviderError('PROVIDER_RATE_LIMITED', true, status);
  if (status >= 500) return new ProviderError('PROVIDER_SERVER_ERROR', true, status);
  return new ProviderError('PROVIDER_REQUEST_FAILED', false, status);
}

export function normalizeFetchError(error: unknown, _signal: AbortSignal): never {
  if (error instanceof Error && error.name === 'AbortError') {
    throw error;
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    throw new ProviderError('PROVIDER_TIMEOUT', true);
  }
  throw new ProviderError('PROVIDER_NETWORK_ERROR', true);
}

export async function readProviderJson(response: Response): Promise<unknown> {
  if (!response.ok) throw normalizeHttpError(response.status);

  try {
    return await response.json();
  } catch {
    throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  }
}

function serializeMessage(
  message: ModelMessage,
  toolNameCodec: OpenAIToolNameCodec
): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content
    };
  }
  if (message.role === 'assistant' && message.toolRequest) {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: message.toolRequest.requestId,
        type: 'function',
        function: {
          name: toolNameCodec.encode(message.toolRequest.toolName),
          arguments: JSON.stringify(message.toolRequest.arguments)
        }
      }]
    };
  }
  return { role: message.role, content: message.content };
}

function normalizeResponse(
  raw: unknown,
  toolNameCodec: OpenAIToolNameCodec,
  responseContract: ModelResponseContract | undefined
): ModelResponse {
  const parsed = compatibleResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);

  const message = parsed.data.choices[0]?.message;
  if (!message) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  const toolCalls = message.tool_calls ?? [];
  if (toolCalls.length > 1) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  if (
    toolCalls.length === 1
    && typeof message.content === 'string'
    && message.content.length > 0
  ) {
    throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  }

  const toolCall = toolCalls[0];
  if (toolCall) {
    try {
      const argumentsValue = toolArgumentsSchema.parse(JSON.parse(toolCall.function.arguments));
      let toolName: string;
      try {
        toolName = toolNameCodec.decode(toolCall.function.name);
      } catch {
        throw new ProviderError('PROVIDER_UNKNOWN_TOOL_CALL', false);
      }
      return {
        type: 'tool_request',
        request: {
          requestId: toolCall.id,
          toolName,
          arguments: argumentsValue
        }
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }
  }

  if (typeof message.content !== 'string') {
    throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  }
  const response = responseContract === undefined
    ? { type: 'text' as const, text: message.content }
    : normalizeResponseContractText(message.content, responseContract);
  if (responseContract === undefined) {
    if (message.metadata?.emotion !== undefined) {
      const emotion = characterEmotionLabelSchema.safeParse(message.metadata.emotion);
      if (!emotion.success) {
        throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
      }
      response.emotion = emotion.data;
    }
    // 旧元数据只服务无响应契约的能力任务；结构化聊天以正文契约为唯一来源。
    const behaviorIntent = characterAgentBehaviorIntentSchema.safeParse(
      message.metadata?.behaviorIntent
    );
    if (behaviorIntent.success) response.behaviorIntent = behaviorIntent.data;
  }
  return response;
}

/** 三类 Provider 共用同一正文降级规则，避免协议适配器各自实现不一致的恢复逻辑。 */
export function normalizeResponseContractText(
  raw: string,
  contract: ModelResponseContract
): Extract<ModelResponse, { type: 'text' }> {
  const decoded = decodeResponseContractText(raw, contract);
  if (decoded.kind === 'invalid') {
    throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  }
  if (decoded.kind === 'plain_text') {
    return { type: 'text', text: decoded.text };
  }
  return {
    type: 'text',
    text: decoded.text,
    structured_output: decoded.structured_output
  };
}

/** 响应契约没有系统权限，也不得与工具调用复用同一次 Provider 请求。 */
export function assertResponseContractRequest(request: ModelRequest): void {
  if (
    request.responseContract !== undefined
    && (request.tools.length > 0 || request.toolChoice !== 'none')
  ) {
    throw new ProviderError('PROVIDER_RESPONSE_CONTRACT_CONFLICT', false);
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(
    config: OpenAICompatibleConfig,
    private readonly getSecret: () => Promise<string>,
    private readonly fetchClient: FetchLike = fetch
  ) {
    this.config = resolveOpenAIConfig(config);
  }

  private readonly config: ProviderAdapterConfig;

  async respond(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    assertResponseContractRequest(request);
    // 单次请求复用同一映射，确保定义、续传历史与响应名称处于同一 Provider 命名空间。
    const toolChoice = resolveToolChoice(request);
    const toolNameCodec = createOpenAIToolNameCodec(codecDefinitions(request));
    const tools = request.tools.map(definition => ({
      ...definition,
      function: {
        ...definition.function,
        name: toolNameCodec.encode(definition.function.name)
      }
    }));
    let response: Response;
    try {
      response = await this.fetchClient(chatCompletionsUrl(this.config.baseUrl), {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await this.getSecret()}`
        },
        body: JSON.stringify({
          ...this.config.additionalParameters,
          model: this.config.modelId,
          messages: request.messages.map(message => serializeMessage(message, toolNameCodec)),
          tools,
          tool_choice: toolChoice,
          ...(request.responseContract === undefined
            ? {}
            : { response_format: { type: 'json_object' } }),
          ...(this.config.providerId === 'deepseek' && request.reasoningMode === 'disabled'
            ? { thinking: { type: 'disabled' } }
            : {})
        })
      });
    } catch (error) {
      normalizeFetchError(error, signal);
    }

    return normalizeResponse(
      await readProviderJson(response),
      toolNameCodec,
      request.responseContract
    );
  }
}

function resolveToolChoice(request: ModelRequest): ModelRequest['toolChoice'] {
  if (request.tools.length === 0 && request.toolChoice !== 'none') {
    throw new ProviderError('PROVIDER_TOOL_CHOICE_INVALID', false);
  }
  if (request.tools.length > 0 && request.toolChoice === 'none') {
    throw new ProviderError('PROVIDER_TOOL_CHOICE_INVALID', false);
  }
  return request.toolChoice;
}

function codecDefinitions(request: ModelRequest): ToolDefinition[] {
  return [
    ...request.tools,
    ...request.messages.flatMap(message => (
      message.role === 'assistant' && message.toolRequest
        ? [{
            type: 'function' as const,
            function: {
              name: message.toolRequest.toolName,
              description: '',
              parameters: {}
            }
          }]
        : []
    ))
  ];
}
