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
import { isBuiltinLocalProviderProfile } from '../local-model/local-model-route';
import {
  ProviderResponseDiagnostics,
  type ProviderResponseDiagnosticSink
} from './diagnosed-provider';
import type { ProviderResponseError } from './provider-response-error';

export type BuiltinLocalProviderFactory = () => ModelProvider;

export interface ProviderRegistryDiagnosticsOptions {
  sink: ProviderResponseDiagnosticSink;
  createCorrelationId?: () => string;
}

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
  'response_format',
  'output_config',
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
      modelId: profile.modelId,
      providerId: entry.providerId
    }
  };
}

export class ProviderRegistry {
  constructor(
    private readonly catalog: readonly ProviderCatalogEntry[],
    private readonly builtinLocalProviderFactory?: BuiltinLocalProviderFactory,
    private readonly diagnosticsOptions?: ProviderRegistryDiagnosticsOptions
  ) {}

  create(
    profile: ProviderProfileV2,
    getSecret: () => Promise<string>,
    fetchClient?: FetchLike
  ): ModelProvider {
    if (isBuiltinLocalProviderProfile(profile)) {
      if (!this.builtinLocalProviderFactory) {
        throw new ProviderError('LOCAL_MODEL_PROVIDER_FACTORY_NOT_CONFIGURED', false);
      }
      return this.wrapWithDiagnostics(profile, this.builtinLocalProviderFactory());
    }

    const { protocol, config } = resolveProfile(profile, this.catalog);

    if (protocol === 'anthropic') {
      return this.wrapWithDiagnostics(profile,
        new AnthropicProvider(config, getSecret, fetchClient)
      );
    }
    if (protocol === 'gemini') {
      return this.wrapWithDiagnostics(profile,
        new GeminiProvider(config, getSecret, fetchClient)
      );
    }
    return this.wrapWithDiagnostics(profile,
      new OpenAICompatibleProvider(config, getSecret, fetchClient)
    );
  }

  reportResponseError(
    profile: ProviderProfileV2,
    error: ProviderResponseError,
    correlationId?: string
  ): void {
    this.createDiagnostics(profile)?.report(error, correlationId);
  }

  private wrapWithDiagnostics(profile: ProviderProfileV2, provider: ModelProvider): ModelProvider {
    return this.createDiagnostics(profile)?.wrap(provider) ?? provider;
  }

  private createDiagnostics(profile: ProviderProfileV2): ProviderResponseDiagnostics | null {
    if (!this.diagnosticsOptions) return null;
    return new ProviderResponseDiagnostics({
      providerType: profile.mode === 'preset' ? profile.providerId : profile.protocol,
      sink: this.diagnosticsOptions.sink,
      ...(this.diagnosticsOptions.createCorrelationId === undefined
        ? {}
        : { createCorrelationId: this.diagnosticsOptions.createCorrelationId })
    });
  }
}
