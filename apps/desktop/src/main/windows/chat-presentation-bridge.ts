import type { IpcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  chatPresentationChannels,
  chatPresentationCommandSchema,
  chatPresentationIntentSchema,
  chatPresentationLayoutSchema,
  chatPresentationSnapshotSchema,
  parseChatPresentation,
  type ChatPresentationCommand,
  type ChatPresentationLayout,
  type ChatPresentationReadyResult,
  type ChatPresentationSnapshot
} from '../../shared/chat-presentation';

/** 注入当前 WebContents 对象本身；数值 id 相同不能继承旧窗口权限。 */
export interface ChatPresentationWebContents {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

export interface ChatPresentationBridgeOptions {
  getChat(): ChatPresentationWebContents | null;
  getBubble(): ChatPresentationWebContents | null;
  onLayout?(layout: ChatPresentationLayout): void;
  onReady?(surface: ChatPresentationLayout['surface']): void;
}

/** Main 只转交当前展示与点击，不调用授权、文件、模型或会话业务。 */
export class ChatPresentationBridge {
  private chat: ChatPresentationWebContents | null = null;
  private bubble: ChatPresentationWebContents | null = null;
  private bubbleReady = false;
  private snapshot: ChatPresentationSnapshot | null = null;
  private epoch = randomUUID();
  private revisionFloor = 0;
  private decidedRevision: number | null = null;
  private disposed = false;

  constructor(private readonly options: ChatPresentationBridgeOptions) {}

  publish(sender: ChatPresentationWebContents, value: unknown): void {
    this.syncWindows();
    this.assertSender(sender, this.chat);
    const snapshot = parseChatPresentation(chatPresentationSnapshotSchema, value);
    if (snapshot.epoch !== this.epoch || snapshot.revision <= this.revisionFloor) throw new Error('CHAT_PRESENTATION_STALE');
    this.snapshot = snapshot;
    this.revisionFloor = snapshot.revision;
    this.decidedRevision = null;
    if (this.bubbleReady) this.deliverSnapshot();
  }

  dispatch(sender: ChatPresentationWebContents, value: unknown): void {
    this.syncWindows();
    this.assertSender(sender, this.bubble);
    const intent = parseChatPresentation(chatPresentationIntentSchema, value);
    const snapshot = this.snapshot;
    if (!this.bubbleReady || !snapshot || intent.epoch !== this.epoch || intent.revision !== snapshot.revision
      || intent.conversationRevision !== snapshot.conversationRevision) throw new Error('CHAT_PRESENTATION_STALE');
    const target = intent.action === 'dismiss-reply' ? snapshot.reply : snapshot.confirmation;
    if (!target || target.id !== intent.targetId) throw new Error('CHAT_PRESENTATION_STALE');
    const decision = intent.action === 'confirm' || intent.action === 'reject';
    if (decision && (snapshot.confirmation!.busy || this.decidedRevision === snapshot.revision)) {
      throw new Error('CHAT_PRESENTATION_STALE');
    }
    if (decision) this.decidedRevision = snapshot.revision;
    this.send(this.chat, chatPresentationChannels.intent, intent);
  }

  setLayout(sender: ChatPresentationWebContents, value: unknown): void {
    this.syncWindows();
    const layout = parseChatPresentation(chatPresentationLayoutSchema, value);
    this.assertSender(sender, layout.surface === 'island' ? this.chat : this.bubble);
    try { this.options.onLayout?.(layout); }
    catch { throw new Error('CHAT_PRESENTATION_UNAVAILABLE'); }
  }

  ready(sender: ChatPresentationWebContents): ChatPresentationReadyResult {
    this.syncWindows();
    if (sender === this.chat) {
      this.assertSender(sender, this.chat);
      this.send(this.chat, chatPresentationChannels.command, { type: 'availability', available: this.bubbleReady });
    } else {
      this.assertSender(sender, this.bubble);
      this.bubbleReady = true;
      this.deliverSnapshot();
      this.notifyAvailability(true);
    }
    try { this.options.onReady?.(sender === this.chat ? 'island' : 'bubble'); }
    catch {
      if (sender === this.bubble) this.invalidateBubble();
      throw new Error('CHAT_PRESENTATION_UNAVAILABLE');
    }
    return { epoch: this.epoch, revisionFloor: this.revisionFloor };
  }

  sendCommand(value: ChatPresentationCommand, surface: 'island' | 'bubble' = 'island'): void {
    this.syncWindows();
    this.send(surface === 'bubble' ? this.bubble : this.chat, chatPresentationChannels.command, parseChatPresentation(chatPresentationCommandSchema, value));
  }

