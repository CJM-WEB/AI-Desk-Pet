import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { HistoryDisclosureDecision, TaskPhase } from '@myself/shared-types';
import type { MyselfApi } from '../../../shared/myself-api';
import type { LocalModelPublicStatus } from '../../../shared/local-model-ipc';
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

const initialLocalModelStatus: LocalModelPublicStatus = {
  enabled: false,
  phase: 'disabled',
  backend: null,
  reasonCode: null
};

function localModelReasonText(reasonCode: LocalModelPublicStatus['reasonCode']): string {
  const reasons: Record<NonNullable<LocalModelPublicStatus['reasonCode']>, string> = {
    RESOURCE_MISSING: '内置资源缺失',
    RESOURCE_HASH_MISMATCH: '内置资源校验失败',
    RUNTIME_INCOMPATIBLE: '运行时不兼容',
    VULKAN_UNAVAILABLE: 'Vulkan 不可用',
    CPU_START_FAILED: 'CPU 兼容模式启动失败',
    MODEL_LOAD_TIMEOUT: '模型加载超时',
    PORT_CONFLICT: '本地端口冲突',
    PROCESS_CRASHED: '本地模型进程意外退出',
    PROTOCOL_INCOMPATIBLE: '本地模型协议不兼容',
    PROCESS_CLEANUP_FAILED: '本地模型进程清理失败'
  };
  return reasonCode ? reasons[reasonCode] : '本地模型启动失败';
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

export function ChatPanel({ api = window.myself }: { api?: MyselfApi }) {
  const conversationRevision = useTaskStore(state => state.conversationRevision);
  const phase = useTaskStore(state => state.phase);
  const messages = useTaskStore(state => state.messages);
  const pendingAction = useTaskStore(state => state.pendingAction);
  const pendingHistoryDisclosure = useTaskStore(state => state.pendingHistoryDisclosure);
  const [text, setText] = useState('');
  const [localModelStatus, setLocalModelStatus] = useState(initialLocalModelStatus);
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
  const localModelBlocking = localModelStatus.enabled && localModelStatus.phase !== 'ready';
  const submitDisabled = canStop(phase)
    || localModelBlocking
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

  useEffect(() => {
    let active = true;
    const unsubscribe = api.onLocalModelStatus?.(status => {
      if (active) setLocalModelStatus(status);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [api]);

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
      await api.submitMessage(normalized);
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
      await api.confirmAction(pendingAction.actionId);
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
      await api.cancelAction(pendingAction.actionId);
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
      await api.resolveHistoryDisclosure(disclosure.requestId, decision);
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
      await api.resetConversation();
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
          <button type="button" onClick={() => void api.openSettings()}>设置</button>
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
              <button className="quiet-button" type="button" onClick={() => void api.openSettings()}>
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
        {localModelStatus.enabled && localModelStatus.phase !== 'ready' ? (
          localModelStatus.phase === 'faulted' ? (
            <div className="local-model-chat-notice local-model-chat-fault" role="alert">
              <p>本地模型暂不可用：{localModelReasonText(localModelStatus.reasonCode)}。</p>
              <p>视觉暂不可用。</p>
              <button className="quiet-button" type="button" onClick={() => void api.openSettings()}>
                打开模型设置
              </button>
            </div>
          ) : (
            <p className="local-model-chat-notice" role="status" aria-live="polite">
              {localModelStatus.phase === 'stopping' ? '本地模型正在停止' : '本地模型加载中'}，暂时不能发送消息。
            </p>
          )
        ) : null}
        {localModelStatus.enabled && localModelStatus.phase === 'ready'
          && localModelStatus.backend === 'cpu' ? (
            <p className="local-model-chat-notice" role="status">CPU 兼容模式</p>
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
              onClick={() => void api.cancelTask()}
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
