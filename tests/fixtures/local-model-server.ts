import type {
  LocalModelConnection,
  LocalModelConnectionPort
} from '../../apps/desktop/src/main/providers/local-model-provider';
import {
  startProviderServer,
  type ProviderScript,
  type ProviderServerFixture
} from './provider-server';

export interface LocalModelServerFixture extends ProviderServerFixture {
  connectionPort: LocalModelConnectionPort;
}

/**
 * 使用真实环回 HTTP 模拟 llama-server；只替代推理进程，不替代本地 Provider 或工具执行链。
 */
export async function startLocalModelServer(
  steps: ProviderScript
): Promise<LocalModelServerFixture> {
  const server = await startProviderServer(steps);
  const connection: LocalModelConnection = Object.freeze({
    generation: 'local-model-fixture-generation',
    baseUrl: server.baseUrl,
    token: server.apiKey,
    modelId: 'ai-pet-local'
  });
  return {
    ...server,
    connectionPort: Object.freeze({
      getReadyConnection: () => connection
    })
  };
}
