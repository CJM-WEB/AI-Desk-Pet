import { describe, expect, test } from 'vitest';
import type { ToolDefinition } from '@myself/agent-core';
import { createOpenAIToolNameCodec } from '../src/main/providers/openai-tool-name-codec';

function definition(name: ToolDefinition['function']['name']): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: `${name} 测试工具`,
      parameters: { type: 'object', additionalProperties: false }
    }
  };
}

const definitions: ToolDefinition[] = [
  definition('builtin.files.delete_file'),
  definition('builtin.files.create_file'),
  definition('builtin.capability.request_clarification')
];

describe('OpenAI 工具名 Codec', () => {
  test('编码为 Provider 合法名称并支持双向映射', () => {
    const codec = createOpenAIToolNameCodec(definitions);
    const external = codec.encode('builtin.files.delete_file');

    expect(external).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
    expect(external).not.toContain('.');
    expect(codec.decode(external)).toBe('builtin.files.delete_file');
  });

  test('拒绝未知内部名与 Provider 名并返回稳定错误码', () => {
    const codec = createOpenAIToolNameCodec(definitions);

    expect(() => codec.encode('builtin.files.unknown')).toThrowError(
      expect.objectContaining({ code: 'OPENAI_TOOL_NAME_UNKNOWN_INTERNAL' })
    );
    expect(() => codec.decode('builtin_files_unknown')).toThrowError(
      expect.objectContaining({ code: 'OPENAI_TOOL_NAME_UNKNOWN_PROVIDER' })
    );
  });

  test('构造阶段拒绝编码碰撞与超长外部名', () => {
    expect(() => createOpenAIToolNameCodec([
      definition('builtin.files__a.b'),
      definition('builtin.files.a.b')
    ])).toThrowError(
      expect.objectContaining({ code: 'OPENAI_TOOL_NAME_COLLISION' })
    );

    const longName = `builtin.${'a'.repeat(30)}.${'b'.repeat(30)}` as ToolDefinition['function']['name'];
    expect(() => createOpenAIToolNameCodec([definition(longName)])).toThrowError(
      expect.objectContaining({ code: 'OPENAI_TOOL_NAME_TOO_LONG' })
    );
  });

  test('调用者修改原 definitions 后既有映射保持不变', () => {
    const callerDefinitions = definitions.map(definitionValue => structuredClone(definitionValue));
    const codec = createOpenAIToolNameCodec(callerDefinitions);
    const external = codec.encode('builtin.files.delete_file');
    callerDefinitions[0]!.function.name = 'builtin.files.changed_file';

    expect(codec.encode('builtin.files.delete_file')).toBe(external);
    expect(codec.decode(external)).toBe('builtin.files.delete_file');
  });
});
