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
import { ProviderResponseError } from './provider-response-error';
import { readOpenAIEventStream } from './openai-event-stream';

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

export interface OpenAIRequestPolicy {
  body: Readonly<Record<string, unknown>>;
  validateResponse(raw: unknown): void;
}

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
          arguments: z.unknown()
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
    throw new ProviderResponseError('HTTP_BODY_NOT_JSON', 'transport');
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
  responseContract: ModelResponseContract | undefined, purpose?: ModelRequest['purpose']
): ModelResponse {
  const parsed = compatibleResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'transport');

  const message = parsed.data.choices[0]?.message;
  if (!message) throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'transport');
  const toolCalls = message.tool_calls ?? [];
  if (toolCalls.length > 1) throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'transport');
  if (
    toolCalls.length === 1
    && purpose !== 'conversation'
    && typeof message.content === 'string'
    && message.content.length > 0
  ) {
    throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'transport');
  }

  const toolCall = toolCalls[0];
  if (toolCall) {
    try {
      if (typeof toolCall.function.arguments !== 'string') {
        throw new ProviderResponseError('TOOL_ARGUMENTS_INVALID', 'tool_call');
      }
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
      if (error instanceof ProviderError || error instanceof ProviderResponseError) throw error;
      throw new ProviderResponseError('TOOL_ARGUMENTS_INVALID', 'tool_call');
    }
  }

  if (typeof message.content !== 'string') {
    throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'transport');
  }
  const response = responseContract === undefined
    ? { type: 'text' as const, text: message.content }
    : normalizeResponseContractText(message.content, responseContract);
  if (responseContract === undefined && purpose !== 'conversation' && response.type === 'text') {
    if (message.metadata?.emotion !== undefined) {
      const emotion = characterEmotionLabelSchema.safeParse(message.metadata.emotion);
      if (!emotion.success) {
        throw new ProviderResponseError('CONTROL_SCHEMA_INVALID', 'chat_control');
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

/** 各 Provider 共用严格表现解码，只返回完整有效的无正文信封。 */
export function normalizeResponseContractText(
  raw: string,
  contract: ModelResponseContract
): Exclude<ModelResponse, { type: 'tool_request' }> {
  const decoded = decodeResponseContractText(raw, contract);
  if (decoded.kind === 'invalid') {
    throw new ProviderResponseError('RESPONSE_FORMAT_UNSUPPORTED', 'chat_control');
  }

  return { type: 'structured', structured_output: decoded.structured_output };
}

/** 响应契约没有系统权限，也不得与工具调用复用同一次 Provider 请求。 */
export function assertResponseContractRequest(request: ModelRequest): void {
  if (
    request.responseContract !== undefined
    && (request.tools.length > 0 || request.toolChoice !== 'none'
      || request.onTextDelta !== undefined)
  ) {
    throw new ProviderError('PROVIDER_RESPONSE_CONTRACT_CONFLICT', false);
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(
    config: OpenAICompatibleConfig,
    private readonly getSecret: () => Promise<string>,
    private readonly fetchClient: FetchLike = fetch,
    private readonly requestPolicy?: OpenAIRequestPolicy
  ) {
    this.config = resolveOpenAIConfig(config);
  }

  private readonly config: ProviderAdapterConfig;

  async respond(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    assertResponseContractRequest(request);
    const stream = request.purpose === 'conversation' && request.onTextDelta !== undefined
      && request.responseContract === undefined && this.requestPolicy?.body.stream !== false;
    const explicitStreamOption = this.requestPolicy?.body.stream !== undefined
      || this.config.additionalParameters?.stream !== undefined;
    const deepSeekConversation = this.config.providerId === 'deepseek' && request.purpose === 'conversation';
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
    const requestBody = JSON.stringify({
      ...this.config.additionalParameters,
      model: this.config.modelId,
      messages: request.messages.map(message => serializeMessage(message, toolNameCodec)),
      tools,
      tool_choice: toolChoice,
      ...(request.responseContract === undefined
        ? {}
        : { response_format: { type: 'json_object' } }),
      ...(deepSeekConversation
        ? { thinking: { type: 'disabled' }, max_tokens: 4_096 }
        : this.config.providerId === 'deepseek' && request.reasoningMode === 'disabled'
          ? { thinking: { type: 'disabled' } }
          : {}),
      ...this.requestPolicy?.body,
      ...(stream || explicitStreamOption ? { stream } : {})
    });

    let response: Response;
    try {
      response = await this.fetchClient(chatCompletionsUrl(this.config.baseUrl), {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await this.getSecret()}`
        },
        body: requestBody
      });
    } catch (error) {
      if (this.requestPolicy !== undefined && error instanceof ProviderError) throw error;
      normalizeFetchError(error, signal);
    }

    let rawResponse: unknown;
    if (stream && response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'text/event-stream') {
      if (!response.ok) throw normalizeHttpError(response.status);
      try {
        rawResponse = await readOpenAIEventStream(response, signal, request.onTextDelta!);
      } catch (error) {
        if (error instanceof ProviderError || error instanceof ProviderResponseError) throw error;
        normalizeFetchError(error, signal);
      }
    } else {
      rawResponse = await readProviderJson(response);
    }
    this.requestPolicy?.validateResponse(rawResponse);
    return normalizeResponse(
      rawResponse,
      toolNameCodec,
      request.responseContract, request.purpose
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
