import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, Square } from 'lucide-react';
import type { HistoryDisclosureDecision, TaskPhase } from '@myself/shared-types';
import type { MyselfApi } from '../../../shared/myself-api';
import type { LocalModelPublicStatus } from '../../../shared/local-model-ipc';
import { localModelReasonText } from '../local-model-status';
import { ConfirmationCard } from './ConfirmationCard';
import { HistoryDisclosureCard } from './HistoryDisclosureCard';
import { CapabilityAuthorizationCard } from './CapabilityAuthorizationCard';
import { taskStore, useTaskStore } from '../stores/task-store';
import { ChatIsland } from './ChatIsland';
import { presentCapabilityAuthorization, presentHistoryDisclosure, presentTaskPermission } from './confirmation-presentation';
import { useChatPresentation } from './use-chat-presentation';
import './chat-presentation.css';

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

type RevisionOwner = Readonly<{ revision: number; token: symbol }>;
type DisclosureOwner = RevisionOwner & Readonly<{
  requestId: string;
  decision: HistoryDisclosureDecision;
}>;

export function ChatPanel({ api = window.myself }: { api?: MyselfApi }) {
  const conversationRevision = useTaskStore(state => state.conversationRevision);
  const phase = useTaskStore(state => state.phase);
  const messages = useTaskStore(state => state.messages);
  const persistenceError = useTaskStore(state => state.persistenceError);
  const pendingAction = useTaskStore(state => state.pendingPermissions[0]);
  const pendingHistoryDisclosure = useTaskStore(state => state.pendingHistoryDisclosure);
  const pendingCapabilityAuthorization = useTaskStore(
    state => state.pendingCapabilityAuthorization
  );
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
    || Boolean(pendingCapabilityAuthorization)
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
    let receivedStatusEvent = false;
    const unsubscribe = api.onLocalModelStatus?.(status => {
      receivedStatusEvent = true;
      if (active) setLocalModelStatus(status);
    });
    // 订阅先于快照，避免异步 Dashboard 返回覆盖更晚的状态事件。
    void api.getSettingsDashboard?.().then(dashboard => {
      if (active && !receivedStatusEvent) setLocalModelStatus(dashboard.localModel);
    }).catch(() => undefined);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [api]);

  // 按钮和 Enter 共用提交 owner 与会话修订，防止迟到失败污染新对话。
  const submit = async (): Promise<void> => {
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
      if (isCurrentOwner(owner, actionOwner.current)) taskStore.getState().completeTaskPermission(pendingAction.actionId);
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
      if (isCurrentOwner(owner, actionOwner.current)) taskStore.getState().completeTaskPermission(pendingAction.actionId);
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

  const resolveCapabilityAuthorization = async (
    decision: 'confirm' | 'cancel'
  ): Promise<void> => {
    if (!pendingCapabilityAuthorization || hasCurrentInteractionOwner()) return;
    const owner: RevisionOwner = {
      revision: currentRevision(), token: Symbol('capability-authorization')
    };
    actionOwner.current = owner;
    setActionBusyOwner(owner);
    try {
      await api.resolveCapabilityAuthorization(
        pendingCapabilityAuthorization.requestId,
        decision
      );
      if (isCurrentOwner(owner, actionOwner.current)) {
        taskStore.getState().completeCapabilityAuthorization(
          pendingCapabilityAuthorization.requestId
        );
      }
    } catch {
      if (isCurrentOwner(owner, actionOwner.current)) {
        setInteractionErrorState({
          revision: owner.revision,
          message: '未能处理本地任务授权，请重试。'
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

  const confirmation = useMemo(() => pendingHistoryDisclosure
    ? presentHistoryDisclosure(pendingHistoryDisclosure, anyInteractionBusy, interactionError ?? undefined)
    : pendingCapabilityAuthorization
      ? presentCapabilityAuthorization(pendingCapabilityAuthorization, anyInteractionBusy, interactionError ?? undefined)
      : pendingAction ? presentTaskPermission(pendingAction, anyInteractionBusy, interactionError ?? undefined) : null,
  [pendingHistoryDisclosure, pendingCapabilityAuthorization, pendingAction, anyInteractionBusy, interactionError]);
  // 这里只选择已有按钮处理器；确认身份、忙碌 owner 和业务决定仍由上方原函数承接。
  const presentation = useChatPresentation({
    api, conversationRevision, confirmation, readCurrentRevision: currentRevision,
    onConfirm: () => {
      if (pendingHistoryDisclosure) void resolveDisclosure('share_once');
      else if (pendingCapabilityAuthorization) void resolveCapabilityAuthorization('confirm');
      else void confirmAction();
    },
    onReject: () => {
      if (pendingHistoryDisclosure) void resolveDisclosure('current_message_only');
      else if (pendingCapabilityAuthorization) void resolveCapabilityAuthorization('cancel');
      else void cancelAction();
    }
  });
  const notices = <>
    {persistenceError ? <p role="status">{persistenceError === 'CONVERSATION_LOAD_FAILED'
      ? '无法恢复聊天记录，原记录已保留。点击“新对话”可重新开始保存。'
      : '聊天记录保存失败，本次新增内容可能无法在重启后恢复。'}</p> : null}
    {interactionError ? <p role="alert">{interactionError}</p> : null}
    {localModelStatus.enabled && localModelStatus.phase !== 'ready' ? (
      localModelStatus.phase === 'faulted' ? <div role="alert">
        <p>本地模型暂不可用：{localModelReasonText(localModelStatus.reasonCode)}。</p><p>视觉暂不可用。</p>
        <button className="quiet-button" type="button" onClick={() => void api.openSettings()}>打开模型设置</button>
      </div> : <p role="status">{localModelStatus.phase === 'stopping' ? '本地模型正在停止' : '本地模型加载中'}，暂时不能发送消息。</p>
    ) : null}
    {localModelStatus.enabled && localModelStatus.phase === 'ready' && localModelStatus.backend === 'cpu'
      ? <p role="status">CPU 兼容模式</p> : null}
    {!presentation.pointerAvailable ? <p role="status">桌面点击观察暂不可用，可点击输入框下方三角收起聊天。</p> : null}
    {presentation.fallback && api.chatPresentation ? <p>头顶气泡暂不可用，请在这里继续。</p> : null}
    {presentation.fallback && pendingHistoryDisclosure ? <HistoryDisclosureCard
      disclosure={pendingHistoryDisclosure}
      busyDecision={disclosureBusy?.requestId === pendingHistoryDisclosure.requestId ? disclosureBusy.decision : null}
      disabled={resetBusy || actionBusy}
      onShareOnce={() => void resolveDisclosure('share_once')}
      onCurrentMessageOnly={() => void resolveDisclosure('current_message_only')} /> : null}
    {presentation.fallback && !pendingHistoryDisclosure && pendingCapabilityAuthorization ? <CapabilityAuthorizationCard
      authorization={pendingCapabilityAuthorization} busy={anyInteractionBusy}
      onConfirm={() => void resolveCapabilityAuthorization('confirm')}
      onCancel={() => void resolveCapabilityAuthorization('cancel')} /> : null}
    {presentation.fallback && !pendingHistoryDisclosure && !pendingCapabilityAuthorization && pendingAction ? <ConfirmationCard
      action={pendingAction} busy={anyInteractionBusy}
      onConfirm={() => void confirmAction()} onCancel={() => void cancelAction()} /> : null}
  </>;
  const hasNotice = Boolean(persistenceError || interactionError || localModelStatus.enabled && (localModelStatus.phase !== 'ready' || localModelStatus.backend === 'cpu')
    || !presentation.pointerAvailable || presentation.fallback && (api.chatPresentation || confirmation));

  return <form onSubmit={event => { event.preventDefault(); void submit(); }}>
    <ChatIsland api={api.chatPresentation} busy={anyInteractionBusy}
      attentionKey={api.chatPresentation && presentation.fallback && (confirmation || presentation.reply)
        ? `${conversationRevision}:${confirmation?.id ?? presentation.reply?.id}` : undefined}
      onNewConversation={() => void resetConversation()} onSettings={() => void api.openSettings()}
      notice={hasNotice ? notices : undefined}
      history={<section className="messages" aria-live="polite" aria-label="对话消息">
        {messages.length === 0 ? <div className="history-empty"><span>AI PET</span><p>今天想聊点什么？</p></div>
          : messages.map(message => <article key={message.id} className={`message message-${message.role}`}>
            <span>{message.role === 'user' ? '你' : message.role === 'error' ? '一起看看' : 'AI Pet'}</span>
            <p>{message.text}</p>
            {message.nextAction ? <small>下一步：{message.nextAction}</small> : null}
            {message.code === 'FILE_AUTHORIZATION_REQUIRED' ? <button className="quiet-button" type="button"
              onClick={() => void api.openSettings()}>打开设置</button> : null}
          </article>)}
      </section>}
      input={<>
        <label className="chat-visually-hidden" htmlFor="message-input">和我说点什么</label>
        <textarea id="message-input" value={text} maxLength={4_000} rows={2} placeholder="和我说点什么…"
          disabled={resetBusy} onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault(); void submit();
            }
          }} />
        <span className={`island-status phase-pill phase-${phase}`}>{text.length > 3000 ? `${text.length}/4000 · ` : ''}{phaseLabels[phase]}</span>
      </>}
      send={canStop(phase) ? <button type="button" aria-label="停止当前任务" title="停止当前任务"
        disabled={Boolean(pendingHistoryDisclosure) || anyInteractionBusy} onClick={() => void api.cancelTask()}><Square size={18} fill="currentColor" /></button>
        : <button type="submit" aria-label="发送给 AI Pet" title="发送给 AI Pet" disabled={!text.trim() || submitDisabled}><Send size={20} /></button>}
    />
  </form>;
}
