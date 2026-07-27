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

const geminiPartSchema = z.union([
  z.object({
    text: z.string()
  }).strict(),
  z.object({
    functionCall: z.object({
      id: z.string().min(1).optional(),
      name: z.string().min(1),
      args: z.record(z.unknown())
    }).strict()
  }).strict()
]);

const geminiResponseSchema = z.object({
  candidates: z.array(z.object({
    content: z.object({
      parts: z.array(geminiPartSchema).min(1)
    })
  })).min(1)
});

function generateContentUrl(baseUrl: string, modelId: string): URL {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(
    `models/${encodeURIComponent(modelId)}:generateContent`,
    normalizedBase
  );
}

function parseToolResult(content: string): Record<string, unknown> {
  try {
    return z.record(z.unknown()).parse(JSON.parse(content));
  } catch {
    return { content };
  }
}

function serializeMessages(messages: ModelMessage[]): Array<Record<string, unknown>> {
  const toolNames = new Map<string, string>();

  return messages
    .filter(message => message.role !== 'system')
    .map(message => {
      if (message.role === 'system') {
        throw new ProviderError('PROVIDER_MALFORMED_REQUEST', false);
      }
      if (message.role === 'assistant' && message.toolRequest) {
        toolNames.set(message.toolRequest.requestId, message.toolRequest.toolName);
        return {
          role: 'model',
          parts: [{
            functionCall: {
              id: message.toolRequest.requestId,
              name: message.toolRequest.toolName,
              args: message.toolRequest.arguments
            }
          }]
        };
      }
      if (message.role === 'tool') {
        const toolName = toolNames.get(message.toolCallId);
        if (!toolName) {
          throw new ProviderError('PROVIDER_MALFORMED_REQUEST', false);
        }
        return {
          role: 'user',
          parts: [{
            functionResponse: {
              name: toolName,
              response: parseToolResult(message.content)
            }
          }]
        };
      }
      return {
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }]
      };
    });
}

function serializeTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  };
}

function normalizeResponse(raw: unknown): ModelResponse {
  const parsed = geminiResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);

  const parts = parsed.data.candidates[0]?.content.parts;
  if (!parts) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
  const textParts = parts.filter(part => 'text' in part);
  const functionParts = parts.filter(part => 'functionCall' in part);

  if (textParts.length === parts.length) {
    return {
      type: 'text',
      text: textParts.map(part => part.text).join('')
    };
  }
  if (functionParts.length === 1 && parts.length === 1) {
    const call = functionParts[0]?.functionCall;
    if (!call) throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
    return {
      type: 'tool_request',
      request: {
        requestId: call.id ?? `gemini-call-${call.name}`,
        toolName: call.name,
        arguments: call.args
      }
    };
  }
  throw new ProviderError('PROVIDER_MALFORMED_RESPONSE', false);
}

export class GeminiProvider implements ModelProvider {
  constructor(
    private readonly config: ProviderAdapterConfig,
    private readonly getSecret: () => Promise<string>,
    private readonly fetchClient: FetchLike = fetch
  ) {}

  async respond(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const systemParts = request.messages
      .filter(message => message.role === 'system')
      .map(message => ({ text: message.content }));
    const body: Record<string, unknown> = {
      ...this.config.additionalParameters,
      contents: serializeMessages(request.messages),
      tools: [{
        functionDeclarations: request.tools.map(serializeTool)
      }]
    };
    if (systemParts.length > 0) {
      body.systemInstruction = { parts: systemParts };
    }

    let response: Response;
    try {
      response = await this.fetchClient(
        generateContentUrl(this.config.baseUrl, this.config.modelId),
        {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': await this.getSecret()
          },
          body: JSON.stringify(body)
        }
      );
    } catch (error) {
      normalizeFetchError(error, signal);
    }

    return normalizeResponse(await readProviderJson(response));
  }
}
