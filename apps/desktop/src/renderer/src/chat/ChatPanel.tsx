import { useRef, useState, type FormEvent } from 'react';
import type { HistoryDisclosureDecision, TaskPhase } from '@myself/shared-types';
import { ConfirmationCard } from './ConfirmationCard';
import { HistoryDisclosureCard } from './HistoryDisclosureCard';
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

type RevisionOwner = Readonly<{ revision: number; token: symbol }>;
type DisclosureOwner = RevisionOwner & Readonly<{
  requestId: string;
  decision: HistoryDisclosureDecision;
}>;

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
  const conversationRevision = useTaskStore(state => state.conversationRevision);
  const phase = useTaskStore(state => state.phase);
  const messages = useTaskStore(state => state.messages);
  const pendingAction = useTaskStore(state => state.pendingAction);
  const pendingHistoryDisclosure = useTaskStore(state => state.pendingHistoryDisclosure);
  const [text, setText] = useState('');
  const [actionBusyOwner, setActionBusyOwner] = useState<RevisionOwner | null>(null);
  const [disclosureBusyOwner, setDisclosureBusyOwner] = useState<DisclosureOwner | null>(null);
  const [resetBusyOwner, setResetBusyOwner] = useState<RevisionOwner | null>(null);
  const [interactionErrorState, setInteractionErrorState] = useState<{
    revision: number;
    message: string;
  } | null>(null);
  const submitOwner = useRef<RevisionOwner | null>(null);
  const actionOwner = useRef<RevisionOwner | null>(null);
  const disclosureOwner = useRef<DisclosureOwner | null>(null);
  const resetOwner = useRef<RevisionOwner | null>(null);
  const actionBusy = actionBusyOwner?.revision === conversationRevision;
  const disclosureBusy = disclosureBusyOwner?.revision === conversationRevision
    ? disclosureBusyOwner
    : null;
  const resetBusy = resetBusyOwner?.revision === conversationRevision;
  const interactionError = interactionErrorState?.revision === conversationRevision
    ? interactionErrorState.message
    : null;
  const anyInteractionBusy = actionBusy || disclosureBusy !== null || resetBusy;
  const submitDisabled = canStop(phase)
    || Boolean(pendingAction)
    || Boolean(pendingHistoryDisclosure)
    || anyInteractionBusy;

  const currentRevision = (): number => taskStore.getState().conversationRevision;
  const isCurrentOwner = (
    owner: RevisionOwner,
    current: RevisionOwner | null
  ): boolean => current === owner && currentRevision() === owner.revision;
  const hasCurrentInteractionOwner = (): boolean => {
    const revision = currentRevision();
    return actionOwner.current?.revision === revision
      || disclosureOwner.current?.revision === revision
      || resetOwner.current?.revision === revision;
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const normalized = text.trim();
    if (!normalized || submitDisabled) return;
    const owner: RevisionOwner = {
      revision: currentRevision(),
      token: Symbol('submit-message')
    };
    submitOwner.current = owner;
    setText('');
    taskStore.getState().beginListening();
    try {
      await window.myself.submitMessage(normalized);
    } catch {
      if (isCurrentOwner(owner, submitOwner.current)
        && taskStore.getState().phase !== 'error') {
        taskStore.getState().apply({
          type: 'error',
          code: 'IPC_REQUEST_FAILED',
          message: '消息没有成功送达，请稍后重试。'
        });
        taskStore.getState().apply({ type: 'phase', phase: 'error' });
      }
    } finally {
      if (isCurrentOwner(owner, submitOwner.current)) submitOwner.current = null;
    }
  };

  const confirmAction = async (): Promise<void> => {
    if (!pendingAction || hasCurrentInteractionOwner()) return;
    const owner: RevisionOwner = {
      revision: currentRevision(),
      token: Symbol('confirm-action')
    };
    actionOwner.current = owner;
    setActionBusyOwner(owner);
    setInteractionErrorState(null);
    try {
      await window.myself.confirmAction(pendingAction.actionId);
    } catch {
      if (isCurrentOwner(owner, actionOwner.current)) {
        setInteractionErrorState({
          revision: owner.revision,
          message: '未能处理文件操作，请重试。'
        });
      }
    } finally {
      if (isCurrentOwner(owner, actionOwner.current)) {
        actionOwner.current = null;
        setActionBusyOwner(null);
      }
    }
  };

  const cancelAction = async (): Promise<void> => {
    if (!pendingAction || hasCurrentInteractionOwner()) return;
    const owner: RevisionOwner = {
      revision: currentRevision(),
      token: Symbol('cancel-action')
    };
    actionOwner.current = owner;
    setActionBusyOwner(owner);
    setInteractionErrorState(null);
    try {
      await window.myself.cancelAction(pendingAction.actionId);
    } catch {
      if (isCurrentOwner(owner, actionOwner.current)) {
        setInteractionErrorState({
          revision: owner.revision,
          message: '未能处理文件操作，请重试。'
        });
      }
    } finally {
      if (isCurrentOwner(owner, actionOwner.current)) {
        actionOwner.current = null;
        setActionBusyOwner(null);
      }
    }
  };

  const resolveDisclosure = async (decision: HistoryDisclosureDecision): Promise<void> => {
    const disclosure = pendingHistoryDisclosure;
    if (!disclosure || hasCurrentInteractionOwner()) return;
    const store = taskStore.getState();
    if (!store.beginHistoryDisclosureResolution(disclosure.requestId)) return;
    const owner: DisclosureOwner = {
      revision: store.conversationRevision,
      token: Symbol('resolve-disclosure'),
      requestId: disclosure.requestId,
      decision
    };
    disclosureOwner.current = owner;
    setDisclosureBusyOwner(owner);
    setInteractionErrorState(null);
    try {
      await window.myself.resolveHistoryDisclosure(disclosure.requestId, decision);
      if (isCurrentOwner(owner, disclosureOwner.current)) {
        taskStore.getState().completeHistoryDisclosure(disclosure.requestId);
      }
    } catch {
      if (isCurrentOwner(owner, disclosureOwner.current)) {
        const current = taskStore.getState();
        if (current.pendingHistoryDisclosure?.requestId === disclosure.requestId) {
          current.releaseHistoryDisclosureResolution(disclosure.requestId);
          setInteractionErrorState({
            revision: owner.revision,
            message: '未能处理历史披露，请重试。'
          });
        }
      }
    } finally {
      if (isCurrentOwner(owner, disclosureOwner.current)) {
        disclosureOwner.current = null;
        setDisclosureBusyOwner(null);
      }
    }
  };

  const resetConversation = async (): Promise<void> => {
    if (hasCurrentInteractionOwner()) return;
    const owner: RevisionOwner = {
      revision: currentRevision(),
      token: Symbol('reset-conversation')
    };
    resetOwner.current = owner;
    setResetBusyOwner(owner);
    setInteractionErrorState(null);
    try {
      await window.myself.resetConversation();
    } catch {
      if (isCurrentOwner(owner, resetOwner.current)) {
        setInteractionErrorState({
          revision: owner.revision,
          message: '未能新建对话，请稍后重试。'
        });
      }
    } finally {
      if (isCurrentOwner(owner, resetOwner.current)) {
        resetOwner.current = null;
        setResetBusyOwner(null);
      }
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
          <button
            type="button"
            disabled={anyInteractionBusy}
            onClick={() => void resetConversation()}
          >
            {resetBusy ? '正在新建…' : '新对话'}
          </button>
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
            {message.code === 'FILE_AUTHORIZATION_REQUIRED' ? (
              <button className="quiet-button" type="button" onClick={() => void window.myself.openSettings()}>
                打开设置
              </button>
            ) : null}
          </article>
        ))}
        {interactionError ? (
          <p className="message message-error" role="alert" aria-live="assertive">
            {interactionError}
          </p>
        ) : null}
        {pendingHistoryDisclosure ? (
          <HistoryDisclosureCard
            disclosure={pendingHistoryDisclosure}
            busyDecision={disclosureBusy?.requestId === pendingHistoryDisclosure.requestId
              ? disclosureBusy.decision
              : null}
            disabled={resetBusy || actionBusy}
            onShareOnce={() => void resolveDisclosure('share_once')}
            onCurrentMessageOnly={() => void resolveDisclosure('current_message_only')}
          />
        ) : null}
        {pendingAction ? (
          <ConfirmationCard
            action={pendingAction}
            busy={anyInteractionBusy}
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
          disabled={resetBusy}
          onChange={event => setText(event.target.value)}
        />
        <div className="composer-footer">
          <span>{text.length}/4000</span>
          {canStop(phase) ? (
            <button
              className="stop-button"
              type="button"
              disabled={Boolean(pendingHistoryDisclosure) || anyInteractionBusy}
              onClick={() => void window.myself.cancelTask()}
            >
              停止当前任务
            </button>
          ) : (
            <button className="primary-button" type="submit" disabled={!text.trim() || submitDisabled}>
              发送给 AI Pet
            </button>
          )}
        </div>
      </form>
    </main>
  );
}
