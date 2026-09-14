import { lazy, Suspense, useEffect } from 'react';
import { taskEventSubscription } from './stores/task-store';
import type { MyselfApi } from '../../shared/myself-api';

// 各窗口只求值自己的视图模块；加载期间保持透明，不增加产品占位内容。
const ChatPanel = lazy(() => import('./chat/ChatPanel').then(module => ({ default: module.ChatPanel })));
const ChatBubbleView = lazy(() => import('./chat/ChatBubbleView').then(module => ({ default: module.ChatBubbleView })));
const PetView = lazy(() => import('./pet/PetView').then(module => ({ default: module.PetView })));
const SettingsView = lazy(() => import('./settings/SettingsView').then(module => ({ default: module.SettingsView })));
const CharacterWorkshopView = lazy(() => import('./characters/workshop/CharacterWorkshopView')
  .then(module => ({ default: module.CharacterWorkshopView })));

type ViewName = 'pet' | 'chat' | 'bubble' | 'settings' | 'characters';

export function currentView(): ViewName {
  const view = new URLSearchParams(window.location.search).get('view');
  if (view === 'chat' || view === 'bubble' || view === 'settings' || view === 'characters') return view;
  return 'pet';
}

export function mountTaskEventsIfAvailable(api: MyselfApi | undefined, restoreConversation = false) {
  if (!api) return undefined;
  return taskEventSubscription.mount(api, restoreConversation);
}

export function App() {
  const view = currentView();
  // 头顶窗口只有展示快照，不能参与原任务订阅与会话恢复。
  useEffect(() => view === 'bubble' ? undefined : mountTaskEventsIfAvailable(window.myself, view === 'chat'), [view]);
  const content = view === 'bubble' ? <ChatBubbleView />
    : view === 'chat' ? <ChatPanel />
    : view === 'settings' ? <SettingsView />
    : view === 'characters' ? <CharacterWorkshopView api={window.myself} />
    : <PetView />;
  return <Suspense fallback={null}>{content}</Suspense>;
}
