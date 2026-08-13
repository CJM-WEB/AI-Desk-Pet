import type { DisclosureManifest, DisclosureRequest } from '../src/main/agent/disclosure-policy';
import {
  DisclosurePolicy,
  PrivacySessionRegistry
} from '../src/main/agent/disclosure-policy';
import {
  ConversationDisclosureAdapter
} from '../src/main/conversation/conversation-disclosure-adapter';
import { ConversationHistory } from '../src/main/conversation/conversation-history';
import { describe, expect, test } from 'vitest';

class CapturingDisclosurePolicy extends DisclosurePolicy {
  lastManifest: DisclosureManifest | null = null;

  override createManifestForSource(
    request: DisclosureRequest,
    sourceProviderIdentity: string
  ): DisclosureManifest {
    const manifest = super.createManifestForSource(request, sourceProviderIdentity);
    this.lastManifest = manifest;
    return manifest;
  }
}

function createHarness(options: { incognito?: boolean } = {}) {
  const privacySessions = new PrivacySessionRegistry();
  privacySessions.register('session-1', {
    incognito: options.incognito ?? false
  });
  const profiles = new Map([
    ['profile-openai', 'openai'],
    ['profile-anthropic', 'anthropic']
  ]);
  const disclosurePolicy = new CapturingDisclosurePolicy({
    privacySessions,
    resolveProfileProvider: profileId => profiles.get(profileId) ?? null,
    resolveCurrentSourceProvider: () => null
  });
  const adapter = new ConversationDisclosureAdapter({
    sessionId: 'session-1',
    privacySessions,
    disclosurePolicy
  });
  return { adapter, disclosurePolicy, privacySessions };
}

function history(...turns: Array<{
  userText: string;
  assistantText: string;
  providerIdentity: string;
}>): ConversationHistory {
  const conversationHistory = new ConversationHistory();
  for (const turn of turns) conversationHistory.append(turn);
  return conversationHistory;
}

function prepareInput(
  conversationHistory: ConversationHistory,
  overrides: Partial<Parameters<ConversationDisclosureAdapter['prepare']>[0]> = {}
) {
  return {
    requestId: 'request-1',
    targetProfileId: 'profile-anthropic',
    targetProviderIdentity: 'anthropic',
    targetProviderName: 'Anthropic',
    history: conversationHistory,
    ...overrides
  };
}

function expectErrorCode(operation: () => unknown, code = 'DISCLOSURE_REQUEST_EXPIRED'): void {
  expect(operation).toThrowError(code);
}

