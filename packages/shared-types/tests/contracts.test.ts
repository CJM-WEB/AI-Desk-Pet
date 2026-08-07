import { describe, expect, it } from 'vitest';
import {
  pendingActionSchema,
  providerProfileV2Schema,
  toolNameSchema,
  toolRequestSchema
} from '../src/contracts';

describe('toolRequestSchema', () => {
  it('接受合法命名空间工具名称', () => {
    const result = toolRequestSchema.parse({
      requestId: 'req-1',
      toolName: 'builtin.files.create_file',
      arguments: { relativePath: 'notes.md' }
    });

    expect(result.toolName).toBe('builtin.files.create_file');
  });

  it.each([
    'create_file',
    'builtin.files',
    'builtin.Files.create_file',
    'builtin.files.-create',
    'builtin.files..create_file',
    'other.files.create_file'
  ])('拒绝旧短名称或非法命名空间：%s', toolName => {
    expect(() => toolNameSchema.parse(toolName)).toThrow();
  });

  it('拒绝超过 128 个字符的工具名称', () => {
    expect(() => toolNameSchema.parse(`builtin.files.${'a'.repeat(116)}`)).toThrow();
  });

  it('拒绝模型附加本地权限元数据', () => {
    expect(() => toolRequestSchema.parse({
      requestId: 'req-2',
      toolName: 'builtin.files.create_file',
      arguments: { relativePath: 'notes.md' },
      risk: 'read'
    })).toThrow();
  });
});

describe('pendingActionSchema', () => {
  it('以严格操作字段判别四种公开确认动作', () => {
    const result = pendingActionSchema.parse({
      actionId: 'act-1',
      conversationId: 'conv-1',
      risk: 'write',
      operation: 'create_file',
      summary: '新建 notes.md',
      targetRelativePath: 'notes.md',
      createdAt: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-20T00:02:00.000Z'
    });

    expect(result.risk).toBe('write');
    expect(result).not.toHaveProperty('requestId');

    for (const operation of [
      'create_file',
      'create_directory',
      'rename_entry',
      'move_to_recycle_bin'
    ]) {
      expect(pendingActionSchema.parse({ ...result, operation }).operation).toBe(operation);
    }
  });

  it('拒绝缺失、未知操作和多余字段', () => {
    const base = {
      actionId: 'act-1',
      conversationId: 'conv-1',
      risk: 'write',
      operation: 'create_file',
      summary: '新建 notes.md',
      targetRelativePath: 'notes.md',
      createdAt: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-20T00:02:00.000Z'
    };

    expect(() => pendingActionSchema.parse(({ ...base, operation: undefined }))).toThrow();
    expect(() => pendingActionSchema.parse({ ...base, operation: 'delete_permanently' })).toThrow();
    expect(() => pendingActionSchema.parse({ ...base, command: 'rm notes.md' })).toThrow();
  });
});

describe('providerProfileV2Schema', () => {
  it('允许预置档案为目录外模型声明保守能力', () => {
    expect(providerProfileV2Schema.parse({
      id: 'openai-new',
      displayName: 'OpenAI 新模型',
      mode: 'preset',
      providerId: 'openai',
      modelId: 'new-model-id',
      capabilities: ['chat'],
      hasStoredSecret: true
    })).toMatchObject({
      modelId: 'new-model-id',
      capabilities: ['chat']
    });
  });
});
