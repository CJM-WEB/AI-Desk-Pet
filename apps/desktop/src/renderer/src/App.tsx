import { useEffect } from 'react';
import { ChatPanel } from './chat/ChatPanel';
import { ChatBubbleView } from './chat/ChatBubbleView';
import { PetView } from './pet/PetView';
import { SettingsView } from './settings/SettingsView';
import { CharacterWorkshopView } from './characters/workshop/CharacterWorkshopView';
import { taskEventSubscription } from './stores/task-store';
import type { MyselfApi } from '../../shared/myself-api';

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
  if (view === 'bubble') return <ChatBubbleView />;
  if (view === 'chat') return <ChatPanel />;
  if (view === 'settings') return <SettingsView />;
  if (view === 'characters') return <CharacterWorkshopView api={window.myself} />;
  return <PetView />;
}
