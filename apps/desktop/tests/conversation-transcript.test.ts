import { describe, expect, test } from 'vitest';
import { ASSISTANT_STREAM_TEXT_MAX_CHARACTERS } from '@myself/shared-types';
import {
  conversationTranscriptSnapshotSchema,
  emptyConversationTranscript,
  reduceConversationTranscript
} from '../src/shared/conversation-transcript';

describe('当前对话统一正文归并', () => {
  test('正式提交替换流式占位，重复提交与迟到增量不产生重复正文', () => {
    let state = emptyConversationTranscript();
    state = reduceConversationTranscript(state, { type: 'message', role: 'user', text: '你好' });
    state = reduceConversationTranscript(state, { type: 'assistant_message_start', turnId: 'turn-1' });
    state = reduceConversationTranscript(state, { type: 'assistant_message_delta', turnId: 'turn-1', delta: '你' });
    state = reduceConversationTranscript(state, { type: 'assistant_message_commit', turnId: 'turn-1', text: '你好呀' });
    state = reduceConversationTranscript(state, { type: 'assistant_message_commit', turnId: 'turn-1', text: '重复' });
    state = reduceConversationTranscript(state, { type: 'assistant_message_delta', turnId: 'turn-1', delta: '迟到' });
    expect(state.messages.map(message => [message.role, message.text])).toEqual([
      ['user', '你好'], ['assistant', '你好呀']
    ]);
    expect(state.activeAssistantStreamTurnId).toBeNull();
  });

  test('终态移除未提交片段，错误提示保留且重置后旧流不能复活', () => {
    let state = emptyConversationTranscript();
    state = reduceConversationTranscript(state, { type: 'assistant_message_start', turnId: 'old' });
    state = reduceConversationTranscript(state, { type: 'assistant_message_delta', turnId: 'old', delta: '未完成' });
    state = reduceConversationTranscript(state, { type: 'error', code: 'REQUEST_FAILED', message: '请重试', nextAction: '重新发送' });
    expect(state.messages).toEqual([{ id: 'message-1', role: 'error', text: '请重试', code: 'REQUEST_FAILED', nextAction: '重新发送' }]);
    state = reduceConversationTranscript(state, { type: 'conversation_reset', generation: 'new' });
    state = reduceConversationTranscript(state, { type: 'assistant_message_commit', turnId: 'old', text: '旧回复' });
    expect(state.messages).toEqual([]);
    state = reduceConversationTranscript(state, { type: 'assistant_message_start', turnId: 'next' });
    state = reduceConversationTranscript(state, { type: 'phase', phase: 'cancelled' });
    expect(state.messages).toEqual([]);
  });

  test('完整记录超过原百条裁剪后仍保留，越界流式正文被丢弃', () => {
    let state = emptyConversationTranscript();
    for (let index = 0; index < 105; index += 1) {
      state = reduceConversationTranscript(state, { type: 'message', role: 'user', text: `消息${index}` });
    }
    expect(state.messages).toHaveLength(105);
    expect(state.messages[0]?.text).toBe('消息0');
    state = reduceConversationTranscript(state, { type: 'assistant_message_start', turnId: 'oversize' });
    state = reduceConversationTranscript(state, { type: 'assistant_message_delta', turnId: 'oversize', delta: '字'.repeat(ASSISTANT_STREAM_TEXT_MAX_CHARACTERS + 1) });
    expect(state.messages).toHaveLength(105);
    expect(state.activeAssistantStreamTurnId).toBeNull();
  });

  test('快照拒绝授权数据、重复消息标识和无对应占位的活动流', () => {
    expect(conversationTranscriptSnapshotSchema.safeParse({ ...emptyConversationTranscript(), permissions: ['old'] }).success).toBe(false);
    expect(conversationTranscriptSnapshotSchema.safeParse({
      ...emptyConversationTranscript(),
      messages: [{ id: 'same', role: 'user', text: '甲' }, { id: 'same', role: 'assistant', text: '乙' }]
    }).success).toBe(false);
    expect(conversationTranscriptSnapshotSchema.safeParse({ ...emptyConversationTranscript(), activeAssistantStreamTurnId: 'missing' }).success).toBe(false);
  });

  test('配置失效重置保留已提交文字，仅退休未提交流', () => {
    let state = emptyConversationTranscript();
    state = reduceConversationTranscript(state, { type: 'message', role: 'user', text: '保留正文' });
    state = reduceConversationTranscript(state, { type: 'assistant_message_start', turnId: 'old' });
    state = reduceConversationTranscript(state, { type: 'assistant_message_delta', turnId: 'old', delta: '未完成' });
    state = reduceConversationTranscript(state, { type: 'conversation_reset', generation: 'new', preserveMessages: true });
    expect(state.messages.map(message => message.text)).toEqual(['保留正文']);
    expect(state.activeAssistantStreamTurnId).toBeNull();
  });
});
