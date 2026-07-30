import {
  reduceCharacterState,
  type CharacterStateRequest,
  type CharacterStateSnapshot,
  type ExtensionStateId
} from '@myself/character-runtime';
import type { CharacterManifestV1 } from '@myself/character-runtime';

export type ExtensionPointerTrigger =
  | 'single_click'
  | 'double_click'
  | 'context_menu';
export type ExtensionTriggerKind = ExtensionPointerTrigger | 'idle';

export type ExtensionTriggerDefinition = {
  stateId: ExtensionStateId;
  triggers: readonly ExtensionTriggerKind[];
  keywords?: readonly string[];
  emotions?: readonly string[];
};

export type PointerTriggerResult = {
  request: Extract<CharacterStateRequest, { type: 'extension' }> | null;
  openChat: boolean;
};

export function extensionDefinitionsFromManifest(
  manifest: CharacterManifestV1
): ExtensionTriggerDefinition[] {
  return manifest.states.flatMap(state => (
    state.kind === 'extension' && state.triggers
      ? [{
          stateId: state.id,
          triggers: state.triggers.events,
          keywords: state.triggers.keywords,
          emotions: state.triggers.emotions
        }]
      : []
  ));
}

function extensionRequest(
  definition: ExtensionTriggerDefinition | undefined
): Extract<CharacterStateRequest, { type: 'extension' }> | null {
  return definition
    ? { type: 'extension', stateId: definition.stateId }
    : null;
}

/**
 * 触发器只生成状态请求；最终状态始终交给 character-runtime 仲裁器。
 */
export class ExtensionTriggerController {
  private snapshot: CharacterStateSnapshot = {
    stateId: 'idle',
    source: 'system'
  };
  private pendingSingleClickAt: number | null = null;

  constructor(
    private readonly definitions: readonly ExtensionTriggerDefinition[],
    private readonly random: () => number = Math.random,
    private readonly doubleClickWindowMs = 250
  ) {}

  idle(): Extract<CharacterStateRequest, { type: 'extension' }> | null {
    const candidates = this.definitions.filter(item => item.triggers.includes('idle'));
    if (candidates.length === 0) return null;
    const random = this.random();
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
      throw new Error('CHARACTER_EXTENSION_RANDOM_INVALID');
    }
    return extensionRequest(candidates[Math.floor(random * candidates.length)]);
  }

  pointer(
    trigger: ExtensionPointerTrigger
  ): Extract<CharacterStateRequest, { type: 'extension' }> | null {
    return extensionRequest(
      this.definitions.find(item => item.triggers.includes(trigger))
    );
  }

  keyword(text: string): Extract<CharacterStateRequest, { type: 'extension' }> | null {
    const normalized = text.normalize('NFKC').trim().toLocaleLowerCase();
    if (!normalized) return null;
    return extensionRequest(this.definitions.find(item => (
      item.keywords?.some(keyword => keywordMatches(normalized, keyword))
    )));
  }

  emotion(label: string): Extract<CharacterStateRequest, { type: 'extension' }> | null {
    const normalized = label.normalize('NFKC').trim().toLocaleLowerCase();
    return extensionRequest(this.definitions.find(item => (
      item.emotions?.some(emotion => emotion.toLocaleLowerCase() === normalized)
    )));
  }

  llmState(stateId: string): Extract<CharacterStateRequest, { type: 'extension' }> | null {
    return extensionRequest(this.definitions.find(item => item.stateId === stateId));
  }

  reduce(request: CharacterStateRequest): CharacterStateSnapshot {
    this.snapshot = reduceCharacterState(this.snapshot, request);
    return this.snapshot;
  }

  handlePointer(trigger: ExtensionPointerTrigger, timestampMs: number): PointerTriggerResult {
    if (!Number.isFinite(timestampMs) || timestampMs < 0) {
      throw new Error('CHARACTER_EXTENSION_TRIGGER_INVALID');
    }
    if (trigger === 'single_click') {
      this.pendingSingleClickAt = timestampMs;
      return { request: null, openChat: false };
    }
    if (trigger === 'double_click') {
      this.pendingSingleClickAt = null;
      return { request: this.pointer(trigger), openChat: true };
    }
    this.pendingSingleClickAt = null;
    return { request: this.pointer(trigger), openChat: false };
  }

  flushPointer(
    timestampMs: number
  ): Extract<CharacterStateRequest, { type: 'extension' }> | null {
    if (this.pendingSingleClickAt === null) return null;
    if (timestampMs - this.pendingSingleClickAt < this.doubleClickWindowMs) return null;
    this.pendingSingleClickAt = null;
    return this.pointer('single_click');
  }
}

function keywordMatches(text: string, rawKeyword: string): boolean {
  const keyword = rawKeyword.normalize('NFKC').trim().toLocaleLowerCase();
  if (!keyword) return false;
  let offset = text.indexOf(keyword);
  while (offset >= 0) {
    const before = text[offset - 1] ?? '';
    const after = text[offset + keyword.length] ?? '';
    const startsAsciiWord = /^[a-z0-9_]/iu.test(keyword);
    const endsAsciiWord = /[a-z0-9_]$/iu.test(keyword);
    if (
      (!startsAsciiWord || !/[a-z0-9_]/iu.test(before))
      && (!endsAsciiWord || !/[a-z0-9_]/iu.test(after))
    ) {
      return true;
    }
    offset = text.indexOf(keyword, offset + keyword.length);
  }
  return false;
}