describe('ConversationDisclosureAdapter', () => {
  test('空历史不生成确认且直接返回空消息', () => {
    const { adapter } = createHarness();

    expect(adapter.prepare(prepareInput(history()))).toEqual({
      kind: 'ready',
      messages: []
    });
  });

  test('唯一来源与目标 Provider 一致时经可信策略校验后直接返回', () => {
    const { adapter } = createHarness();
    const conversationHistory = history({
      userText: '你好',
      assistantText: '嗨',
      providerIdentity: 'openai'
    });

    expect(adapter.prepare(prepareInput(conversationHistory, {
      targetProfileId: 'profile-openai',
      targetProviderIdentity: 'openai',
      targetProviderName: 'OpenAI'
    }))).toEqual({
      kind: 'ready',
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '嗨' }
      ]
    });
  });

  test('伪造目标 Provider 身份不能把实际跨 Provider 历史当作同源', () => {
    const { adapter } = createHarness();
    const conversationHistory = history({
      userText: '不得泄露',
      assistantText: '不得泄露',
      providerIdentity: 'openai'
    });

    expectErrorCode(() => adapter.prepare(prepareInput(conversationHistory, {
      targetProviderIdentity: 'openai'
    })), 'DISCLOSURE_CROSS_PROVIDER_NOT_AUTHORIZED');
  });

  test('混合来源即使包含目标 Provider 也只返回 Unicode 数量摘要', () => {
    const { adapter } = createHarness();
    const conversationHistory = history(
      {
        userText: '你🐾',
        assistantText: '好',
        providerIdentity: 'openai'
      },
      {
        userText: '再',
        assistantText: '行🐾',
        providerIdentity: 'anthropic'
      }
    );

    const result = adapter.prepare(prepareInput(conversationHistory));

    expect(result).toEqual({
      kind: 'confirmation_required',
      requestId: 'request-1',
      targetProviderName: 'Anthropic',
      messageCount: 4,
      characterCount: 6
    });
    expect(JSON.stringify(result)).not.toContain('你🐾');
    expect(JSON.stringify(result)).not.toContain('行🐾');
  });

  test('share_once 只披露 prepare 时快照并用 UTF-8 字节长度构造清单', () => {
    const { adapter, disclosurePolicy } = createHarness();
    const conversationHistory = history({
      userText: '🐾',
      assistantText: '你',
      providerIdentity: 'openai'
    });
    expect(adapter.prepare(prepareInput(conversationHistory))).toMatchObject({
      kind: 'confirmation_required',
      messageCount: 2,
      characterCount: 2
    });
    conversationHistory.append({
      userText: '后加用户消息',
      assistantText: '后加助手消息',
      providerIdentity: 'openai'
    });

    expect(adapter.resolve({
      requestId: 'request-1',
      targetProfileId: 'profile-anthropic',
      decision: 'share_once'
    })).toEqual([
      { role: 'user', content: '🐾' },
      { role: 'assistant', content: '你' }
    ]);
    expect(disclosurePolicy.lastManifest?.metadata).toEqual([{
      category: 'conversation',
      itemCount: 2,
      byteLength: 71
    }]);
    expectErrorCode(() => adapter.resolve({
      requestId: 'request-1',
      targetProfileId: 'profile-anthropic',
      decision: 'share_once'
    }));
  });

  test('current_message_only 消费 pending 并以空历史继续', () => {
    const { adapter } = createHarness();
    adapter.prepare(prepareInput(history({
      userText: 'u',
      assistantText: 'a',
      providerIdentity: 'openai'
    })));

    expect(adapter.resolve({
      requestId: 'request-1',
      targetProfileId: 'profile-anthropic',
      decision: 'current_message_only'
    })).toEqual([]);
    expectErrorCode(() => adapter.resolve({
      requestId: 'request-1',
      targetProfileId: 'profile-anthropic',
      decision: 'current_message_only'
    }));
  });

  test('伪造 requestId 或 profileId 均拒绝且不误消费真实 pending', () => {
    const { adapter } = createHarness();
    adapter.prepare(prepareInput(history({
      userText: 'u',
      assistantText: 'a',
      providerIdentity: 'openai'
    })));

    expectErrorCode(() => adapter.resolve({
      requestId: 'forged-request',
      targetProfileId: 'profile-anthropic',
      decision: 'share_once'
    }));
    expectErrorCode(() => adapter.resolve({
      requestId: 'request-1',
      targetProfileId: 'profile-openai',
      decision: 'share_once'
    }));
    expect(adapter.resolve({
      requestId: 'request-1',
      targetProfileId: 'profile-anthropic',
      decision: 'current_message_only'
    })).toEqual([]);
  });

  test('会话 generation 变更后拒绝旧 pending 且不返回历史', () => {
    const { adapter, privacySessions } = createHarness();
    adapter.prepare(prepareInput(history({
      userText: '旧用户消息',
      assistantText: '旧助手消息',
      providerIdentity: 'openai'
    })));
    privacySessions.register('session-1', { incognito: false });

    expectErrorCode(() => adapter.resolve({
      requestId: 'request-1',
      targetProfileId: 'profile-anthropic',
      decision: 'share_once'
    }));
  });

  test('后续 prepare 即使直接 ready 也使旧披露确认失效', () => {
    const { adapter } = createHarness();
    adapter.prepare(prepareInput(history({
      userText: '旧用户消息',
      assistantText: '旧助手消息',
      providerIdentity: 'openai'
    })));

    expect(adapter.prepare(prepareInput(history(), {
      requestId: 'request-2'
    }))).toEqual({ kind: 'ready', messages: [] });
    expectErrorCode(() => adapter.resolve({
      requestId: 'request-1',
      targetProfileId: 'profile-anthropic',
      decision: 'share_once'
    }));
  });

  test('reset 清除 pending 并撤销会话内已有披露 grant', () => {
    const { adapter, disclosurePolicy } = createHarness();
    disclosurePolicy.grant({
      scope: 'session',
      sessionId: 'session-1',
      category: 'file',
      targetProfileId: 'profile-openai',
      allowCrossProvider: false
    });
    adapter.prepare(prepareInput(history({
      userText: 'u',
      assistantText: 'a',
      providerIdentity: 'openai'
    })));

    adapter.reset();

    expectErrorCode(() => adapter.resolve({
      requestId: 'request-1',
      targetProfileId: 'profile-anthropic',
      decision: 'share_once'
    }));
    expectErrorCode(() => disclosurePolicy.createManifestForSource({
      requestId: 'file-request',
      sessionId: 'session-1',
      targetProfileId: 'profile-openai',
      categories: ['file'],
      metadata: { file: { itemCount: 1, byteLength: 1 } }
    }, 'openai'), 'DISCLOSURE_CATEGORY_NOT_AUTHORIZED');
  });

  test('无痕会话不降低跨 Provider 披露要求', () => {
    const { adapter } = createHarness({ incognito: true });

    expect(adapter.prepare(prepareInput(history({
      userText: 'u',
      assistantText: 'a',
      providerIdentity: 'openai'
    })))).toMatchObject({ kind: 'confirmation_required' });
  });
});
