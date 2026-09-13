import {
  ASSISTANT_STREAM_TEXT_MAX_CHARACTERS,
  ASSISTANT_STREAM_TURN_ID_MAX_CHARACTERS,
  type TaskEvent
} from '@myself/shared-types';
import { z } from 'zod';

export const conversationTranscriptMessageSchema = z.object({
  id: z.string().min(1).max(ASSISTANT_STREAM_TURN_ID_MAX_CHARACTERS + 32),
  role: z.enum(['user', 'assistant', 'error']),
  text: z.string(),
  code: z.string().optional(),
  nextAction: z.string().optional()
}).strict();

const streamMessageId = (turnId: string): string => `assistant-stream-${turnId}`;

export const conversationTranscriptSnapshotSchema = z.object({
  messages: z.array(conversationTranscriptMessageSchema),
  activeAssistantStreamTurnId: z.string().min(1).max(ASSISTANT_STREAM_TURN_ID_MAX_CHARACTERS).nullable(),
  nextMessageId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  // 仅作为窗口提示投递；存储故障不属于任务失败，也不进入模型正文。
  persistenceError: z.enum(['CONVERSATION_LOAD_FAILED', 'CONVERSATION_SAVE_FAILED']).optional()
}).strict().superRefine((snapshot, context) => {
  const identifiers = new Set(snapshot.messages.map(message => message.id));
  if (identifiers.size !== snapshot.messages.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'CONVERSATION_MESSAGE_ID_DUPLICATE' });
  }
  if (snapshot.messages.some(message => /^message-\d+$/u.test(message.id)
    && Number(message.id.slice(8)) > snapshot.nextMessageId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'CONVERSATION_MESSAGE_SEQUENCE_INVALID' });
  }
  if (snapshot.activeAssistantStreamTurnId !== null && !snapshot.messages.some(message =>
    message.id === streamMessageId(snapshot.activeAssistantStreamTurnId!) && message.role === 'assistant')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'CONVERSATION_STREAM_MESSAGE_MISSING' });
  }
});

export type ConversationTranscriptMessage = z.infer<typeof conversationTranscriptMessageSchema>;
export type ConversationTranscriptSnapshot = z.infer<typeof conversationTranscriptSnapshotSchema>;

export function emptyConversationTranscript(): ConversationTranscriptSnapshot {
  return { messages: [], activeAssistantStreamTurnId: null, nextMessageId: 0 };
}

/** 未提交占位仅属于当前运行；退役时不把部分回复冒充正式消息。 */
export function committedConversationTranscript(snapshot: ConversationTranscriptSnapshot): ConversationTranscriptSnapshot {
  if (snapshot.activeAssistantStreamTurnId === null) return snapshot;
  const id = streamMessageId(snapshot.activeAssistantStreamTurnId);
  return { ...snapshot, messages: snapshot.messages.filter(message => message.id !== id), activeAssistantStreamTurnId: null };
}

/** Main 和 Renderer 共用唯一正文归并规则；任务阶段及许可仍由原运行链路管理。 */
export function reduceConversationTranscript(
  snapshot: ConversationTranscriptSnapshot,
  event: TaskEvent
): ConversationTranscriptSnapshot {
  if (event.type === 'conversation_reset') {
    return event.preserveMessages === true ? committedConversationTranscript(snapshot) : emptyConversationTranscript();
  }
  if (event.type === 'message' || event.type === 'error') {
    const current = event.type === 'error' ? committedConversationTranscript(snapshot) : snapshot;
    const nextMessageId = current.nextMessageId + 1;
    const message: ConversationTranscriptMessage = event.type === 'message'
      ? { id: `message-${nextMessageId}`, role: event.role, text: event.text }
      : { id: `message-${nextMessageId}`, role: 'error', text: event.message, code: event.code,
          ...(event.nextAction ? { nextAction: event.nextAction } : {}) };
    return { ...current, nextMessageId, messages: [...current.messages, message] };
  }
  if (event.type === 'assistant_message_start') {
    if (event.turnId.length === 0 || event.turnId.length > ASSISTANT_STREAM_TURN_ID_MAX_CHARACTERS) return snapshot;
    const current = committedConversationTranscript(snapshot);
    const id = streamMessageId(event.turnId);
    return {
      ...current,
      activeAssistantStreamTurnId: event.turnId,
      messages: [...current.messages.filter(message => message.id !== id), { id, role: 'assistant', text: '' }]
    };
  }
  if (event.type === 'assistant_message_delta' || event.type === 'assistant_message_commit') {
    if (snapshot.activeAssistantStreamTurnId !== event.turnId) return snapshot;
    const id = streamMessageId(event.turnId);
    const message = snapshot.messages.find(item => item.id === id);
    if (!message) return committedConversationTranscript(snapshot);
    const text = event.type === 'assistant_message_delta' ? message.text + event.delta : event.text;
    if (Array.from(text).length > ASSISTANT_STREAM_TEXT_MAX_CHARACTERS) return committedConversationTranscript(snapshot);
    return {
      ...snapshot,
      activeAssistantStreamTurnId: event.type === 'assistant_message_commit' ? null : event.turnId,
      messages: snapshot.messages.map(item => item.id === id ? { ...item, text } : item)
    };
  }
  // 从流式正文回到准备阶段时，原生工具申请不能留下未提交的普通回复。
  if (event.type === 'phase' && ['thinking', 'idle', 'success', 'error', 'cancelled'].includes(event.phase)) {
    return committedConversationTranscript(snapshot);
  }
  return snapshot;
}
