import { describe, expect, it } from 'vitest';
import {
  pendingActionSchema,
  publicSettingsSchema,
  providerProfileV2Schema,
  taskEventSchema,
  toolNameSchema,
  toolRequestSchema
} from '../src/contracts';

describe('正式任务许可契约', () => {
  const loop = { type: 'task_permission_required', actionId: 'loop-1', summary: '重复操作保护', request: { action: 'doom_loop', tool: 'read', repeatCount: 3 } };
  it('重复操作许可仅暴露白名单工具与安全整数次数', () => {
    for (const tool of ['read', 'glob', 'grep', 'write', 'edit', 'apply_patch', 'bash', 'todowrite']) {
      expect(taskEventSchema.safeParse({ ...loop, request: { ...loop.request, tool } }).success).toBe(true);
    }
    expect(taskEventSchema.safeParse({ ...loop, request: { ...loop.request, repeatCount: Number.MAX_SAFE_INTEGER } }).success).toBe(true);
  });
  it.each([{ tool: 'unknown' }, { repeatCount: 2 }, { repeatCount: 3.5 }, { repeatCount: Infinity }, { repeatCount: Number.MAX_SAFE_INTEGER + 1 }, { resources: ['private'] }, { metadata: {} }, { command: 'private' }, { path: 'private' }, { callId: 'private' }])('重复操作许可拒绝非法或额外字段 %#', change => {
    expect(taskEventSchema.safeParse({ ...loop, request: { ...loop.request, ...change } }).success).toBe(false);
  });
  it.each(['external_directory', 'delete', 'overwrite'])('原有 %s 许可继续通过', action => {
    expect(taskEventSchema.safeParse({ ...loop, request: { action, resources: ['目标'] } }).success).toBe(true);
  });
  const permission = { type: 'task_permission_required', actionId: 'permission-1', summary: '运行命令', request: { action: 'bash', resources: ['command-sha256:fixture'], command: 'pnpm.cmd test', cwd: 'D:\\project' } };
  it('仅接受决策字段且不接受独立过期时间或原始metadata', () => {
    expect(taskEventSchema.parse(permission)).toEqual(permission);
    expect(taskEventSchema.safeParse({ ...permission, expiresAt: '2026-09-05T00:00:00Z' }).success).toBe(false);
    expect(taskEventSchema.safeParse({ ...permission, metadata: { secret: 'private' } }).success).toBe(false);
  });
  it('范围命令列表执行累计预算，不因单条合规而允许超限列表', () => {
    const scope = { type: 'capability_authorization_required', requestId: 'scope-1', capability: 'file', requestSummary: '任务', targetProviderName: 'DeepSeek', directory: 'D:\\project', modelId: 'model-test', actions: ['read', 'create', 'edit'], approvedCommands: ['a'.repeat(16384), 'b'.repeat(16384), 'c'], expiresAt: '2026-09-05T00:00:00Z' };
    expect(taskEventSchema.safeParse(scope).success).toBe(false);
  });
  it.each([{ resources: Array.from({ length: 17 }, () => 'a') }, { resources: ['a'.repeat(1025)] }, { resources: Array.from({ length: 5 }, () => 'a'.repeat(1000)) }, { command: 'a'.repeat(16385) }, { action: 'arbitrary' }])('具体许可拒绝超预算或未知动作 %#', change => {
    expect(taskEventSchema.safeParse({ ...permission, request: { ...permission.request, ...change } }).success).toBe(false);
  });
});

describe('publicSettingsSchema', () => {
  it('公开设置不接受桌面全局位置', () => {
    const settings = {
      version: 1 as const,
      provider: null,
      authorizedRoot: null
    };
    expect(publicSettingsSchema.parse(settings)).toEqual(settings);
    expect(() => publicSettingsSchema.parse({
      ...settings,
      petPosition: { x: 300, y: 200 }
    })).toThrow();
  });
});

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
      contentPreviewSuppressedReason: null,
      previewTruncated: false,
      createdAt: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-20T00:02:00.000Z'
    });

    expect(create).toMatchObject({ category: 'file', operation: 'create_file' });
    expect(pendingActionSchema.parse({
      category: 'file',
      actionId: 'act-dir',
      conversationId: 'conv-1',
      risk: 'write',
      operation: 'create_directory',
      summary: '创建目录 abc',
      targetRelativePath: 'abc',
      createdAt: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-20T00:02:00.000Z'
    })).toMatchObject({ operation: 'create_directory', targetRelativePath: 'abc' });
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
      category: 'file',
      actionId: 'act-move',
      conversationId: 'conv-1',
      risk: 'write',
      operation: 'move_file',
      summary: '移动 docs/source.txt 到 archive/source.txt',
      sourceRelativePath: 'docs/source.txt',
      targetRelativePath: 'archive/source.txt',
      createdAt: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-20T00:02:00.000Z'
    })).toMatchObject({
      operation: 'move_file',
      sourceRelativePath: 'docs/source.txt',
      targetRelativePath: 'archive/source.txt'
    });
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
      contentPreviewSuppressedReason: null,
      previewTruncated: false,
      createdAt: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-20T00:02:00.000Z'
    };

    expect(() => pendingActionSchema.parse(({ ...base, contentPreview: undefined }))).toThrow();
    expect(() => pendingActionSchema.parse(({ ...base, contentPreviewSuppressedReason: undefined }))).toThrow();
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

describe('任务级授权协议', () => {
  it('使用独立事件且不接受 PendingAction 字段', () => {
    const event = {
      type: 'capability_authorization_required',
      directory: 'D:\\authorized', modelId: 'model-test', actions: ['read', 'create', 'edit'], approvedCommands: [],
      requestId: 'cap-1',
      capability: 'file',
      requestSummary: '请整理当前目录',
      targetProviderName: 'DeepSeek',
      expiresAt: '2026-08-27T12:02:00.000Z'
    };
    expect(taskEventSchema.parse(event)).toEqual(event);
    expect(() => taskEventSchema.parse({
      ...event,
      actionId: 'forged-action',
      command: 'Remove-Item C:\\'
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
  it.each([
    ['phase', { type: 'phase', phase: 'thinking' }],
    ['message', { type: 'message', role: 'assistant', text: '已完成' }],
    ['pending_action', { type: 'pending_action', action: {
      category: 'file', actionId: 'act-1', conversationId: 'conv-1', risk: 'write',
      operation: 'delete_file', summary: '删除 notes.md', targetRelativePath: 'notes.md',
      targetType: 'file', createdAt: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-20T00:02:00.000Z'
    } }],
    ['error', { type: 'error', code: 'ACTION_FAILED', message: '执行失败' }],
    ['character_emotion', { type: 'character_emotion', label: 'happy' }],
    ['character_carrying', { type: 'character_carrying', carrying: true }],
    ['history_disclosure_required', { type: 'history_disclosure_required', requestId: 'disclosure-1',
      targetProviderName: 'OpenAI', messageCount: 4, characterCount: 120 }],
    ['conversation_reset', { type: 'conversation_reset', generation: 'generation-2' }]
  ])('接受合法 %s 事件', (_type, event) => {
    expect(taskEventSchema.parse(event)).toEqual(event);
  });

  it('拒绝会话重置事件夹带额外历史', () => {
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
