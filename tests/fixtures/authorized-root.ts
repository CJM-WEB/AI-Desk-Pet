import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskEvent, ProviderProfileV2 } from '@myself/shared-types';
import { PrivacySessionRegistry } from '../../apps/desktop/src/main/agent/disclosure-policy';
import { CodingTaskService } from '../../apps/desktop/src/main/agent/coding-task-service';
import { createMainConversationComposition } from '../../apps/desktop/src/main/conversation/main-conversation-composition';
import { ConversationChatAdapter } from '../../apps/desktop/src/main/conversation/conversation-chat-adapter';
import { createCodingModelConnection } from '../../apps/desktop/src/main/providers/coding-model-connection';
import { OpenAICompatibleProvider } from '../../apps/desktop/src/main/providers/openai-provider';
import { resolveCodingTaskResources } from '../../apps/desktop/src/main/agent/coding-task-resources';
import { startProviderServer, type ProviderScript } from './provider-server';

export interface AuthorizedRootFixture {
  base: string;
  root: string;
  cleanup(): Promise<void>;
}

/** 只替换模型 HTTP 和宿主回收站端口；范围、许可、runner、文件与命令均走正式组合。 */
export async function createCodingConversation(steps: ProviderScript, options: {
  trashFile?: (path: string) => Promise<void>;
} = {}) {
  const authorized = await createAuthorizedRoot();
  const provider = await startProviderServer(steps);
  const resources = await resolveCodingTaskResources({ isPackaged: false, resourcesPath: '', appPath: fileURLToPath(new URL('../../apps/desktop', import.meta.url)) });
  const profile: ProviderProfileV2 = { id: 'coding-fixture', displayName: '正式链夹具', modelId: 'coding-fixture-model', hasStoredSecret: true, mode: 'custom', protocol: 'openai-compatible', baseUrl: provider.baseUrl, additionalParameters: {}, capabilities: ['chat', 'tools'] };
  const privacySessions = new PrivacySessionRegistry();
  privacySessions.register('coding-fixture', { incognito: false });
  const events: TaskEvent[] = [];
  let creates = 0;
  const composition = createMainConversationComposition({
    catalog: [], privacySessions, sessionId: 'coding-fixture',
    readProviderSettings: async () => ({ profiles: [profile], route: { primaryProfileId: profile.id, chatProfileId: profile.id, agentProfileId: profile.id, visionProfileId: null, fallbackProfileIds: [], allowCrossProviderFallback: false } }),
    readAuthorizedRootPath: async () => authorized.root,
    readPrivacySettings: async () => ({ dataCategories: { memory: false } }),
    createChatAdapter: () => new ConversationChatAdapter(new OpenAICompatibleProvider({ id: profile.id, displayName: profile.displayName, baseUrl: provider.baseUrl, model: profile.modelId, hasStoredSecret: true }, async () => provider.apiKey)),
    createCodingTaskService: input => {
      creates += 1;
      return new CodingTaskService({
        sessionOptions: async () => ({ ...resources, directory: input.snapshot.authorizedRootPath, dataDirectory: authorized.base, approvedCommands: input.snapshot.approvedCommands,
          model: createCodingModelConnection(input.primaryProfile, { catalog: [], readSecret: async () => provider.apiKey }),
          ...(options.trashFile ? { trashFile: options.trashFile } : {}) }),
        emit: input.emit, emitTrustedToolResult: input.emitTrustedToolResult
      });
    },
    behavior: {
      prepareUserPrompt: async text => ({ originalText: text, capabilityText: text, explicitDirective: null }),
      getChatContext: () => ({ character: { identity: { name: '测试角色', description: '测试', background: '测试', traits: [], languageStyle: '简洁', likes: [], behavioralTendencies: [] }, states: [] }, runtime: { moving: false, dragging: false, carrying: false, movementMode: 2 }, proactivityMode: 'passive', recentActions: [] }),
      completeUserPrompt: () => undefined, handleTaskEvent: () => undefined, applyPlaybackFeedback: () => undefined, cancelActive: () => undefined, reset: () => undefined, close: async () => undefined
    },
    emit: event => events.push(event)
  });
  return { authorized, provider, profile, events, composition, creates: () => creates,
    async authorize(text: string) {
      await composition.coordinator.submit(text);
      const scope = events.findLast(event => event.type === 'capability_authorization_required');
      if (scope?.type !== 'capability_authorization_required') throw new Error('缺少范围授权');
      await composition.coordinator.resolveCapabilityAuthorization(scope.requestId, 'confirm');
      return scope;
    },
    async close() {
      await composition.close();
      await provider.close();
      await authorized.cleanup();
    }
  };
}

export async function createAuthorizedRoot(): Promise<AuthorizedRootFixture> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'myself-task-9a-')));
  const root = join(base, 'authorized');
  await mkdir(join(root, 'docs'), { recursive: true });
  return {
    base,
    root,
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    }
  };
}
