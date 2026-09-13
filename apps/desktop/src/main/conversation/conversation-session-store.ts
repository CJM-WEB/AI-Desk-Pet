import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { TaskEvent } from '@myself/shared-types';
import {
  committedConversationTranscript,
  conversationTranscriptSnapshotSchema,
  emptyConversationTranscript,
  reduceConversationTranscript,
  type ConversationTranscriptSnapshot
} from '../../shared/conversation-transcript';
import { atomicWriteText, enqueueFileOperation } from '../storage/atomic-file-coordinator';
import type { SecretEncryptionAdapter } from '../storage/secret-store';
import { ConversationHistory } from './conversation-history';

const storedConversationSchema = z.object({
  version: z.literal(1),
  modelIdentity: z.string().min(1),
  transcript: conversationTranscriptSnapshotSchema.refine(value => value.activeAssistantStreamTurnId === null && value.persistenceError === undefined),
  history: z.array(z.object({
    userText: z.string(), assistantText: z.string(), providerIdentity: z.string()
  }).strict()).max(20)
}).strict();
const encryptedConversationSchema = z.object({
  version: z.literal(1),
  encrypted: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/u)
}).strict();

export type ConversationPersistenceErrorCode = 'CONVERSATION_LOAD_FAILED' | 'CONVERSATION_SAVE_FAILED';

/** 当前会话文字独立持久化；授权、运行代次及任务状态永不进入本文件。 */
export class ConversationSessionStore {
  readonly history: ConversationHistory;
  private transcript = emptyConversationTranscript();
  private modelIdentity = '';
  private initialized = false;
  private incognito = false;
  private transientConversation = false;
  private suppressHistoryChange = false;
  private loadBlocked = false;
  private lastFailure: ConversationPersistenceErrorCode | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly encryption: SecretEncryptionAdapter,
    private readonly options: { onPersistenceChanged?(code: ConversationPersistenceErrorCode | null): void } = {}
  ) {
    this.history = new ConversationHistory({ onChange: () => {
      if (!this.suppressHistoryChange) this.scheduleSave();
    } });
  }

  async initialize(modelIdentity: string): Promise<void> {
    if (this.initialized) return;
    this.modelIdentity = z.string().min(1).parse(modelIdentity);
    try {
      const stored = await enqueueFileOperation(this.file, async () => {
        let raw: string;
        try { raw = await readFile(this.file, 'utf8'); }
        catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
          throw error;
        }
        const envelope = encryptedConversationSchema.parse(JSON.parse(raw));
        if (!this.encryption.isEncryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE');
        const plaintext = await this.encryption.decryptString(Buffer.from(envelope.encrypted, 'base64'));
        return storedConversationSchema.parse(JSON.parse(plaintext));
      });
      if (stored && stored.modelIdentity === modelIdentity) {
        this.suppressHistoryChange = true;
        try { this.history.restore(stored.history); }
        finally { this.suppressHistoryChange = false; }
        this.transcript = stored.transcript;
      }
    } catch {
      this.loadBlocked = true;
      this.updatePersistenceStatus('CONVERSATION_LOAD_FAILED');
    } finally {
      this.initialized = true;
    }
  }

  snapshot(): ConversationTranscriptSnapshot {
    return { ...structuredClone(this.transcript), ...(this.lastFailure ? { persistenceError: this.lastFailure } : {}) };
  }

  observe(event: TaskEvent): void {
    if (event.type === 'conversation_reset' && event.preserveMessages !== true) {
      this.clearConversation(this.modelIdentity);
      return;
    }
    const previous = this.transcript;
    this.transcript = reduceConversationTranscript(previous, event);
    // 增量只服务当前窗口，直到提交才写磁盘；其余不改变正式正文的事件也不触发写入。
    if (previous !== this.transcript && event.type !== 'assistant_message_start' && event.type !== 'assistant_message_delta') {
      this.scheduleSave();
    }
  }

  setIncognito(value: boolean): void {
    this.incognito = value;
    if (value) this.transientConversation = true;
  }

  async reset(modelIdentity: string): Promise<void> {
    this.clearConversation(modelIdentity);
    await this.flush();
  }

  async flush(): Promise<void> {
    await this.pendingWrite;
    if (this.lastFailure) throw new Error(this.lastFailure);
  }

  private clearConversation(modelIdentity: string): void {
    this.modelIdentity = z.string().min(1).parse(modelIdentity);
    this.transcript = emptyConversationTranscript();
    this.suppressHistoryChange = true;
    try { this.history.clear(); }
    finally { this.suppressHistoryChange = false; }
    this.transientConversation = this.incognito;
    this.loadBlocked = false;
    // 用户明确清除也作用于无痕之前的普通磁盘快照。
    this.scheduleSave(true);
  }

  private scheduleSave(forceEmpty = false): void {
    if (!this.initialized || this.loadBlocked || this.transientConversation && !forceEmpty) return;
    const stored = {
      version: 1 as const,
      modelIdentity: this.modelIdentity,
      transcript: committedConversationTranscript(this.transcript),
      history: this.history.turns()
    };
    // 接纳时截取纯数据；排队中的普通快照不得掺入后来开启无痕后的文字。
    const plaintext = JSON.stringify(stored);
    // 入队前的路径解析也可能同步失败；串到已接纳写入后统一转为安全失败，不能打断聊天。
    const write = this.pendingWrite.then(() => enqueueFileOperation(this.file, async () => {
      if (!this.encryption.isEncryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE');
      const encrypted = await this.encryption.encryptString(plaintext);
      await atomicWriteText(this.file, `${JSON.stringify({ version: 1, encrypted: encrypted.toString('base64') })}\n`);
    }));
    this.pendingWrite = write.then(() => {
      if (!this.loadBlocked) this.updatePersistenceStatus(null);
    }, () => { this.updatePersistenceStatus('CONVERSATION_SAVE_FAILED'); });
  }

  private updatePersistenceStatus(code: ConversationPersistenceErrorCode | null): void {
    const changed = this.lastFailure !== code;
    this.lastFailure = code;
    // 失败仍须重新呈现被新对话清空的提示；只有真实写入成功才清错，正常重复成功不通知。
    if (code !== null || changed) {
      try { this.options.onPersistenceChanged?.(code); }
      catch { /* 提示失败不能中断基础聊天。 */ }
    }
  }
}
