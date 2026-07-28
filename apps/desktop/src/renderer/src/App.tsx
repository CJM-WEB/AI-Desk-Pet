import { useEffect } from 'react';
import { ChatPanel } from './chat/ChatPanel';
import { PetView } from './pet/PetView';
import { SettingsView } from './settings/SettingsView';
import { taskEventSubscription } from './stores/task-store';
import type { MyselfApi } from '../../shared/myself-api';

type ViewName = 'pet' | 'chat' | 'settings' | 'characters';

export function currentView(): ViewName {
  const view = new URLSearchParams(window.location.search).get('view');
  if (view === 'chat' || view === 'settings' || view === 'characters') return view;
  return 'pet';
}

export function mountTaskEventsIfAvailable(api: MyselfApi | undefined) {
  if (!api) return undefined;
  return taskEventSubscription.mount(api);
}

export function App() {
  useEffect(() => mountTaskEventsIfAvailable(window.myself), []);
  const view = currentView();
  if (view === 'chat') return <ChatPanel />;
  if (view === 'settings') return <SettingsView />;
  if (view === 'characters') return <main className="character-workshop-root" />;
  return <PetView />;
}
