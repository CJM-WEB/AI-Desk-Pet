import type { TaskEvent } from '@myself/shared-types';
import { taskEventSchema } from '@myself/shared-types';
import type { WebContents } from 'electron';
import { ipcChannels } from '../../shared/ipc-channels';

type TaskEventTarget = Pick<WebContents, 'isDestroyed' | 'send'>;

type ConversationEventProjectionOptions = Readonly<{
  getChatTarget(): TaskEventTarget | null;
  getPetTarget(): TaskEventTarget | null;
  applyCharacterBehavior(event: TaskEvent): void;
  reportDeliveryFailure?(target: 'chat' | 'pet'): void;
}>;

/**
 * 无状态地将已验证的会话事件投影到最小窗口视图。
 *
 * 先解析以保证无效输入不产生副作用；Main 保持完整事件，chat 接收完整事件，
 * pet 仅接收 phase。每个窗口的投递失败彼此隔离，不缓存、不重试也不重放。
 */
export class ConversationEventProjection {
  constructor(private readonly options: ConversationEventProjectionOptions) {}

  publish(rawEvent: unknown): TaskEvent {
    const event = taskEventSchema.parse(rawEvent);

    this.options.applyCharacterBehavior(event);
    this.send('chat', this.options.getChatTarget(), event);
    if (event.type === 'phase') {
      this.send('pet', this.options.getPetTarget(), {
        type: 'phase',
        phase: event.phase
      });
    }

    return event;
  }

  private send(
    targetName: 'chat' | 'pet',
    target: TaskEventTarget | null,
    event: TaskEvent
  ): void {
    if (!target || target.isDestroyed()) return;

    try {
      target.send(ipcChannels.taskEvent, event);
    } catch {
      this.options.reportDeliveryFailure?.(targetName);
    }
  }
}
