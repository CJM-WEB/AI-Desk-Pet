import {
  CHARACTER_TRANSIENT_DURATION_MS,
  reduceCharacterState,
  type CharacterStateRequest,
  type CharacterStateSnapshot
} from '@myself/character-runtime';
import {
  ASSISTANT_STREAM_TEXT_MAX_CHARACTERS,
  ASSISTANT_STREAM_TURN_ID_MAX_CHARACTERS,
  type PendingAction,
  type TaskPermissionRequiredEvent,
  type CapabilityAuthorizationRequiredEvent,
  type TaskEvent,
  type TaskPhase
} from '@myself/shared-types';
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
  code?: string;
  nextAction?: string;
};

export type PendingHistoryDisclosure = Readonly<{
  requestId: string;
  targetProviderName: string;
  messageCount: number;
  characterCount: number;
}>;

export type PendingCapabilityAuthorization = Omit<CapabilityAuthorizationRequiredEvent, 'type'>;

export interface TaskViewState {
  conversationRevision: number;
  phase: TaskPhase;
  messages: TaskViewMessage[];
  pendingAction: PendingAction | null;
  pendingPermissions: TaskPermissionRequiredEvent[];
  completeTaskPermission(actionId: string): void;
  pendingHistoryDisclosure: PendingHistoryDisclosure | null;
  pendingCapabilityAuthorization: PendingCapabilityAuthorization | null;
  resolvingHistoryDisclosureRequestId: string | null;
  characterState: CharacterStateSnapshot;
  apply(event: TaskEvent): void;
  beginHistoryDisclosureResolution(requestId: string): boolean;
  releaseHistoryDisclosureResolution(requestId: string): void;
  completeHistoryDisclosure(requestId: string): void;
  completeCapabilityAuthorization(requestId: string): void;
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
  let activeAssistantStreamTurnId: string | null = null;

  const streamMessageId = (turnId: string): string => `assistant-stream-${turnId}`;

  const clearTransientTimer = (): void => {
    if (transientTimer !== null) clearTimeout(transientTimer);
    transientTimer = null;
  };

