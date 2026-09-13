import { CHARACTER_TRANSIENT_DURATION_MS } from '@myself/character-runtime';
import {
  type TaskPermissionRequiredEvent,
  type CapabilityAuthorizationRequiredEvent,
  type TaskEvent,
  type TaskPhase
} from '@myself/shared-types';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  conversationTranscriptSnapshotSchema,
  emptyConversationTranscript,
  reduceConversationTranscript,
  type ConversationTranscriptMessage,
  type ConversationTranscriptSnapshot
} from '../../../shared/conversation-transcript';

export type TaskViewMessage = ConversationTranscriptMessage;

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
  persistenceError: ConversationTranscriptSnapshot['persistenceError'] | null;
  pendingPermissions: TaskPermissionRequiredEvent[];
  completeTaskPermission(actionId: string): void;
  pendingHistoryDisclosure: PendingHistoryDisclosure | null;
  pendingCapabilityAuthorization: PendingCapabilityAuthorization | null;
  resolvingHistoryDisclosureRequestId: string | null;
  characterState: { stateId: string; source: 'main' };
  applyCharacterPlayback(stateId: string): void;
  apply(event: TaskEvent): void;
  restoreTranscript(snapshot: ConversationTranscriptSnapshot): void;
  beginHistoryDisclosureResolution(requestId: string): boolean;
  releaseHistoryDisclosureResolution(requestId: string): void;
  completeHistoryDisclosure(requestId: string): void;
  completeCapabilityAuthorization(requestId: string): void;
  beginListening(): void;

}

function terminalPhase(phase: TaskPhase): boolean {
  return phase === 'success' || phase === 'error' || phase === 'cancelled' || phase === 'idle';
}

export function createTaskStore(): StoreApi<TaskViewState> {
  let transcript = emptyConversationTranscript();
  let transientTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTransientTimer = (): void => {
    if (transientTimer !== null) clearTimeout(transientTimer);
    transientTimer = null;
  };

  const store = createStore<TaskViewState>((set, get) => ({
    conversationRevision: 0,
    phase: 'idle',
    messages: [],
    persistenceError: null,
    pendingPermissions: [],
    pendingHistoryDisclosure: null,
    pendingCapabilityAuthorization: null,
    resolvingHistoryDisclosureRequestId: null,
    characterState: { stateId: 'idle', source: 'main' },
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
    applyCharacterPlayback: stateId => set({ characterState: { stateId, source: 'main' } }),
    restoreTranscript: snapshot => {
      const { persistenceError, ...restored } = conversationTranscriptSnapshotSchema.parse(snapshot);
      transcript = restored;
      set({ messages: transcript.messages, persistenceError: persistenceError ?? null });
    },
    apply: event => {
      const next = reduceConversationTranscript(transcript, event);
      if (next !== transcript) { transcript = next; set({ messages: next.messages }); }
      if (event.type === 'message' || event.type === 'assistant_message_start'
        || event.type === 'assistant_message_delta' || event.type === 'assistant_message_commit') return;
      if (event.type === 'character_emotion') return;
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
        // 配置失效同样撤销交互 owner，但只有明确新对话清空已提交正文。
        clearTransientTimer();
        set(state => ({
          conversationRevision: state.conversationRevision + 1,
          phase: 'idle',
          ...(event.preserveMessages ? {} : { persistenceError: null }),
          pendingPermissions: [],
          pendingHistoryDisclosure: null,
          pendingCapabilityAuthorization: null,
          resolvingHistoryDisclosureRequestId: null,
          characterState: { stateId: 'idle', source: 'main' }
        }));
        return;
      }
      if (event.type === 'error') {
        set(state => ({
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
      clearTransientTimer();
      const phase = event.phase;
      const resolvingDisclosureFailed = phase === 'error'
        && get().resolvingHistoryDisclosureRequestId !== null
        && get().pendingHistoryDisclosure?.requestId
          === get().resolvingHistoryDisclosureRequestId;
      set({
        phase,
        ...(resolvingDisclosureFailed
          ? {
              pendingHistoryDisclosure: null,
              resolvingHistoryDisclosureRequestId: null
            }
          : {}),
        ...(terminalPhase(phase)
          ? { pendingPermissions: [], pendingCapabilityAuthorization: null }
          : {})
      });
      if (phase === 'success' || phase === 'error') {
        transientTimer = setTimeout(() => {
          if (get().phase === phase) {
            set({ phase: 'idle' });
          }
          transientTimer = null;
        }, CHARACTER_TRANSIENT_DURATION_MS);
      }
    },
    beginListening: () => {
      clearTransientTimer();
      set({ phase: 'listening', pendingPermissions: [] });
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
  onConversationSnapshot?(listener: (snapshot: ConversationTranscriptSnapshot) => void): () => void;
  restoreConversation?(): Promise<void>;
}

export function createTaskEventSubscription(store: StoreApi<TaskViewState>) {
  let subscribers = 0;
  let release: (() => void) | null = null;
  let releaseSnapshot: (() => void) | null = null;
  let restoreSequence = 0;

  return {
    mount(api: TaskEventApi, restoreConversation = false): () => void {
      subscribers += 1;
      if (!release) release = api.onTaskEvent(event => store.getState().apply(event));
      if (restoreConversation && !releaseSnapshot && api.onConversationSnapshot && api.restoreConversation) {
        // 先订阅再请求；Main 按事件发送顺序推送快照，invoke 的迟到确认不写视图。
        const owner = ++restoreSequence;
        const revision = store.getState().conversationRevision;
        releaseSnapshot = api.onConversationSnapshot(snapshot => store.getState().restoreTranscript(snapshot));
        void api.restoreConversation().catch(() => {
          if (owner !== restoreSequence || revision !== store.getState().conversationRevision) return;
          store.setState({ persistenceError: 'CONVERSATION_LOAD_FAILED' });
        });
      }
      let mounted = true;
      return () => {
        if (!mounted) return;
        mounted = false;
        subscribers -= 1;
        if (subscribers === 0 && release) {
          release();
          release = null;
          releaseSnapshot?.();
          releaseSnapshot = null;
          restoreSequence += 1;
        }
      };
    }
  };
}

export const taskEventSubscription = createTaskEventSubscription(taskStore);
