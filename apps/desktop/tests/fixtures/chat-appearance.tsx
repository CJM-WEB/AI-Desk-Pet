import { createRoot } from 'react-dom/client';
import { ChatIsland } from '../../src/renderer/src/chat/ChatIsland';
import { ChatBubbleView } from '../../src/renderer/src/chat/ChatBubbleView';
import type { ChatPresentationApi, ChatPresentationSnapshot } from '../../src/shared/chat-presentation';
import '../../src/renderer/src/chat/chat-presentation.css';

// 只渲染正式展示组件与合成正文，不启动 Provider、会话存储或文件任务。
let receive: ((snapshot: ChatPresentationSnapshot) => void) | undefined;
let revision = 0;
const api = {
  ready: async () => ({ epoch: 'appearance', revisionFloor: 0 }),
  onCommand: () => () => undefined,
  onSnapshot: (listener: typeof receive) => { receive = listener; return () => { receive = undefined; }; },
  setLayout: async () => undefined,
  dispatch: async () => undefined
} as unknown as ChatPresentationApi;
Reflect.set(window, 'appearanceReply', (text: string) => receive?.({
  epoch: 'appearance', revision: ++revision, conversationRevision: 0,
  reply: { id: 'appearance-reply', text }, confirmation: null
}));
const bubble = location.hash === '#bubble';
createRoot(document.getElementById('root')!).render(bubble ? <ChatBubbleView api={api} /> : <ChatIsland
  history={<div className="messages">{Array.from({ length: 14 }, (_, index) => <article key={index}
    className={`message ${index % 2 ? 'message-user' : 'message-assistant'}`}>
    <p>{index % 2 ? '这是一条合成问题。' : '这是一条用于检查透明背景和阴影的合成回复。'}</p>
  </article>)}</div>}
  input={<textarea aria-label="合成输入" placeholder="和我说点什么…" />}
  send={<button aria-label="发送">↑</button>}
  busy={false} onNewConversation={() => undefined} onSettings={() => undefined} />);
