import type { CodingModelConnection } from '@myself/coding-task-core';
import type { ProviderCatalogEntry, ProviderProfileV2 } from '@myself/shared-types';
import type { LocalModelConnectionPort } from './local-model-provider';
import { isBuiltinLocalProviderProfile } from '../local-model/local-model-route';
import { ProviderError } from './openai-provider';
import { resolveProviderProfile } from './provider-registry';

export interface CodingModelConnectionOptions {
  catalog: readonly ProviderCatalogEntry[];
  readSecret(): Promise<string>;
  localModel?: LocalModelConnectionPort;
}

export function createCodingModelConnection(
  profile: ProviderProfileV2,
  options: CodingModelConnectionOptions
): CodingModelConnection {
  if (isBuiltinLocalProviderProfile(profile)) {
    if (!options.localModel) {
      throw new ProviderError('LOCAL_MODEL_CONNECTION_PORT_NOT_CONFIGURED', false);
    }
    const connectionPort = options.localModel;
    const snapshot = connectionPort.getReadyConnection();
    return Object.freeze({
      baseUrl: snapshot.baseUrl,
      modelId: snapshot.modelId,
      contextWindow: 8_192,
      outputTokens: 2_048,
      protocol: 'openai-chat',
      compaction: Object.freeze({ buffer: 2_048, keepTokens: 2_048 }),
      requestBody: Object.freeze({
        reasoning_effort: 'none',
        chat_template_kwargs: Object.freeze({ enable_thinking: false }),
        parallel_tool_calls: false,
        parse_tool_calls: true
      }),
      async readCredential(): Promise<string> {
        let current;
        try {
          current = connectionPort.getReadyConnection();
        } catch {
          throw new ProviderError('LOCAL_MODEL_CONNECTION_STALE', false);
        }
        if (
          current.generation !== snapshot.generation
          || current.baseUrl !== snapshot.baseUrl
          || current.modelId !== snapshot.modelId
        ) {
          throw new ProviderError('LOCAL_MODEL_CONNECTION_STALE', false);
        }
        return snapshot.token;
      }
    });
  }

  const { protocol, config } = resolveProviderProfile(profile, options.catalog);
  if (protocol !== 'openai-compatible') {
    throw new ProviderError('CODING_MODEL_PROTOCOL_UNSUPPORTED', false);
  }
  const deepSeek = config.providerId === 'deepseek';
  const deepSeekV4 = deepSeek && config.modelId === 'deepseek-v4-flash';
  return Object.freeze({
    baseUrl: config.baseUrl,
    modelId: config.modelId,
    contextWindow: deepSeekV4 ? 1_000_000 : 8_192,
    outputTokens: deepSeekV4 ? 8_192 : 2_048,
    protocol: deepSeek ? 'deepseek' : 'openai-chat',
    ...(deepSeekV4
      ? {}
      : { compaction: Object.freeze({ buffer: 2_048, keepTokens: 2_048 }) }),
    ...(config.additionalParameters === undefined
      ? {}
      : { requestBody: Object.freeze({ ...config.additionalParameters }) }),
    readCredential: options.readSecret
  });
}
