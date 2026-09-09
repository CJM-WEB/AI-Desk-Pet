import { describe, expect, test } from 'vitest';
import { decodeResponseContractText, type ModelResponseContract } from '../src/response-contract';
const contract: ModelResponseContract = { type: 'json_object', name: 'character_expression', jsonSchema: {},
  validateStructuredOutput: value => typeof value === 'object' && value !== null && Object.keys(value).join() === 'moodUpdate' && Reflect.get(value, 'moodUpdate') === null };
describe('独立表现信封解码', () => {
  test('完整有效表现只作为结构化输出返回', () => {
    expect(decodeResponseContractText('{"moodUpdate":null}', contract)).toEqual({ kind: 'structured_only', structured_output: { moodUpdate: null } });
  });
  test('退役联合协议即使由运行期旧调用传入也不得恢复正文', () => {
    const legacy = { ...contract, name: 'character_chat', textField: 'text', allowPlainTextFallback: true } as unknown as ModelResponseContract;
    expect(decodeResponseContractText('{"text":"旧正文"}', legacy)).toEqual({ kind: 'invalid' });
  });
  test.each(['普通正文', '{"text":"截断正文",', '[]', '{}', '{"moodUpdate":null,"extra":true}', ' '])('无效信封不恢复正文：%s', raw => {
    expect(decodeResponseContractText(raw, contract)).toEqual({ kind: 'invalid' });
  });
  test('按UTF-8字节限制表现响应，避免多字节内容绕过预算', () => {
    expect(decodeResponseContractText(JSON.stringify({ moodUpdate: '中'.repeat(6000) }), { ...contract, validateStructuredOutput: () => true })).toEqual({ kind: 'invalid' });
  });
});
