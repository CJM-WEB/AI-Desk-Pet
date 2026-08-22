import { describe, expect, test } from 'vitest';
import {
  decodeResponseContractText,
  type ModelResponseContract
} from '../src/response-contract';

const contract: ModelResponseContract = {
  type: 'json_object',
  name: 'character_chat',
  jsonSchema: { type: 'object' },
  textField: 'text',
  allowPlainTextFallback: true
};

describe('无权限响应协议解码', () => {
  test('完整对象保留正文和结构化输出', () => {
    expect(decodeResponseContractText(
      '{"text":"你好呀","behaviorPlan":{"kind":"none"}}',
      contract
    )).toEqual({
      kind: 'structured',
      text: '你好呀',
      structured_output: { text: '你好呀', behaviorPlan: { kind: 'none' } }
    });
  });

  test('截断 JSON 只恢复已经闭合的正文', () => {
    expect(decodeResponseContractText(
      '{"text":"保留正文","behaviorPlan":',
      contract
    )).toEqual({ kind: 'structured', text: '保留正文', structured_output: { text: '保留正文' } });
  });

  test('普通纯文本走有界兼容分支', () => {
    expect(decodeResponseContractText('普通纯文本', contract)).toEqual({
      kind: 'plain_text',
      text: '普通纯文本'
    });
  });

  test.each(['{}', '   ', '{"behaviorPlan":'])('无法恢复正文时拒绝 %j', raw => {
    expect(decodeResponseContractText(raw, contract)).toEqual({ kind: 'invalid' });
  });
});
