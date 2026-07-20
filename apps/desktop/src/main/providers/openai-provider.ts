import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse
} from '@myself/agent-core';
import type { ProviderProfile } from '@myself/shared-types';
import { z } from 'zod';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const compatibleResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
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

function normalizeHttpError(status: number): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError('PROVIDER_AUTHENTICATION_FAILED', false, status);
  }
  if (status === 404) return new ProviderError('PROVIDER_ENDPOINT_NOT_FOUND', false, status);
  if (status === 429) return new ProviderError('PROVIDER_RATE_LIMITED', true, status);
  if (status >= 500) return new ProviderError('PROVIDER_SERVER_ERROR', true, status);
  return new ProviderError('PROVIDER_REQUEST_FAILED', false, status);
}

function serializeMessage(message: ModelMessage): Record<string, unknown> {
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
          name: message.toolRequest.toolName,
          arguments: JSON.stringify(message.toolRequest.arguments)
        }
      }]
    };
  }
  return { role: message.role, content: message.content };
}

function normalizeResponse(raw: unknown): ModelResponse {
  const parsed = compatibleResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);

  const message = parsed.data.choices[0]?.message;
  if (!message) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  const toolCalls = message.tool_calls ?? [];
  if (toolCalls.length > 1) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);

  const toolCall = toolCalls[0];
  if (toolCall) {
    try {
      const argumentsValue = toolArgumentsSchema.parse(JSON.parse(toolCall.function.arguments));
      return {
        type: 'tool_request',
        request: {
          requestId: toolCall.id,
          toolName: toolCall.function.name,
          arguments: argumentsValue
        }
      };
    } catch {
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }
  }

  if (typeof message.content !== 'string') {
    throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  }
  return { type: 'text', text: message.content };
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(
    private readonly profile: ProviderProfile,
    private readonly getSecret: () => Promise<string>,
    private readonly fetchClient: FetchLike = fetch
  ) {}

  async respond(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    let response: Response;
    try {
      response = await this.fetchClient(chatCompletionsUrl(this.profile.baseUrl), {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await this.getSecret()}`
        },
        body: JSON.stringify({
          model: this.profile.model,
          messages: request.messages.map(serializeMessage),
          tools: request.tools
        })
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw new ProviderError('PROVIDER_TIMEOUT', true);
      }
      throw new ProviderError('PROVIDER_NETWORK_ERROR', true);
    }

    if (!response.ok) throw normalizeHttpError(response.status);

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    }
    return normalizeResponse(raw);
  }
}
