import { describe, expect, test } from 'vitest';
import {
  ConversationHistory,
  type VisibleConversationTurn
} from '../src/main/conversation/conversation-history';

function turn(
  userText: string,
  assistantText: string,
  providerIdentity = 'provider:a'
): VisibleConversationTurn {
  return { userText, assistantText, providerIdentity };
}

describe('ConversationHistory', () => {
  test('按完整回合和 Unicode 字符上限裁剪最旧历史', () => {
    const history = new ConversationHistory({ maxTurns: 2, maxCharacters: 5 });
    history.append(turn('甲', '乙'));
    history.append(turn('丙', '丁'));
    history.append(turn('🐾🐾', '戊', 'provider:b'));
    history.append(turn('己', '庚', 'provider:b'));

    expect(history.turns()).toEqual([
      turn('🐾🐾', '戊', 'provider:b'),
      turn('己', '庚', 'provider:b')
    ]);
    expect(history.characterCount()).toBe(5);
    expect(history.itemCount()).toBe(4);
  });

  test('返回的回合和集合快照不可修改', () => {
    const history = new ConversationHistory();
    history.append(turn('你好', '你好呀', 'provider:a'));

    const turns = history.turns();
    const providers = history.sourceProviderIdentities();

    expect(Object.isFrozen(turns)).toBe(true);
    expect(Object.isFrozen(turns[0])).toBe(true);
    expect(() => {
      (turns as VisibleConversationTurn[]).push(turn('篡改', '篡改'));
    }).toThrow();
    expect(() => {
      (turns[0] as { userText: string }).userText = '篡改';
    }).toThrow();
    expect(Object.isFrozen(providers)).toBe(true);
    expect(() => {
      (providers as Set<string>).add('provider:forged');
    }).toThrow();
  });

  test('模型消息只包含用户和助手可见文本', () => {
    const history = new ConversationHistory();
    history.append(turn('用户文本', '助手文本'));

    expect(history.modelMessages()).toEqual([
      { role: 'user', content: '用户文本' },
      { role: 'assistant', content: '助手文本' }
    ]);

    const messages = history.modelMessages();
    expect(Object.isFrozen(messages)).toBe(true);
    expect(Object.isFrozen(messages[0])).toBe(true);
    expect(() => {
      messages.push({ role: 'user', content: '篡改' });
    }).toThrow();

    if (false) {
      // @ts-expect-error 可见历史不接受工具消息。
      history.append({ role: 'tool', content: '目录列表', toolCallId: 'call-1' });
    }
  });

  test('清空时移除全部内存历史与来源身份', () => {
    const history = new ConversationHistory();
    history.append(turn('用户', '助手', 'provider:a'));
    history.clear();

    expect(history.turns()).toEqual([]);
    expect(history.modelMessages()).toEqual([]);
    expect(history.itemCount()).toBe(0);
    expect(history.characterCount()).toBe(0);
    expect([...history.sourceProviderIdentities()]).toEqual([]);
  });

  test('拒绝超过当前有效上限的单回合且不截断文本', () => {
    const history = new ConversationHistory({ maxCharacters: 12 });
    const oversized = turn('六个字符文本', '七个字符文本！');

    expect(() => history.append(oversized)).toThrow('CONVERSATION_TURN_TOO_LARGE');
    expect(history.turns()).toEqual([]);
    expect(history.characterCount()).toBe(0);
  });

  test('拒绝会绕过容量边界的非有限配置', () => {
    expect(() => new ConversationHistory({ maxTurns: Number.NaN }))
      .toThrow('CONVERSATION_HISTORY_OPTIONS_INVALID');
    expect(() => new ConversationHistory({ maxCharacters: Number.NaN }))
      .toThrow('CONVERSATION_HISTORY_OPTIONS_INVALID');
  });

  test('将超过系统上限的回合配置裁剪为二十回合', () => {
    const history = new ConversationHistory({ maxTurns: 21 });
    for (let index = 1; index <= 21; index += 1) {
      history.append(turn(`用户${index}`, `助手${index}`));
    }

    expect(history.turns()).toHaveLength(20);
    expect(history.turns()[0]?.userText).toBe('用户2');
    expect(history.turns()[19]?.userText).toBe('用户21');
  });
});
