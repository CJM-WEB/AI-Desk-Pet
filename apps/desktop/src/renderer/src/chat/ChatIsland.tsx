import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, History, Menu, MessageCirclePlus, Settings } from 'lucide-react';
import type { ChatPresentationApi } from '../../../shared/chat-presentation';
import { usePresentationLayout } from './use-presentation-layout';

export interface ChatIslandProps {
  api?: Pick<ChatPresentationApi, 'setLayout' | 'onCommand'> | undefined;
  history: ReactNode;
  input: ReactNode;
  send: ReactNode;
  notice?: ReactNode;
  attentionKey?: string | undefined;
  busy: boolean;
  onNewConversation(): void;
  onSettings(): void;
}

/** 顶部展示组件不拥有消息提交、任务或授权决策。 */
export function ChatIsland({ api, history, input, send, notice, attentionKey, busy, onNewConversation, onSettings }: ChatIslandProps) {
  const [mode, setMode] = useState<'hidden' | 'peek' | 'opening' | 'open' | 'closing'>(api ? 'hidden' : 'open');
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(!api);
  const [layoutFailed, setLayoutFailed] = useState(false);
  const [layoutGeneration, setLayoutGeneration] = useState(0);
  const shell = useRef<HTMLElement>(null);
  const transition = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const failLayout = useCallback(() => setLayoutFailed(true), []);
  const changeMode = useCallback((next: 'opening' | 'closing') => {
    if (transition.current) clearTimeout(transition.current);
    if (next === 'closing') { setMenuOpen(false); setHistoryOpen(false); }
    setMode(next);
    transition.current = setTimeout(() => {
      transition.current = null;
      setMode(next === 'opening' ? 'open' : 'hidden');
    }, 480);
  }, []);

  useEffect(() => api?.onCommand(command => {
    if (command.type === 'open') changeMode('opening');
    else if (command.type === 'close') changeMode('closing');
    else if (command.type === 'peek' && modeRef.current === 'hidden') setMode('peek');
    else if (command.type === 'conceal' && modeRef.current === 'peek') setMode('hidden');
    else if (command.type === 'reset') {
      setMenuOpen(false); setHistoryOpen(false); setLayoutGeneration(value => value + 1);
    }
  }), [api, changeMode]);
  useEffect(() => () => { if (transition.current) clearTimeout(transition.current); }, []);
  useEffect(() => {
    if (attentionKey) { setHistoryOpen(true); changeMode('opening'); }
  }, [attentionKey, changeMode]);
  useEffect(() => {
    if (mode === 'open') shell.current?.querySelector('textarea')?.focus();
  }, [mode]);

  usePresentationLayout(shell, api, 'island', mode, `${menuOpen}:${historyOpen}:${layoutGeneration}`, failLayout);
  const expanded = mode === 'opening' || mode === 'open' || mode === 'closing';
  const historyHeight = Math.min(360, Math.max(120, Math.round((window.screen.availHeight || 900) * 0.38)));
  const shellStyle = { '--history-height': `${historyHeight}px` } as CSSProperties;
  const entries = [
    { id: 'new', label: '新对话', Icon: MessageCirclePlus, action: () => { setMenuOpen(false); onNewConversation(); } },
    { id: 'history', label: '历史', Icon: History, action: () => setHistoryOpen(value => !value) },
    { id: 'settings', label: '设置', Icon: Settings, action: () => { setMenuOpen(false); onSettings(); } }
  ];

  return <main ref={shell} className="chat-island-stage" data-island-mode={mode} style={shellStyle}>
    <button className="island-peek" type="button" aria-label="打开聊天" hidden={mode !== 'peek'}
      data-presentation-region="18" onClick={() => changeMode('opening')}><ChevronDown size={18} /></button>
    <div className="island-expanded" hidden={!expanded}>
      <div className="island-history-wrap" data-open={historyOpen} aria-hidden={!historyOpen}>
        <section className="island-history" role="region" aria-label="历史对话"
          data-presentation-region={historyOpen ? '8' : undefined} onPointerDown={() => setMenuOpen(false)}>
          {history}
        </section>
      </div>
      <div className="island-row">
        <div className="island-menu">
          <button type="button" className="island-orb" aria-label="选项" aria-haspopup="menu" aria-expanded={menuOpen}
            data-presentation-region="24" onClick={() => setMenuOpen(value => !value)}><Menu size={20} /></button>
          <div role="menu" className="island-menu-items glass-surface" hidden={!menuOpen} data-presentation-region="20">
            {entries.map(({ id, label, Icon, action }) => <button key={id} type="button" role="menuitem"
              disabled={id === 'new' && busy} aria-pressed={id === 'history' ? historyOpen : undefined} onClick={action}>
              <Icon size={17} /><span>{label}</span>
            </button>)}
          </div>
        </div>
        <div className="island-input-group">
          <div className="island-input glass-surface" data-presentation-region="24" onPointerDown={() => setMenuOpen(false)}>{input}</div>
          <button type="button" className="island-collapse" aria-label="收起聊天" data-presentation-region="16"
            onClick={() => changeMode('closing')}><ChevronUp size={16} /></button>
        </div>
        <div className="island-send" data-presentation-region="24" onPointerDown={() => setMenuOpen(false)}>{send}</div>
      </div>
      <div className="island-notice" data-presentation-region={notice || layoutFailed ? '16' : undefined}>
        {notice}{layoutFailed ? <p role="status">聊天界面定位暂不可用，请重新打开聊天。</p> : null}
      </div>
    </div>
  </main>;
}
