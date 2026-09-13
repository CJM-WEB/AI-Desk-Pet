import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ChatPresentationApi, ChatPresentationIntent, ChatPresentationSnapshot } from '../../../shared/chat-presentation';
import { usePresentationLayout } from './use-presentation-layout';

export type ConfirmationPresentation = NonNullable<ChatPresentationSnapshot['confirmation']>;

/** 展示控件复用于头顶和投递失败回退；按钮语义由原聊天处理器提供。 */
export function ConfirmationBubble({ value, onConfirm, onReject }: {
  value: ConfirmationPresentation; onConfirm(): void; onReject(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [value.id]);
  return <section className="confirmation-bubble" aria-busy={value.busy} data-confirmation-kind={value.kind}
    role={value.kind === 'capability' ? 'article' : 'region'}
    aria-label={value.kind === 'capability' ? '本地任务授权' : value.kind === 'permission' ? '具体操作许可' : '历史共享授权'}>
    <div className="confirmation-bubble-row">
      <button className="bubble-decision bubble-reject" type="button" disabled={value.busy}
        aria-label={value.rejectDescription} title={value.rejectDescription} onClick={onReject}>拒绝</button>
      <button className="bubble-summary" type="button" aria-expanded={expanded}
        onClick={() => setExpanded(current => !current)}>{value.title}<span aria-hidden="true">⌄</span></button>
      <button className="bubble-decision bubble-approve" type="button" disabled={value.busy}
        aria-label={value.approveDescription} title={value.approveDescription} onClick={onConfirm}>{value.approveLabel}</button>
    </div>
    {expanded ? <div className="bubble-details">{value.details.map((line, index) => <p key={index}>{line}</p>)}</div> : null}
    {value.error ? <p className="bubble-error" role="alert">{value.error}</p> : null}
    {value.busy ? <p className="bubble-busy" role="status">正在处理你的选择，请稍候。</p> : null}
  </section>;
}

/** 独立气泡只有展示协议，不订阅任务、不恢复会话、不持有业务操作入口。 */
export function ChatBubbleView({ api = window.myself?.chatPresentation }: { api?: ChatPresentationApi }) {
  const [snapshot, setSnapshot] = useState<ChatPresentationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [anchor, setAnchor] = useState<{ bodyLeft: number; tailX: number; side: 'top' | 'bottom' } | null>(null);
  const root = useRef<HTMLElement>(null);
  const current = useRef(snapshot);
  current.current = snapshot;
  useEffect(() => {
    if (!api) return;
    const unsubscribe = api.onSnapshot(value => { setSnapshot(value); setError(null); setSending(false); });
    const commands = api.onCommand(command => {
      if (command.type === 'bubble-anchor') setAnchor({ bodyLeft: command.bodyLeft, tailX: command.tailX, side: command.side });
    });
    void api.ready().catch(() => setError('气泡连接暂不可用，请在聊天界面继续。'));
    return () => { current.current = null; unsubscribe(); commands(); };
  }, [api]);
  const visible = Boolean(snapshot?.confirmation || snapshot?.reply?.text);
  const layoutFailure = useCallback(() => setError('气泡定位暂不可用，请在聊天界面继续。'), []);
  usePresentationLayout(root, api, 'bubble', visible ? 'open' : 'hidden', `${snapshot?.revision}:${anchor?.bodyLeft}:${anchor?.tailX}:${anchor?.side}`, layoutFailure);
  const dispatch = async (action: ChatPresentationIntent['action'], targetId: string) => {
    const owner = current.current;
    if (!api || !owner || sending) return;
    setSending(true); setError(null);
    try {
      await api.dispatch({ epoch: owner.epoch, revision: owner.revision, conversationRevision: owner.conversationRevision, targetId, action });
    } catch {
      if (current.current === owner) setError('操作未送达，请重试。');
    } finally {
      if (current.current === owner) setSending(false);
    }
  };
  return <main ref={root} className="chat-bubble-stage" style={{ '--bubble-max-height': `${Math.max(160, Math.min(520, (screen.availHeight || 900) * .45))}px` } as CSSProperties}>
    {visible && snapshot ? <div className="pet-speech glass-surface" data-presentation-region="22"
      style={anchor ? { '--bubble-offset': `${anchor.bodyLeft - 12}px` } as CSSProperties : undefined}>
      {snapshot.confirmation ? <ConfirmationBubble value={{ ...snapshot.confirmation, busy: snapshot.confirmation.busy || sending }}
        onConfirm={() => void dispatch('confirm', snapshot.confirmation!.id)}
        onReject={() => void dispatch('reject', snapshot.confirmation!.id)} />
        : <><button className="speech-close" type="button" aria-label="关闭回复气泡" disabled={sending}
          onClick={() => void dispatch('dismiss-reply', snapshot.reply!.id)}>×</button>
        <div className="speech-text" aria-live="polite">{snapshot.reply?.text}</div></>}
      {error ? <p className="bubble-error" role="alert">{error}</p> : null}
      <span className="speech-tail" aria-hidden="true" data-presentation-region="3" data-side={anchor?.side ?? 'bottom'}
        style={anchor ? { left: anchor.tailX - 6 } : undefined} />
    </div> : null}
  </main>;
}
