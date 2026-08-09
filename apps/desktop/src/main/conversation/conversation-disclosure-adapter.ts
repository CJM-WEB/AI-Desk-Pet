import type { ModelMessage } from '@myself/agent-core';
import type { HistoryDisclosureDecision } from '@myself/shared-types';
import {
  DisclosurePolicy,
  PrivacySessionRegistry,
  type DisclosureRequest
} from '../agent/disclosure-policy';
import type { ConversationHistory } from './conversation-history';

export type ConversationDisclosureResult =
  | { kind: 'ready'; messages: ModelMessage[] }
  | {
      kind: 'confirmation_required';
      requestId: string;
      targetProviderName: string;
      messageCount: number;
      characterCount: number;
    };

interface PendingConversationDisclosure {
  requestId: string;
  targetProfileId: string;
  targetProviderIdentity: string;
  sessionGeneration: string;
  sourceIdentity: string;
  messages: readonly ModelMessage[];
  itemCount: number;
  characterCount: number;
  byteLength: number;
}

interface ConversationDisclosureAdapterOptions {
  sessionId: string;
  privacySessions: PrivacySessionRegistry;
  disclosurePolicy: DisclosurePolicy;
}

export class ConversationDisclosureAdapter {
  private pending: PendingConversationDisclosure | null = null;

  constructor(private readonly options: ConversationDisclosureAdapterOptions) {}

  /** 对当前可见历史取不可变快照，避免确认期间发生 TOCTOU。 */
  prepare(input: {
    requestId: string;
    targetProfileId: string;
    targetProviderIdentity: string;
    targetProviderName: string;
    history: ConversationHistory;
  }): ConversationDisclosureResult {
    this.pending = null;
    const messages = freezeMessages(input.history.modelMessages());
    if (messages.length === 0) return { kind: 'ready', messages: [] };

    const itemCount = input.history.itemCount();
    const characterCount = input.history.characterCount();
    const byteLength = Buffer.byteLength(JSON.stringify(messages), 'utf8');
    const sourceIds = input.history.sourceProviderIdentities();
    const sourceIdentity = sourceIds.size === 1
      ? [...sourceIds][0]!
      : 'conversation:mixed';
    const request = this.createRequest({
      requestId: input.requestId,
      targetProfileId: input.targetProfileId,
      itemCount,
      byteLength
    });

    if (sourceIdentity === input.targetProviderIdentity) {
      const manifest = this.options.disclosurePolicy.createManifestForSource(
        request,
        sourceIdentity
      );
      if (manifest.targetProviderIdentity !== input.targetProviderIdentity) {
        throw new Error('DISCLOSURE_TARGET_MISMATCH');
      }
      return { kind: 'ready', messages: [...messages] };
    }

    const sessionGeneration = this.options.privacySessions.getGenerationForMain(
      this.options.sessionId
    );
    if (sessionGeneration === null) {
      throw new Error('DISCLOSURE_SESSION_UNKNOWN');
    }
    this.pending = {
      requestId: input.requestId,
      targetProfileId: input.targetProfileId,
      targetProviderIdentity: input.targetProviderIdentity,
      sessionGeneration,
      sourceIdentity,
      messages,
      itemCount,
      characterCount,
      byteLength
    };
    return {
      kind: 'confirmation_required',
      requestId: input.requestId,
      targetProviderName: input.targetProviderName,
      messageCount: itemCount,
      characterCount
    };
  }

  resolve(input: {
    requestId: string;
    targetProfileId: string;
    decision: HistoryDisclosureDecision;
  }): ModelMessage[] {
    const pending = this.pending;
    const currentGeneration = this.options.privacySessions.getGenerationForMain(
      this.options.sessionId
    );
    if (
      pending === null
      || pending.requestId !== input.requestId
      || pending.targetProfileId !== input.targetProfileId
      || currentGeneration !== pending.sessionGeneration
    ) {
      throw new Error('DISCLOSURE_REQUEST_EXPIRED');
    }

    if (input.decision === 'current_message_only') {
      this.pending = null;
      return [];
    }
    if (input.decision !== 'share_once') {
      throw new Error('DISCLOSURE_REQUEST_EXPIRED');
    }

    const grantId = this.options.disclosurePolicy.grant({
      scope: 'request',
      requestId: pending.requestId,
      sessionId: this.options.sessionId,
      category: 'conversation',
      targetProfileId: pending.targetProfileId,
      allowCrossProvider: true
    });
    let manifest;
    try {
      manifest = this.options.disclosurePolicy.createManifestForSource(
        this.createRequest(pending),
        pending.sourceIdentity
      );
    } catch (error) {
      // 清单未完成时不保留未消费的单次能力。
      this.options.disclosurePolicy.revoke(grantId);
      throw error;
    }
    if (manifest.targetProviderIdentity !== pending.targetProviderIdentity) {
      throw new Error('DISCLOSURE_TARGET_MISMATCH');
    }

    this.pending = null;
    return [...pending.messages];
  }

  reset(): void {
    // 先使 Adapter pending 失效，即使后续策略清理失败也不能重放历史。
    this.pending = null;
    this.options.disclosurePolicy.revokeAllForSession(this.options.sessionId);
  }

  private createRequest(input: {
    requestId: string;
    targetProfileId: string;
    itemCount: number;
    byteLength: number;
  }): DisclosureRequest {
    return {
      requestId: input.requestId,
      sessionId: this.options.sessionId,
      targetProfileId: input.targetProfileId,
      categories: ['conversation'],
      metadata: {
        conversation: {
          itemCount: input.itemCount,
          byteLength: input.byteLength
        }
      }
    };
  }
}

function freezeMessages(messages: ModelMessage[]): readonly ModelMessage[] {
  return Object.freeze(messages.map(message => Object.freeze({ ...message })));
}