  /** 原生故障撤销旧展示代次；chat 只可用新代次重发原来仍有效的确认。 */
  invalidateBubble(): void {
    if (this.disposed) return;
    this.syncWindows();
    this.bubbleReady = false;
    this.snapshot = null;
    this.decidedRevision = null;
    this.epoch = randomUUID();
    this.notifyAvailability(false);
    try { this.send(this.bubble, chatPresentationChannels.snapshot, null); }
    catch { /* 原生窗口已不可用，清理发送失败不阻塞 chat 回退。 */ }
    this.notifyReset(true);
  }

  /** 新代次撤销尚在 IPC 队列中的旧发布；水位还防止当前代次内重用旧修订。 */
  clear(): void {
    this.syncWindows();
    this.snapshot = null;
    this.decidedRevision = null;
    this.epoch = randomUUID();
    try { if (this.bubbleReady) this.deliverSnapshot(); }
    finally { this.notifyReset(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.snapshot = null;
    this.decidedRevision = null;
    if (this.bubbleReady) {
      try { this.deliverSnapshot(); } catch { /* 销毁时不把展示失败传播到应用清理。 */ }
    }
    this.notifyAvailability(false);
    this.bubbleReady = false;
    this.chat = null;
    this.bubble = null;
    this.disposed = true;
  }

  private syncWindows(): void {
    if (this.disposed) throw new Error('CHAT_PRESENTATION_DISPOSED');
    const candidateChat = this.options.getChat();
    const candidateBubble = this.options.getBubble();
    const chat = candidateChat && !candidateChat.isDestroyed() ? candidateChat : null;
    const bubble = candidateBubble && !candidateBubble.isDestroyed() ? candidateBubble : null;
    const chatChanged = chat !== this.chat;
    const bubbleChanged = bubble !== this.bubble;
    if (chatChanged) {
      this.snapshot = null;
      this.decidedRevision = null;
      this.epoch = randomUUID();
      this.chat = chat;
    }
    if (bubbleChanged) {
      this.bubbleReady = false;
      this.bubble = bubble;
      this.notifyAvailability(false);
    }
    if (chatChanged && this.bubbleReady) {
      try { this.deliverSnapshot(); } catch { /* 来源轮换必须继续撤销旧点击。 */ }
    }
    if (chatChanged) this.notifyReset();
  }

  private assertSender(sender: ChatPresentationWebContents, expected: ChatPresentationWebContents | null): void {
    if (!expected || sender !== expected || sender.isDestroyed()) throw new Error('CHAT_PRESENTATION_SENDER_INVALID');
  }

  private deliverSnapshot(): void {
    try { this.send(this.bubble, chatPresentationChannels.snapshot, this.snapshot); }
    catch {
      this.bubbleReady = false;
      this.notifyAvailability(false);
      throw new Error('CHAT_PRESENTATION_UNAVAILABLE');
    }
  }

  private notifyAvailability(available: boolean): void {
    if (!this.chat || this.chat.isDestroyed()) return;
    try { this.send(this.chat, chatPresentationChannels.command, { type: 'availability', available }); }
    catch { /* chat 不可达时只保留不可用事实，不记录正文或重放操作。 */ }
  }

  private notifyReset(preserveConfirmation = false): void {
    if (!this.chat || this.chat.isDestroyed()) return;
    try {
      this.send(this.chat, chatPresentationChannels.command, { type: 'reset', epoch: this.epoch, revisionFloor: this.revisionFloor,
        ...(preserveConfirmation ? { preserveConfirmation: true } : {}) });
    } catch { /* 重建中的 chat 可通过 ready 取得当前代次，不重试旧展示。 */ }
  }

  private send(target: ChatPresentationWebContents | null, channel: string, value: unknown): void {
    try {
      if (!target || target.isDestroyed()) throw new Error();
      target.send(channel, value);
    } catch { throw new Error('CHAT_PRESENTATION_UNAVAILABLE'); }
  }
}

/** 展示通道独立注册；不扩展任何原业务 IPC 的 sender 白名单。 */
export function registerChatPresentationIpc(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>, bridge: ChatPresentationBridge): () => void {
  const handlers = [
    [chatPresentationChannels.publish, 1, (sender: ChatPresentationWebContents, value: unknown) => bridge.publish(sender, value)],
    [chatPresentationChannels.dispatch, 1, (sender: ChatPresentationWebContents, value: unknown) => bridge.dispatch(sender, value)],
    [chatPresentationChannels.layout, 1, (sender: ChatPresentationWebContents, value: unknown) => bridge.setLayout(sender, value)],
    [chatPresentationChannels.ready, 0, (sender: ChatPresentationWebContents) => bridge.ready(sender)]
  ] as const;
  for (const [channel, count, handle] of handlers) {
    ipc.handle(channel, (event, ...args: unknown[]) => {
      if (args.length !== count) throw new Error('CHAT_PRESENTATION_PAYLOAD_INVALID');
      return handle(event.sender, args[0]);
    });
  }
  return () => { for (const [channel] of handlers) ipc.removeHandler(channel); };
}
