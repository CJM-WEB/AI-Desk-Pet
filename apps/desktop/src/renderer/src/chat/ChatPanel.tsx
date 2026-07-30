import { useState, type FormEvent } from 'react';
import type { TaskPhase } from '@myself/shared-types';
import { ConfirmationCard } from './ConfirmationCard';
import { taskStore, useTaskStore } from '../stores/task-store';

const phaseLabels: Record<TaskPhase, string> = {
  idle: '陪着你',
  listening: '正在听',
  thinking: '认真想想',
  awaiting_confirmation: '等你确认',
  acting: '正在处理',
  success: '完成啦',
  error: '需要一起看看',
  cancelled: '已经停下'
};

function canStop(phase: TaskPhase): boolean {
  return phase === 'listening' || phase === 'thinking' || phase === 'acting';
}

/** 聊天关闭按钮始终调用 preload 暴露的正式窗口命令。 */
export function ChatCloseButton() {
  return (
    <button
      type="button"
      aria-label="关闭聊天气泡"
      onClick={() => void window.myself.hideChat()}
    >
      关闭
    </button>
  );
}

export function ChatPanel() {
  const phase = useTaskStore(state => state.phase);
  const messages = useTaskStore(state => state.messages);
  const pendingAction = useTaskStore(state => state.pendingAction);
  const [text, setText] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const normalized = text.trim();
    if (!normalized || canStop(phase) || pendingAction) return;
    setText('');
    taskStore.getState().beginListening();
    try {
      await window.myself.submitMessage(normalized);
    } catch {
      if (taskStore.getState().phase !== 'error') {
        taskStore.getState().apply({
          type: 'error',
          code: 'IPC_REQUEST_FAILED',
          message: '消息没有成功送达，请稍后重试。'
        });
        taskStore.getState().apply({ type: 'phase', phase: 'error' });
      }
    }
  };

  const confirmAction = async (): Promise<void> => {
    if (!pendingAction || actionBusy) return;
    setActionBusy(true);
    try {
      await window.myself.confirmAction(pendingAction.actionId);
    } finally {
      setActionBusy(false);
    }
  };

  const cancelAction = async (): Promise<void> => {
    if (!pendingAction || actionBusy) return;
    setActionBusy(true);
    try {
      await window.myself.cancelAction(pendingAction.actionId);
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <main className="chat-shell">
      <header className="chat-header">
        <div>
          <span className="companion-kicker">AI PET</span>
          <strong>晚上好，我在这里</strong>
        </div>
        <div className="header-actions">
          <span className={`phase-pill phase-${phase}`}>{phaseLabels[phase]}</span>
          <button type="button" onClick={() => void window.myself.openSettings()}>设置</button>
          <ChatCloseButton />
        </div>
      </header>

      <section className="messages" aria-live="polite" aria-label="对话消息">
        {messages.length === 0 ? (
          <div className="welcome-card">
            <span aria-hidden="true">☀</span>
            <p>今天想聊点什么？如果你愿意，我也可以帮你整理已经授权的工作目录。</p>
          </div>
        ) : messages.map(message => (
          <article key={message.id} className={`message message-${message.role}`}>
            <span>{message.role === 'user' ? '你' : message.role === 'error' ? '一起看看' : 'AI Pet'}</span>
            <p>{message.text}</p>
            {message.nextAction ? <small>下一步：{message.nextAction}</small> : null}
          </article>
        ))}
        {pendingAction ? (
          <ConfirmationCard
            action={pendingAction}
            busy={actionBusy}
            onConfirm={() => void confirmAction()}
            onCancel={() => void cancelAction()}
          />
        ) : null}
      </section>

      <form className="composer" onSubmit={event => void submit(event)}>
        <label htmlFor="message-input">和我说点什么</label>
        <textarea
          id="message-input"
          value={text}
          maxLength={4_000}
          rows={2}
          placeholder="比如：陪我看看这个文件夹里有什么"
          onChange={event => setText(event.target.value)}
        />
        <div className="composer-footer">
          <span>{text.length}/4000</span>
          {canStop(phase) ? (
            <button className="stop-button" type="button" onClick={() => void window.myself.cancelTask()}>
              停止当前任务
            </button>
          ) : (
            <button className="primary-button" type="submit" disabled={!text.trim() || Boolean(pendingAction)}>
              发送给 AI Pet
            </button>
          )}
        </div>
      </form>
    </main>
  );
}
