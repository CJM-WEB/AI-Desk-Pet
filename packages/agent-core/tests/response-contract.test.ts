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

  test.each([
    ['只有正文', '{"text":"只有正文"}', { text: '只有正文' }],
    [
      '非法隐藏控制字段',
      '{"text":"正文仍然有效","movementControl":{"kind":"move_once","target":{"x":1}}}',
      {
        text: '正文仍然有效',
        movementControl: { kind: 'move_once', target: { x: 1 } }
      }
    ]
  ] as const)('%s不影响顶层正文解码', (_name, raw, structuredOutput) => {
    expect(decodeResponseContractText(raw, contract)).toEqual({
      kind: 'structured',
      text: structuredOutput.text,
      structured_output: structuredOutput
    });
  });

  test('截断 JSON 只恢复已经闭合的正文', () => {
    expect(decodeResponseContractText(
      '{"text":"保留正文","behaviorPlan":',
      contract
    )).toEqual({ kind: 'structured', text: '保留正文', structured_output: { text: '保留正文' } });
  });

  test('截断 JSON 只有嵌套 text 时不恢复正文', () => {
    expect(decodeResponseContractText(
      '{"behaviorPlan":{"text":"不应恢复"},',
      contract
    )).toEqual({ kind: 'invalid' });
  });

  test('嵌套 text 在前时仍恢复完整的顶层正文', () => {
    expect(decodeResponseContractText(
      '{"behaviorPlan":{"text":"嵌套正文"},"text":"顶层正文","behaviorPlan":',
      contract
    )).toEqual({
      kind: 'structured',
      text: '顶层正文',
      structured_output: { text: '顶层正文' }
    });
  });

  test('完整 JSON 允许原始长度较大但解码正文未超限的 Unicode 转义', () => {
    const expectedText = '中'.repeat(4_000);
    const raw = `{"text":"${'\\u4e2d'.repeat(4_000)}"}`;
    const result = decodeResponseContractText(raw, contract);

    expect(raw.length).toBeGreaterThan(16_384);
    expect(result).toMatchObject({ kind: 'structured', text: expectedText });
  });

  test('超出截断扫描上限的响应仍拒绝恢复正文', () => {
    const raw = `{"text":"保留正文","behaviorPlan":{"padding":"${'x'.repeat(65_536)}`;

    expect(decodeResponseContractText(raw, contract)).toEqual({ kind: 'invalid' });
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
