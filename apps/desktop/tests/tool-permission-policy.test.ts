import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import type { ToolDefinition, ToolRisk } from '@myself/agent-core';
import { PermissionPolicy } from '../src/main/agent/permission-policy';
import {
  ToolRegistry,
  createBuiltinFileToolRegistry,
  createSessionToolRegistry
} from '../src/main/agent/tool-registry';

function definition(name: string): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: `${name} 测试工具`,
      parameters: {
        type: 'object',
        properties: { relativePath: { type: 'string' } },
        required: ['relativePath'],
        additionalProperties: false
      }
    }
  };
}

function registerTestTool(
  registry: ToolRegistry,
  options: { enabled?: boolean; risk?: ToolRisk } = {}
): void {
  registry.register({
    definition: definition('builtin.test.action'),
    argumentsSchema: z.object({ relativePath: z.string().min(1) }).strict(),
    executionToolName: 'internal_action',
    risk: options.risk ?? 'read',
    enabled: options.enabled ?? true,
    auditSummary: arguments_ => `测试动作 ${String(arguments_['relativePath'])}`
  });
}

describe('PermissionPolicy', () => {
  test('读取自动允许且可恢复操作需要确认', () => {
    const policy = new PermissionPolicy({ highRiskEnabled: false });

    expect(policy.decide('read')).toBe('allow');
    expect(policy.decide('recoverable')).toBe('confirm');
  });

  test('高风险默认拒绝，显式开启后仍需确认', () => {
    expect(new PermissionPolicy({ highRiskEnabled: false }).decide('high')).toBe('deny');
    expect(new PermissionPolicy({ highRiskEnabled: true }).decide('high')).toBe('confirm');
  });
});

describe('ToolRegistry', () => {
  test.each([
    'create_file',
    'builtin.files'
  ])('注册阶段拒绝非法或旧短名称：%s', name => {
    const registry = new ToolRegistry();

    expect(() => registry.register({
      definition: definition(name),
      argumentsSchema: z.object({ relativePath: z.string() }).strict(),
      executionToolName: 'internal_action',
      risk: 'read',
      enabled: true,
      auditSummary: () => '测试动作'
    })).toThrowError(expect.objectContaining({ code: 'TOOL_NAME_INVALID' }));
  });

  test('拒绝重复注册', () => {
    const registry = new ToolRegistry();
    registerTestTool(registry);

    expect(() => registerTestTool(registry)).toThrowError(expect.objectContaining({
      code: 'TOOL_ALREADY_REGISTERED'
    }));
  });

  test('拒绝未知工具和禁用工具', () => {
    const registry = new ToolRegistry();
    registerTestTool(registry, { enabled: false });
    const policy = new PermissionPolicy({ highRiskEnabled: false });

    expect(() => registry.prepare({
      requestId: 'unknown-1',
      toolName: 'builtin.test.unknown',
      arguments: { relativePath: 'notes.txt' }
    }, policy)).toThrowError(expect.objectContaining({ code: 'TOOL_UNKNOWN' }));
    expect(() => registry.prepare({
      requestId: 'disabled-1',
      toolName: 'builtin.test.action',
      arguments: { relativePath: 'notes.txt' }
    }, policy)).toThrowError(expect.objectContaining({ code: 'TOOL_DISABLED' }));
  });

  test('参数校验先于权限决策执行', () => {
    const registry = new ToolRegistry();
    registerTestTool(registry);
    const policy = new PermissionPolicy({ highRiskEnabled: false });
    const decide = vi.spyOn(policy, 'decide');

    expect(() => registry.prepare({
      requestId: 'invalid-arguments-1',
      toolName: 'builtin.test.action',
      arguments: { relativePath: '', unexpected: true }
    }, policy)).toThrowError(expect.objectContaining({ code: 'TOOL_ARGUMENTS_INVALID' }));
    expect(decide).not.toHaveBeenCalled();
  });

  test('严格拒绝模型伪造风险字段', () => {
    const registry = new ToolRegistry();
    registerTestTool(registry, { risk: 'high' });
    const policy = new PermissionPolicy({ highRiskEnabled: false });

    expect(() => registry.prepare({
      requestId: 'forged-risk-1',
      toolName: 'builtin.test.action',
      arguments: { relativePath: 'notes.txt' },
      risk: 'read'
    }, policy)).toThrowError(expect.objectContaining({ code: 'TOOL_REQUEST_INVALID' }));
  });

  test('风险仅取本地注册值并在参数校验后决策', () => {
    const registry = new ToolRegistry();
    registerTestTool(registry, { risk: 'high' });
    const policy = new PermissionPolicy({ highRiskEnabled: false });
    const decide = vi.spyOn(policy, 'decide');

    const prepared = registry.prepare({
      requestId: 'high-1',
      toolName: 'builtin.test.action',
      arguments: { relativePath: 'notes.txt' }
    }, policy);

    expect(decide).toHaveBeenCalledExactlyOnceWith('high');
    expect(prepared).toMatchObject({
      risk: 'high',
      decision: 'deny',
      executionRequest: {
        requestId: 'high-1',
        toolName: 'internal_action',
        arguments: { relativePath: 'notes.txt' }
      },
      auditSummary: '测试动作 notes.txt'
    });
  });

  test('审计摘要生成成功后才调用权限策略', () => {
    const registry = new ToolRegistry();
    const auditSummary = vi.fn(() => {
      throw new Error('AUDIT_SUMMARY_FAILED');
    });
    registry.register({
      definition: definition('builtin.test.audit'),
      argumentsSchema: z.object({ relativePath: z.string().min(1) }).strict(),
      executionToolName: 'internal_audit',
      risk: 'high',
      enabled: true,
      auditSummary
    });
    const policy = new PermissionPolicy({ highRiskEnabled: true });
    const decide = vi.spyOn(policy, 'decide');

    expect(() => registry.prepare({
      requestId: 'audit-order-1',
      toolName: 'builtin.test.audit',
      arguments: { relativePath: 'notes.txt' }
    }, policy)).toThrow('AUDIT_SUMMARY_FAILED');

    expect(auditSummary).toHaveBeenCalledOnce();
    expect(decide).not.toHaveBeenCalled();
  });

  test('定义只包含启用工具且返回副本不能污染注册表', () => {
    const registry = new ToolRegistry();
    registerTestTool(registry);
    registry.register({
      definition: definition('builtin.test.disabled'),
      argumentsSchema: z.object({ relativePath: z.string() }).strict(),
      executionToolName: 'disabled_action',
      risk: 'read',
      enabled: false,
      auditSummary: () => '禁用动作'
    });

    const first = registry.definitions();
    first[0]!.function.description = '已污染';
    const second = registry.definitions();

    expect(second.map(item => item.function.name)).toEqual(['builtin.test.action']);
    expect(second[0]!.function.description).toBe('builtin.test.action 测试工具');
  });
});