  const store = createStore<TaskViewState>((set, get) => ({
    conversationRevision: 0,
    phase: 'idle',
    messages: [],
    pendingAction: null,
    pendingPermissions: [],
    pendingHistoryDisclosure: null,
    pendingCapabilityAuthorization: null,
    resolvingHistoryDisclosureRequestId: null,
    characterState: { stateId: 'idle', source: 'system' },
    completeTaskPermission: actionId => set(state => ({ pendingPermissions: state.pendingPermissions.filter(item => item.actionId !== actionId) })),
    beginHistoryDisclosureResolution: requestId => {
      let began = false;
      set(state => {
        if (state.pendingHistoryDisclosure?.requestId !== requestId
          || state.resolvingHistoryDisclosureRequestId !== null) return state;
        began = true;
        return { resolvingHistoryDisclosureRequestId: requestId };
      });
      return began;
    },
    releaseHistoryDisclosureResolution: requestId => {
      set(state => state.resolvingHistoryDisclosureRequestId === requestId
        ? { resolvingHistoryDisclosureRequestId: null }
        : state);
    },
    completeHistoryDisclosure: requestId => {
      set(state => state.pendingHistoryDisclosure?.requestId === requestId
        ? {
            pendingHistoryDisclosure: null,
            resolvingHistoryDisclosureRequestId: null
          }
        : state);
    },
    completeCapabilityAuthorization: requestId => {
      set(state => state.pendingCapabilityAuthorization?.requestId === requestId
        ? { pendingCapabilityAuthorization: null }
        : state);
    },
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
      if (event.type === 'assistant_message_start') {
        if (event.turnId.length > ASSISTANT_STREAM_TURN_ID_MAX_CHARACTERS) return;
        const previousId = activeAssistantStreamTurnId === null
          ? null
          : streamMessageId(activeAssistantStreamTurnId);
        activeAssistantStreamTurnId = event.turnId;
        const message: TaskViewMessage = {
          id: streamMessageId(event.turnId),
          role: 'assistant',
          text: ''
        };
        set(state => ({
          messages: [
            ...state.messages.filter(item => item.id !== previousId && item.id !== message.id),
            message
          ].slice(-MAX_MESSAGES)
        }));
        return;
      }
      if (event.type === 'assistant_message_delta') {
        if (activeAssistantStreamTurnId !== event.turnId) return;
        const id = streamMessageId(event.turnId);
        const current = get().messages.find(message => message.id === id);
        if (
          current === undefined
          || current.text.length + event.delta.length > ASSISTANT_STREAM_TEXT_MAX_CHARACTERS
        ) {
          activeAssistantStreamTurnId = null;
          set(state => ({ messages: state.messages.filter(message => message.id !== id) }));
          return;
        }
        set(state => ({
          messages: state.messages.map(message => message.id === id
            ? { ...message, text: `${message.text}${event.delta}` }
            : message)
        }));
        return;
      }
      if (event.type === 'assistant_message_commit') {
        if (activeAssistantStreamTurnId !== event.turnId) return;
        activeAssistantStreamTurnId = null;
        const id = streamMessageId(event.turnId);
        if (event.text.length > ASSISTANT_STREAM_TEXT_MAX_CHARACTERS) {
          set(state => ({ messages: state.messages.filter(message => message.id !== id) }));
          return;
        }
        set(state => ({
          messages: state.messages.map(message => message.id === id
            ? { ...message, text: event.text }
            : message)
        }));
        return;
      }
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
      if (event.type === 'history_disclosure_required') {
        // 同一时刻只展示一个由 Main 签发的请求，后到事件不能替换用户正在决策的卡片。
        if (get().pendingHistoryDisclosure) {
          console.warn('HISTORY_DISCLOSURE_ALREADY_PENDING');
          return;
        }
        set({
          pendingHistoryDisclosure: Object.freeze({
            requestId: event.requestId,
            targetProviderName: event.targetProviderName,
            messageCount: event.messageCount,
            characterCount: event.characterCount
          })
        });
        return;
      }
      if (event.type === 'capability_authorization_required') {
        if (get().pendingCapabilityAuthorization) return;
        set({
          pendingCapabilityAuthorization: Object.freeze({
            requestId: event.requestId,
            capability: event.capability,
            requestSummary: event.requestSummary,
            targetProviderName: event.targetProviderName,
            directory: event.directory, modelId: event.modelId, actions: event.actions, approvedCommands: event.approvedCommands,
            expiresAt: event.expiresAt
          })
        });
        return;
      }
      if (event.type === 'conversation_reset') {
        // reset 事件是 Renderer 清空当前会话状态的唯一事实来源。
        clearTransientTimer();
        pendingEmotionRequest = null;
        activeAssistantStreamTurnId = null;
        set(state => ({
          conversationRevision: state.conversationRevision + 1,
          phase: 'idle',
          messages: [],
          pendingAction: null,
    pendingPermissions: [],
          pendingHistoryDisclosure: null,
          pendingCapabilityAuthorization: null,
          resolvingHistoryDisclosureRequestId: null,
          characterState: { stateId: 'idle', source: 'system' }
        }));
        return;
      }
      if (event.type === 'error') {
        const activeStreamId = activeAssistantStreamTurnId === null
          ? null
          : streamMessageId(activeAssistantStreamTurnId);
        activeAssistantStreamTurnId = null;
        const message: TaskViewMessage = {
          id: `message-${++nextMessageId}`,
          role: 'error',
          text: event.message,
          code: event.code,
          ...(event.nextAction ? { nextAction: event.nextAction } : {})
        };
        set(state => ({
          messages: [
            ...state.messages.filter(item => item.id !== activeStreamId),
            message
          ].slice(-MAX_MESSAGES),
          pendingCapabilityAuthorization: null,
          ...(state.resolvingHistoryDisclosureRequestId
            && state.pendingHistoryDisclosure?.requestId
              === state.resolvingHistoryDisclosureRequestId
            ? {
                pendingHistoryDisclosure: null,
                resolvingHistoryDisclosureRequestId: null
              }
            : {})
        }));
        return;
      }
      if (event.type === 'task_permission_required') {
        const pending = get().pendingPermissions;
        if (pending.some(item => item.actionId === event.actionId)) return;
        if (pending.length >= 16) {
          set({ phase: 'error', pendingPermissions: [] });
          return;
        }
        set({ phase: 'awaiting_confirmation', pendingPermissions: [...pending, event] });
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
      const activeStreamId = terminalPhase(phase) && activeAssistantStreamTurnId !== null
        ? streamMessageId(activeAssistantStreamTurnId)
        : null;
      if (terminalPhase(phase)) activeAssistantStreamTurnId = null;
      if (phase === 'thinking') pendingEmotionRequest = null;
      const resolvingDisclosureFailed = phase === 'error'
        && get().resolvingHistoryDisclosureRequestId !== null
        && get().pendingHistoryDisclosure?.requestId
          === get().resolvingHistoryDisclosureRequestId;
      set({
        phase,
        ...(activeStreamId === null
          ? {}
          : { messages: get().messages.filter(message => message.id !== activeStreamId) }),
        characterState: reduceCharacterState(get().characterState, {
          type: 'task',
          phase
        }),
        ...(resolvingDisclosureFailed
          ? {
              pendingHistoryDisclosure: null,
              resolvingHistoryDisclosureRequestId: null
            }
          : {}),
        ...(terminalPhase(phase)
          ? { pendingAction: null, pendingPermissions: [], pendingCapabilityAuthorization: null }
          : {})
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
    pendingPermissions: [],
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
