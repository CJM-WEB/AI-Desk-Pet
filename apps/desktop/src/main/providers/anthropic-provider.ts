import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ToolDefinition
} from '@myself/agent-core';
import { z } from 'zod';
import {
  type FetchLike,
  type ProviderAdapterConfig,
  ProviderError,
  normalizeFetchError,
  readProviderJson
} from './openai-provider';

const anthropicContentBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string()
  }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.record(z.unknown())
  })
]);

const anthropicResponseSchema = z.object({
  content: z.array(anthropicContentBlockSchema).min(1)
});

function messagesUrl(baseUrl: string): URL {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL('messages', normalizedBase);
}

function serializeMessage(message: ModelMessage): {
  role: 'user' | 'assistant';
  content: Array<Record<string, unknown>>;
} {
  if (message.role === 'system') {
    throw new ProviderError('PROVIDER_MALFORMED_REQUEST', false);
  }
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content
      }]
    };
  }
  if (message.role === 'assistant' && message.toolRequest) {
    return {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: message.toolRequest.requestId,
        name: message.toolRequest.toolName,
        input: message.toolRequest.arguments
      }]
    };
  }
  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: [{ type: 'text', text: message.content }]
  };
}

function serializeTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters
  };
}

function normalizeResponse(raw: unknown): ModelResponse {
  const parsed = anthropicResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);

  const blocks = parsed.data.content;
  const textBlocks = blocks.filter(block => block.type === 'text');
  const toolBlocks = blocks.filter(block => block.type === 'tool_use');

  if (textBlocks.length === blocks.length) {
    return {
      type: 'text',
      text: textBlocks.map(block => block.text).join('')
    };
  }
  if (toolBlocks.length === 1 && blocks.length === 1) {
    const tool = toolBlocks[0];
    if (!tool) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    return {
      type: 'tool_request',
      request: {
        requestId: tool.id,
        toolName: tool.name,
        arguments: tool.input
      }
    };
  }
  throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
}

export class AnthropicProvider implements ModelProvider {
  constructor(
    private readonly config: ProviderAdapterConfig,
    private readonly getSecret: () => Promise<string>,
    private readonly fetchClient: FetchLike = fetch
  ) {}

  async respond(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const systemMessages = request.messages
      .filter(message => message.role === 'system')
      .map(message => message.content);
    const messages = request.messages
      .filter(message => message.role !== 'system')
      .map(serializeMessage);
    const body: Record<string, unknown> = {
      ...this.config.additionalParameters,
      model: this.config.modelId,
      max_tokens: 4096,
      messages,
      tools: request.tools.map(serializeTool)
    };
    if (systemMessages.length > 0) body.system = systemMessages.join('\n\n');

    let response: Response;
    try {
      response = await this.fetchClient(messagesUrl(this.config.baseUrl), {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': await this.getSecret(),
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      normalizeFetchError(error, signal);
    }

    return normalizeResponse(await readProviderJson(response));
  }
}
