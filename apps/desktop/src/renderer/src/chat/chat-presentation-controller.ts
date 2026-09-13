import {
  ASSISTANT_STREAM_TEXT_MAX_CHARACTERS,
  type TaskEvent
} from '@myself/shared-types';

export type ChatReplyPresentation = Readonly<{ id: string; text: string }>;

export interface ChatReplyPresentationOptions {
  onChange(reply: ChatReplyPresentation | null): void;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

/** 只管理普通回复的展示，不接触任务与会话保存。 */
export class ChatReplyPresentationController {
  private reply: ChatReplyPresentation | null = null;
  private activeTurnId: string | null = null;
  private nextMessageId = 0;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private disposed = false;
  private readonly schedule: typeof globalThis.setTimeout;
  private readonly unschedule: typeof globalThis.clearTimeout;

  constructor(private readonly options: ChatReplyPresentationOptions) {
    this.schedule = options.setTimeout ?? globalThis.setTimeout;
    this.unschedule = options.clearTimeout ?? globalThis.clearTimeout;
  }

  accept(event: TaskEvent): void {
    if (this.disposed) return;
    if (event.type === 'conversation_reset') {
      this.clearReply();
    } else if (event.type === 'assistant_message_start') {
      this.clearTimer();
      this.activeTurnId = event.turnId;
      this.display({ id: `assistant-stream-${event.turnId}`, text: '' });
    } else if (event.type === 'assistant_message_delta' || event.type === 'assistant_message_commit') {
      if (event.turnId !== this.activeTurnId || this.reply === null) return;
      const text = event.type === 'assistant_message_delta' ? this.reply.text + event.delta : event.text;
      // 仅退役与原正文归并同时失效的未完成流，不裁剪普通正式消息。
      if (Array.from(text).length > ASSISTANT_STREAM_TEXT_MAX_CHARACTERS) {
        this.clearReply();
        return;
      }
      const committed = event.type === 'assistant_message_commit';
      if (committed) this.activeTurnId = null;
      this.display({ id: this.reply.id, text }, committed);
    } else if (event.type === 'message' && event.role === 'assistant') {
      this.clearTimer();
      this.activeTurnId = null;
      this.display({ id: `assistant-message-${++this.nextMessageId}`, text: event.text }, true);
    } else if (this.activeTurnId !== null && (event.type === 'error'
      || (event.type === 'phase' && ['thinking', 'idle', 'success', 'error', 'cancelled'].includes(event.phase)))) {
      this.clearReply();
    }
  }

  dismiss(id: string): void {
    if (!this.disposed && this.reply?.id === id) this.clearReply();
  }

  snapshot(): ChatReplyPresentation | null { return this.reply; }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.activeTurnId = null;
    this.reply = null;
  }

  private display(reply: ChatReplyPresentation, committed = false): void {
    this.reply = Object.freeze(reply);
    if (committed) {
      // 定时器只拥有创建时的这一份气泡，旧回调不得清掉后来替换的回复。
      const schedule = this.schedule;
      this.timer = schedule(() => {
        if (!this.disposed && this.reply === reply) this.clearReply();
      }, 30_000);
    }
    this.options.onChange(reply);
  }

  private clearReply(): void {
    this.clearTimer();
    // 撤销流身份后，同一条被关闭或退役的增量、提交都不能再次展示。
    this.activeTurnId = null;
    if (this.reply === null) return;
    this.reply = null;
    this.options.onChange(null);
  }

  private clearTimer(): void {
    const unschedule = this.unschedule;
    if (this.timer !== null) unschedule(this.timer);
    this.timer = null;
  }
}