describe('内置文件工具注册', () => {
  test('文件分类未授权时会话不注册任何 builtin 文件工具', () => {
    expect(createSessionToolRegistry(false).definitions()).toEqual([]);
    expect(createSessionToolRegistry(true).definitions().map(
      definition => definition.function.name
    )).toContain('builtin.files.list_files');
  });

  test('五个公开工具精确映射到内部动作和本地风险', () => {
    const registry = createBuiltinFileToolRegistry();
    const policy = new PermissionPolicy({ highRiskEnabled: false });
    const cases = [
      ['builtin.files.list_files', 'list_files', 'read', { relativePath: '.', maxDepth: 1, maxResults: 100 }],
      ['builtin.files.read_file', 'read_file', 'read', { relativePath: 'notes.txt', startLine: 1, lineCount: 200 }],
      ['builtin.files.create_file', 'create_file', 'recoverable', { relativePath: 'new.txt', content: '正文' }],
      ['builtin.files.apply_patch', 'apply_patch', 'recoverable', { relativePath: 'new.txt', patch: '@@ -1 +1 @@\n-a\n+b\n' }],
      ['builtin.files.delete_file', 'delete_file', 'recoverable', { relativePath: 'old.txt' }]
    ] as const;

    expect(registry.definitions().map(item => item.function.name)).toEqual(
      cases.map(([publicName]) => publicName)
    );
    for (const [publicName, executionName, risk, arguments_] of cases) {
      const prepared = registry.prepare({
        requestId: `request-${executionName}`,
        toolName: publicName,
        arguments: arguments_
      }, policy);
      expect(prepared.executionRequest).toEqual({
        requestId: `request-${executionName}`,
        toolName: executionName,
        arguments: arguments_
      });
      expect(prepared.risk).toBe(risk);
      expect(prepared.decision).toBe(risk === 'read' ? 'allow' : 'confirm');
    }
  });

  test('内置参数 Schema 允许创建正文并拒绝附加字段', () => {
    const registry = createBuiltinFileToolRegistry();
    const policy = new PermissionPolicy({ highRiskEnabled: false });

    expect(() => registry.prepare({
      requestId: 'extra-argument-1',
      toolName: 'builtin.files.create_file',
      arguments: { relativePath: 'new.txt', content: '正文', unexpected: true }
    }, policy)).toThrowError(expect.objectContaining({ code: 'TOOL_ARGUMENTS_INVALID' }));
  });

  test('公开 JSON Schema 与文件参数边界一致', () => {
    const definitions = createBuiltinFileToolRegistry().definitions();
    const parameters = (name: string) => definitions.find(item => item.function.name === name)!
      .function.parameters as { properties: Record<string, Record<string, unknown>> };

    expect(parameters('builtin.files.list_files').properties).toMatchObject({
      relativePath: { minLength: 1, maxLength: 1024 },
      maxDepth: { minimum: 1, maximum: 4 },
      maxResults: { minimum: 1, maximum: 200 }
    });
    expect(parameters('builtin.files.read_file').properties).toMatchObject({
      relativePath: { minLength: 1, maxLength: 1024 },
      startLine: { minimum: 1 },
      lineCount: { minimum: 1, maximum: 500 }
    });
    expect(parameters('builtin.files.apply_patch').properties).toMatchObject({
      relativePath: { minLength: 1, maxLength: 1024 },
      patch: { minLength: 1, maxLength: 262_144 }
    });
  });

  test('审计摘要不包含模型提供的绝对路径', () => {
    const registry = createBuiltinFileToolRegistry();
    const policy = new PermissionPolicy({ highRiskEnabled: false });
    const absolutePath = 'C:\\secret\\notes.txt';

    const prepared = registry.prepare({
      requestId: 'absolute-path-1',
      toolName: 'builtin.files.read_file',
      arguments: { relativePath: absolutePath }
    }, policy);

    expect(prepared.auditSummary).not.toContain(absolutePath);
    expect(prepared.auditSummary).toContain('[无效相对路径]');
  });
});
