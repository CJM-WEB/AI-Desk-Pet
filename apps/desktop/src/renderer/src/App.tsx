import { useState, type FormEvent } from 'react';

type ViewName = 'pet' | 'chat' | 'settings';

function currentView(): ViewName {
  const view = new URLSearchParams(window.location.search).get('view');
  if (view === 'chat' || view === 'settings') return view;
  return 'pet';
}

function PetView() {
  return (
    <main className="pet-shell" aria-label="Myself 桌宠">
      <button className="pet-button no-drag" type="button" onClick={() => void window.myself.openChat()}>
        <span className="pet-face" aria-hidden="true">•ᴗ•</span>
        <span className="pet-label">点我聊天</span>
      </button>
    </main>
  );
}

function ChatView() {
  const [text, setText] = useState('');
  const [notice, setNotice] = useState('Agent 服务将在后续任务接入。');

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!text.trim()) return;
    setNotice('桌面外壳已收到输入；Agent 服务尚未接入。');
    setText('');
  };

  return (
    <main className="panel chat-panel">
      <header>
        <div><strong>Myself</strong><span className="status">待机</span></div>
        <nav>
          <button type="button" onClick={() => void window.myself.openSettings()}>设置</button>
          <button type="button" onClick={() => void window.myself.hideChat()}>关闭</button>
        </nav>
      </header>
      <section className="messages" aria-live="polite">
        <p className="assistant-message">你好，我已经住进桌面了。</p>
        <p className="system-notice">{notice}</p>
      </section>
      <form onSubmit={submit}>
        <label htmlFor="message">给桌宠发消息</label>
        <div className="input-row">
          <input id="message" value={text} onChange={event => setText(event.target.value)} />
          <button type="submit">发送</button>
        </div>
      </form>
    </main>
  );
}

function SettingsView() {
  return (
    <main className="panel settings-panel">
      <header><div><strong>Myself 设置</strong><span className="status">安全外壳</span></div></header>
      <section><h1>模型</h1><p>模型配置将在任务五接入加密存储。</p></section>
      <section><h2>文件权限</h2><p>文件工具只会访问你主动授权的一个目录。</p></section>
      <section><h2>本地数据</h2><p>密钥、任务摘要与清理操作将在后续任务接入。</p></section>
      <footer><button type="button" onClick={() => window.close()}>关闭设置</button></footer>
    </main>
  );
}

export function App() {
  const view = currentView();
  if (view === 'chat') return <ChatView />;
  if (view === 'settings') return <SettingsView />;
  return <PetView />;
}
