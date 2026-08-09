import type { ModelMessage } from '@myself/agent-core';

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_CHARACTERS = 16_000;
const SYSTEM_MAX_CHARACTERS = 16_000;

export type VisibleConversationTurn = Readonly<{
  userText: string;
  assistantText: string;
  providerIdentity: string;
}>;

export class ConversationHistory {
  private readonly maxTurns: number;
  private readonly maxCharacters: number;
  private readonly entries: VisibleConversationTurn[] = [];
  private totalCharacters = 0;

  constructor(options: { maxTurns?: number; maxCharacters?: number } = {}) {
    const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
    if (
      !Number.isSafeInteger(maxTurns)
      || maxTurns < 1
      || !Number.isSafeInteger(maxCharacters)
      || maxCharacters < 1
    ) {
      throw new Error('CONVERSATION_HISTORY_OPTIONS_INVALID');
    }
    this.maxTurns = maxTurns;
    this.maxCharacters = Math.min(
      maxCharacters,
      SYSTEM_MAX_CHARACTERS
    );
  }

  append(turn: VisibleConversationTurn): void {
    const entry = this.copyTurn(turn);
    const entryCharacters = characterCount(entry.userText) + characterCount(entry.assistantText);
    if (entryCharacters > this.maxCharacters) {
      throw new Error('CONVERSATION_TURN_TOO_LARGE');
    }

    this.entries.push(entry);
    this.totalCharacters += entryCharacters;
    this.trim();
  }

  turns(): readonly VisibleConversationTurn[] {
    return Object.freeze(this.entries.map(entry => Object.freeze({ ...entry })));
  }

  modelMessages(): ModelMessage[] {
    const messages = this.entries.flatMap(entry => [
      Object.freeze({ role: 'user' as const, content: entry.userText }),
      Object.freeze({ role: 'assistant' as const, content: entry.assistantText })
    ]);
    return Object.freeze(messages) as ModelMessage[];
  }

  itemCount(): number {
    return this.entries.length * 2;
  }

  characterCount(): number {
    return this.totalCharacters;
  }

  sourceProviderIdentities(): ReadonlySet<string> {
    return frozenReadonlySet(this.entries.map(entry => entry.providerIdentity));
  }

  clear(): void {
    this.entries.length = 0;
    this.totalCharacters = 0;
  }

  private copyTurn(turn: VisibleConversationTurn): VisibleConversationTurn {
    if (
      typeof turn.userText !== 'string'
      || typeof turn.assistantText !== 'string'
      || typeof turn.providerIdentity !== 'string'
    ) {
      throw new Error('CONVERSATION_TURN_INVALID');
    }
    return Object.freeze({
      userText: turn.userText,
      assistantText: turn.assistantText,
      providerIdentity: turn.providerIdentity
    });
  }

  /** 按完整的最旧回合裁剪，绝不截断可见正文。 */
  private trim(): void {
    while (this.entries.length > this.maxTurns || this.totalCharacters > this.maxCharacters) {
      const removed = this.entries.shift();
      if (!removed) return;
      this.totalCharacters -= characterCount(removed.userText) + characterCount(removed.assistantText);
    }
  }
}

function characterCount(text: string): number {
  return Array.from(text).length;
}

function frozenReadonlySet(values: Iterable<string>): ReadonlySet<string> {
  const snapshot = new Set(values);
  let readonlySnapshot!: ReadonlySet<string>;
  readonlySnapshot = Object.freeze({
    get size() {
      return snapshot.size;
    },
    has(value: string) {
      return snapshot.has(value);
    },
    entries() {
      return snapshot.entries();
    },
    keys() {
      return snapshot.keys();
    },
    values() {
      return snapshot.values();
    },
    forEach(callback: (value: string, key: string, set: ReadonlySet<string>) => void, thisArg?: unknown) {
      snapshot.forEach(value => callback.call(thisArg, value, value, readonlySnapshot));
    },
    [Symbol.iterator]() {
      return snapshot[Symbol.iterator]();
    }
  });
  return readonlySnapshot;
}
