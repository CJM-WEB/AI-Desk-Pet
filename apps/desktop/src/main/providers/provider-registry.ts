import type { ModelProvider } from '@myself/agent-core';
import type {
  ProviderCatalogEntry,
  ProviderProfileV2,
  ProviderProtocol
} from '@myself/shared-types';
import { AnthropicProvider } from './anthropic-provider';
import { GeminiProvider } from './gemini-provider';
import {
  type FetchLike,
  type ProviderAdapterConfig,
  OpenAICompatibleProvider,
  ProviderError
} from './openai-provider';

const reservedAdditionalParameters = new Set([
  'model',
  'messages',
  'contents',
  'system',
  'systeminstruction',
  'tools',
  'tool_choice',
  'stream',
  'max_tokens',
  'generationconfig',
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'anthropic-version',
  'timeout'
]);

function validateAdditionalParameters(
  additionalParameters: Record<string, string | number | boolean>
): void {
  for (const key of Object.keys(additionalParameters)) {
    if (reservedAdditionalParameters.has(key.toLowerCase())) {
      throw new ProviderError('PROVIDER_RESERVED_PARAMETER', false);
    }
  }
}

function resolveProfile(
  profile: ProviderProfileV2,
  catalog: readonly ProviderCatalogEntry[]
): { protocol: ProviderProtocol; config: ProviderAdapterConfig } {
  if (profile.mode === 'custom') {
    validateAdditionalParameters(profile.additionalParameters);
    return {
      protocol: profile.protocol,
      config: {
        baseUrl: profile.baseUrl,
        modelId: profile.modelId,
        additionalParameters: profile.additionalParameters
      }
    };
  }

  const entry = catalog.find(item => item.providerId === profile.providerId);
  if (!entry) {
    throw new ProviderError('PROVIDER_CATALOG_ENTRY_NOT_FOUND', false);
  }
  return {
    protocol: entry.protocol,
    config: {
      baseUrl: entry.baseUrl,
      modelId: profile.modelId
    }
  };
}

export class ProviderRegistry {
  constructor(private readonly catalog: readonly ProviderCatalogEntry[]) {}

  create(
    profile: ProviderProfileV2,
    getSecret: () => Promise<string>,
    fetchClient?: FetchLike
  ): ModelProvider {
    const { protocol, config } = resolveProfile(profile, this.catalog);

    if (protocol === 'anthropic') {
      return new AnthropicProvider(config, getSecret, fetchClient);
    }
    if (protocol === 'gemini') {
      return new GeminiProvider(config, getSecret, fetchClient);
    }
    return new OpenAICompatibleProvider(config, getSecret, fetchClient);
  }
}
