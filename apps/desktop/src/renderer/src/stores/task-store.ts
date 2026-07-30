import {
  CHARACTER_TRANSIENT_DURATION_MS,
  reduceCharacterState,
  type CharacterStateRequest,
  type CharacterStateSnapshot
} from '@myself/character-runtime';
import type { PendingAction, TaskEvent, TaskPhase } from '@myself/shared-types';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  ExtensionTriggerController,
  type ExtensionPointerTrigger,
  type ExtensionTriggerDefinition
} from '../characters/player/extension-trigger-controller';

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
  characterState: CharacterStateSnapshot;
  apply(event: TaskEvent): void;
  beginListening(): void;
  requestCharacterState(request: CharacterStateRequest): void;
  configureCharacterExtensions(definitions: readonly ExtensionTriggerDefinition[]): void;
  triggerCharacterPointer(trigger: ExtensionPointerTrigger): void;
  triggerCharacterIdle(): void;
  applyCharacterMotion(input: { moving: boolean; carrying: boolean }): void;
}

function terminalPhase(phase: TaskPhase): boolean {
  return phase === 'success' || phase === 'error' || phase === 'cancelled' || phase === 'idle';
}

export function createTaskStore(): StoreApi<TaskViewState> {
  let nextMessageId = 0;
  let transientTimer: ReturnType<typeof setTimeout> | null = null;
  let extensionController = new ExtensionTriggerController([]);
  let pendingEmotionRequest: CharacterStateRequest | null = null;

  const clearTransientTimer = (): void => {
    if (transientTimer !== null) clearTimeout(transientTimer);
    transientTimer = null;
  };

  const store = createStore<TaskViewState>((set, get) => ({
    phase: 'idle',
    messages: [],
    pendingAction: null,
    characterState: { stateId: 'idle', source: 'system' },
    requestCharacterState: request => {
      set(state => ({
        characterState: reduceCharacterState(state.characterState, request)
      }));
    },
    configureCharacterExtensions: definitions => {
      extensionController = new ExtensionTriggerController(definitions);
      pendingEmotionRequest = null;
    },
    triggerCharacterPointer: trigger => {
      const request = extensionController.pointer(trigger);
      if (request) get().requestCharacterState(request);
    },
    triggerCharacterIdle: () => {
      const request = extensionController.idle();
      if (request) get().requestCharacterState(request);
    },
    applyCharacterMotion: input => {
      if (input.moving || input.carrying) {
        get().requestCharacterState({
          type: 'movement',
          carrying: input.carrying
        });
        return;
      }
      get().requestCharacterState({
        type: 'task',
        phase: get().phase
      });
    },
    apply: event => {
      if (event.type === 'message') {
        const message: TaskViewMessage = {
          id: `message-${++nextMessageId}`,
          role: event.role,
          text: event.text
        };
        set(state => ({ messages: [...state.messages, message].slice(-MAX_MESSAGES) }));
        if (event.role === 'user') {
          pendingEmotionRequest = null;
          const request = extensionController.keyword(event.text);
          if (request) get().requestCharacterState(request);
        }
        return;
      }
      if (event.type === 'character_emotion') {
        const request = extensionController.emotion(event.label);
        if (!request) return;
        if (get().phase === 'idle') {
          get().requestCharacterState(request);
        } else {
          pendingEmotionRequest = request;
        }
        return;
      }
      if (event.type === 'character_carrying') return;
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
        set(state => ({
          phase: 'awaiting_confirmation',
          pendingAction: event.action,
          characterState: reduceCharacterState(state.characterState, {
            type: 'task',
            phase: 'awaiting_confirmation'
          })
        }));
        return;
      }

      clearTransientTimer();
      const phase = event.phase;
      if (phase === 'thinking') pendingEmotionRequest = null;
      set({
        phase,
        characterState: reduceCharacterState(get().characterState, {
          type: 'task',
          phase
        }),
        ...(terminalPhase(phase) ? { pendingAction: null } : {})
      });
      if (phase === 'idle' && pendingEmotionRequest) {
        const request = pendingEmotionRequest;
        pendingEmotionRequest = null;
        get().requestCharacterState(request);
      }
      if (phase === 'success' || phase === 'error') {
        transientTimer = setTimeout(() => {
          if (get().phase === phase) {
            set(state => ({
              phase: 'idle',
              characterState: reduceCharacterState(state.characterState, {
                type: 'task',
                phase: 'idle'
              })
            }));
            if (pendingEmotionRequest) {
              const request = pendingEmotionRequest;
              pendingEmotionRequest = null;
              get().requestCharacterState(request);
            }
          }
          transientTimer = null;
        }, CHARACTER_TRANSIENT_DURATION_MS);
      }
    },
    beginListening: () => {
      clearTransientTimer();
      pendingEmotionRequest = null;
      set(state => ({
        phase: 'listening',
        pendingAction: null,
        characterState: reduceCharacterState(state.characterState, {
          type: 'task',
          phase: 'listening'
        })
      }));
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
