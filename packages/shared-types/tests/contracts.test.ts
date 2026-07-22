import { describe, expect, it } from 'vitest';
import { pendingActionSchema, toolRequestSchema } from '../src/contracts';

describe('toolRequestSchema', () => {
  it('接受已知工具并拒绝未知工具', () => {
    const result = toolRequestSchema.parse({
      requestId: 'req-1',
      toolName: 'create_file',
      arguments: { relativePath: 'notes.md' }
    });

    expect(result.toolName).toBe('create_file');
    expect(() => toolRequestSchema.parse({
      requestId: 'req-2',
      toolName: 'run_shell',
      arguments: { command: 'whoami' }
    })).toThrow();
  });
});

describe('pendingActionSchema', () => {
  it('要求目标相对路径和过期时间', () => {
    const result = pendingActionSchema.parse({
      actionId: 'act-1',
      conversationId: 'conv-1',
      risk: 'write',
      summary: '新建 notes.md',
      targetRelativePath: 'notes.md',
      createdAt: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-20T00:02:00.000Z'
    });

    expect(result.risk).toBe('write');
    expect(result).not.toHaveProperty('requestId');
  });
});
