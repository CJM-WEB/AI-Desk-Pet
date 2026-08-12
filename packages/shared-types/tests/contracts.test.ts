import { describe, expect, it } from 'vitest';
import {
  pendingActionSchema,
  providerProfileV2Schema,
  taskEventSchema,
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

describe('PendingAction 契约', () => {
  it('以文件类别严格判别三种公开确认动作', () => {
    const create = pendingActionSchema.parse({
      category: 'file',
      actionId: 'act-1',
      conversationId: 'conv-1',
      risk: 'write',
      operation: 'create_file',
      summary: '新建 notes.md',
      targetRelativePath: 'notes.md',
      contentCharacters: 3,
      contentPreview: 'abc',
      previewTruncated: false,
      createdAt: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-20T00:02:00.000Z'
    });

    expect(create).toMatchObject({ category: 'file', operation: 'create_file' });
    expect(pendingActionSchema.parse({
      category: 'file',
      actionId: 'act-2',
      conversationId: 'conv-1',
      risk: 'write',
      operation: 'apply_patch',
      summary: '修改 notes.md',
      targetRelativePath: 'notes.md',
      addedLines: 2,
      removedLines: 1,
      diffPreview: '@@ -1 +1 @@',
      previewTruncated: false,
      createdAt: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-20T00:02:00.000Z'
    })).toMatchObject({ operation: 'apply_patch', addedLines: 2, removedLines: 1 });
    expect(pendingActionSchema.parse({
      category: 'file',
      actionId: 'act-3',
      conversationId: 'conv-1',
      risk: 'write',
      operation: 'delete_file',
      summary: '删除 notes.md',
      targetRelativePath: 'notes.md',
      targetType: 'file',
      createdAt: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-20T00:02:00.000Z'
    })).toMatchObject({ operation: 'delete_file', targetType: 'file' });
    expect(pendingActionSchema.parse({
      category: 'powershell',
      actionId: 'act-4',
      conversationId: 'conv-1',
      risk: 'shell',
      operation: 'powershell',
      summary: '运行 PowerShell 命令',
      command: 'Get-ChildItem',
      workingDirectoryLabel: '项目目录',
      runMode: 'foreground',
      createdAt: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-20T00:02:00.000Z'
    })).toMatchObject({ category: 'powershell', operation: 'powershell' });
  });

  it('拒绝旧分支、跨分支字段和多余字段', () => {
    const base = {
      category: 'file',
      actionId: 'act-1',
      conversationId: 'conv-1',
      risk: 'write',
      operation: 'create_file',
      summary: '新建 notes.md',
      targetRelativePath: 'notes.md',
      contentCharacters: 3,
      contentPreview: 'abc',
      previewTruncated: false,
      createdAt: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-20T00:02:00.000Z'
    };

    expect(() => pendingActionSchema.parse(({ ...base, contentPreview: undefined }))).toThrow();
    expect(() => pendingActionSchema.parse({ ...base, operation: 'create_directory' })).toThrow();
    expect(() => pendingActionSchema.parse({ ...base, targetType: 'file' })).toThrow();
    expect(() => pendingActionSchema.parse({ ...base, command: 'rm notes.md' })).toThrow();
  });

  it.each([
    'C:\\Users\\Administrator\\workspace',
    '\\\\server\\share',
    '\\\\?\\C:\\workspace',
    '/workspace'
  ])('拒绝向 Renderer 发布绝对工作目录：%s', workingDirectoryLabel => {
    expect(() => pendingActionSchema.parse({
      category: 'powershell',
      actionId: 'act-shell',
      conversationId: 'conv-1',
      risk: 'shell',
      operation: 'powershell',
      summary: '运行 PowerShell 命令',
      command: 'Get-ChildItem',
      workingDirectoryLabel,
      runMode: 'foreground',
      createdAt: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-20T00:02:00.000Z'
    })).toThrow();
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

describe('taskEventSchema', () => {
  it('只接受严格的历史披露和会话重置事件', () => {
    expect(taskEventSchema.parse({
      type: 'history_disclosure_required',
      requestId: 'disclosure-1',
      targetProviderName: 'OpenAI',
      messageCount: 4,
      characterCount: 120
    })).toMatchObject({ type: 'history_disclosure_required' });

    expect(taskEventSchema.parse({
      type: 'conversation_reset',
      generation: 'generation-2'
    })).toMatchObject({ type: 'conversation_reset' });

    expect(() => taskEventSchema.parse({
      type: 'conversation_reset',
      generation: 'generation-2',
      history: ['不得进入 Renderer']
    })).toThrow();
  });

  it('拒绝披露事件中的负数和过长标识', () => {
    const event = {
      type: 'history_disclosure_required' as const,
      requestId: 'disclosure-1',
      targetProviderName: 'OpenAI',
      messageCount: 4,
      characterCount: 120
    };

    expect(() => taskEventSchema.parse({ ...event, messageCount: -1 })).toThrow();
    expect(() => taskEventSchema.parse({ ...event, characterCount: -1 })).toThrow();
    expect(() => taskEventSchema.parse({ ...event, requestId: 'a'.repeat(129) })).toThrow();
    expect(() => taskEventSchema.parse({ ...event, targetProviderName: 'a'.repeat(129) })).toThrow();
    expect(() => taskEventSchema.parse({
      type: 'conversation_reset',
      generation: 'a'.repeat(129)
    })).toThrow();
  });
});
