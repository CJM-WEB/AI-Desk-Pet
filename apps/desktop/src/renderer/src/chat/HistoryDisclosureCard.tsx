import type { HistoryDisclosureDecision } from '@myself/shared-types';
import type { PendingHistoryDisclosure } from '../stores/task-store';

export interface HistoryDisclosureCardProps {
  disclosure: PendingHistoryDisclosure;
  busyDecision: HistoryDisclosureDecision | null;
  disabled: boolean;
  onShareOnce(): void;
  onCurrentMessageOnly(): void;
}

/** 仅展示 Main 批准公开的 Provider 名称与计数摘要。 */
export function HistoryDisclosureCard({
  disclosure,
  busyDecision,
  disabled,
  onShareOnce,
  onCurrentMessageOnly
}: HistoryDisclosureCardProps) {
  const busy = busyDecision !== null;
  return (
    <section
      className="confirmation-card"
      aria-labelledby="history-disclosure-title"
      aria-busy={busy}
    >
      <span className="confirmation-eyebrow">需要你确认</span>
      <h2 id="history-disclosure-title">是否共享当前会话历史？</h2>
      <div className="path-row">
        <span>目标服务</span>
        <strong>{disclosure.targetProviderName}</strong>
      </div>
      <div className="path-row">
        <span>共享摘要</span>
        <strong>
          <span>{disclosure.messageCount} 条消息</span>
          {' · '}
          <span>{disclosure.characterCount} 个字符</span>
        </strong>
      </div>
      <p className="confirmation-safety">
        你可以只为这一次共享历史，也可以仅发送当前消息。
      </p>
      <div className="confirmation-actions">
        <button
          className="primary-button"
          type="button"
          disabled={disabled || busy}
          onClick={onShareOnce}
        >
          {busyDecision === 'share_once' ? '正在共享历史…' : '仅本次共享历史'}
        </button>
        <button
          className="quiet-button"
          type="button"
          disabled={disabled || busy}
          onClick={onCurrentMessageOnly}
        >
          {busyDecision === 'current_message_only' ? '正在继续发送…' : '仅发送当前消息'}
        </button>
      </div>
      <p className="confirmation-safety" role="status" aria-live="polite">
        {busy ? '正在处理你的选择，请稍候。' : ''}
      </p>
    </section>
  );
}
