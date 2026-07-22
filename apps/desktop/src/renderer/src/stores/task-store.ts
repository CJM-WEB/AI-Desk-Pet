import { CHARACTER_TRANSIENT_DURATION_MS } from '@myself/character-runtime';
import type { PendingAction, TaskEvent, TaskPhase } from '@myself/shared-types';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

const MAX_MESSAGES = 100;

export type TaskViewMessage = {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  nextAction?: string;
};

export interface TaskViewState {
  phase: TaskPhase;
  messages: TaskViewMessage[];
  pendingAction: PendingAction | null;
  apply(event: TaskEvent): void;
  beginListening(): void;
}

function terminalPhase(phase: TaskPhase): boolean {
  return phase === 'success' || phase === 'error' || phase === 'cancelled' || phase === 'idle';
}

export function createTaskStore(): StoreApi<TaskViewState> {
  let nextMessageId = 0;
  let transientTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTransientTimer = (): void => {
    if (transientTimer !== null) clearTimeout(transientTimer);
    transientTimer = null;
  };

  const store = createStore<TaskViewState>((set, get) => ({
    phase: 'idle',
    messages: [],
    pendingAction: null,
    apply: event => {
      if (event.type === 'message') {
        const message: TaskViewMessage = {
          id: `message-${++nextMessageId}`,
          role: event.role,
          text: event.text
        };
        set(state => ({ messages: [...state.messages, message].slice(-MAX_MESSAGES) }));
        return;
      }
      if (event.type === 'error') {
        const message: TaskViewMessage = {
          id: `message-${++nextMessageId}`,
          role: 'error',
          text: event.message,
          ...(event.nextAction ? { nextAction: event.nextAction } : {})
        };
        set(state => ({ messages: [...state.messages, message].slice(-MAX_MESSAGES) }));
        return;
      }
      if (event.type === 'pending_action') {
        clearTransientTimer();
        set({ phase: 'awaiting_confirmation', pendingAction: event.action });
        return;
      }

      clearTransientTimer();
      const phase = event.phase;
      set({
        phase,
        ...(terminalPhase(phase) ? { pendingAction: null } : {})
      });
      if (phase === 'success' || phase === 'error') {
        transientTimer = setTimeout(() => {
          if (get().phase === phase) set({ phase: 'idle' });
          transientTimer = null;
        }, CHARACTER_TRANSIENT_DURATION_MS);
      }
    },
    beginListening: () => {
      clearTransientTimer();
      set({ phase: 'listening', pendingAction: null });
    }
  }));

  return store;
}

export const taskStore = createTaskStore();

export function useTaskStore<T>(selector: (state: TaskViewState) => T): T {
  return useStore(taskStore, selector);
}

interface TaskEventApi {
  onTaskEvent(listener: (event: TaskEvent) => void): () => void;
}

export function createTaskEventSubscription(store: StoreApi<TaskViewState>) {
  let subscribers = 0;
  let release: (() => void) | null = null;

  return {
    mount(api: TaskEventApi): () => void {
      subscribers += 1;
      if (!release) release = api.onTaskEvent(event => store.getState().apply(event));
      let mounted = true;
      return () => {
        if (!mounted) return;
        mounted = false;
        subscribers -= 1;
        if (subscribers === 0 && release) {
          release();
          release = null;
        }
      };
    }
  };
}

export const taskEventSubscription = createTaskEventSubscription(taskStore);
