import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import type { ModelProvider } from '@myself/agent-core';
import type { ProviderProfile, PublicSettings } from '@myself/shared-types';

interface SettingsActionsStore {
  getPublic(): Promise<PublicSettings>;
  saveAuthorizedRoot(input: {
    id: string;
    displayName: string;
    pathHint: string;
    absolutePath: string;
  }): Promise<void>;
}

export interface SettingsActionsOptions {
  settings: SettingsActionsStore;
  readSecret(): Promise<string>;
  createProvider(profile: ProviderProfile, readSecret: () => Promise<string>): ModelProvider;
  selectDirectory(): Promise<string | null>;
  createRootId?: () => string;
}

function connectionFailureMessage(error: unknown): string {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  const messages: Record<string, string> = {
    PROVIDER_AUTHENTICATION_FAILED: '身份认证失败，请检查 API Key。',
    PROVIDER_ENDPOINT_NOT_FOUND: '模型服务地址或接口路径不可用。',
    PROVIDER_RATE_LIMITED: '模型服务当前繁忙，请稍后重试。',
    PROVIDER_SERVER_ERROR: '模型服务暂时异常，请稍后重试。',
    PROVIDER_TIMEOUT: '连接测试超时，请检查网络和服务地址。',
    PROVIDER_NETWORK_ERROR: '无法连接模型服务，请检查网络和服务地址。',
    PROVIDER_MALFORMED_RESPONSE: '模型服务响应格式不兼容。'
  };
  return typeof code === 'string' && messages[code]
    ? messages[code]
    : '连接测试失败，请检查配置后重试。';
}

function publicPathHint(absolutePath: string): string {
  const root = win32.parse(absolutePath).root;
  const displayName = win32.basename(absolutePath);
  return `${root}…\\${displayName}`;
}

export function createSettingsActions(options: SettingsActionsOptions) {
  const createRootId = options.createRootId ?? randomUUID;
  return {
    async testProvider(): Promise<{ ok: boolean; message: string }> {
      const settings = await options.settings.getPublic();
      if (!settings.provider || !settings.provider.hasStoredSecret) {
        return { ok: false, message: '请先保存模型配置和 API Key。' };
      }
      try {
        const provider = options.createProvider(settings.provider, options.readSecret);
        const response = await provider.respond({
          messages: [
            { role: 'system', content: '这是一次连接测试，只需返回简短文本。' },
            { role: 'user', content: '请回复“连接成功”。' }
          ],
          tools: []
        }, AbortSignal.timeout(15_000));
        if (response.type !== 'text') {
          return { ok: false, message: '模型服务未返回文本，当前响应格式不兼容。' };
        }
        return { ok: true, message: '连接成功。' };
      } catch (error) {
        return { ok: false, message: connectionFailureMessage(error) };
      }
    },

    async chooseAuthorizedRoot(): Promise<void> {
      const absolutePath = await options.selectDirectory();
      if (!absolutePath) return;
      await options.settings.saveAuthorizedRoot({
        id: createRootId(),
        displayName: win32.basename(absolutePath),
        pathHint: publicPathHint(absolutePath),
        absolutePath
      });
    }
  };
}
