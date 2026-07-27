import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import type { ToolDefinition, ToolRisk } from '@myself/agent-core';
import { PermissionPolicy } from '../src/main/agent/permission-policy';
import {
  ToolRegistry,
  createBuiltinFileToolRegistry
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
  test('五个公开工具映射到旧内部动作和本地风险', () => {
    const registry = createBuiltinFileToolRegistry();
    const policy = new PermissionPolicy({ highRiskEnabled: false });
    const cases = [
      ['builtin.files.list_directory', 'list_directory', 'read', { relativePath: '.' }],
      ['builtin.files.read_text', 'read_text_file', 'read', { relativePath: 'notes.txt' }],
      ['builtin.files.create_file', 'create_file', 'recoverable', { relativePath: 'new.txt' }],
      ['builtin.files.create_directory', 'create_directory', 'recoverable', { relativePath: 'new' }],
      [
        'builtin.files.rename_entry',
        'rename_entry',
        'recoverable',
        { sourceRelativePath: 'old.txt', targetRelativePath: 'new.txt' }
      ]
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

  test('内置参数 Schema 复用严格校验并拒绝附加字段', () => {
    const registry = createBuiltinFileToolRegistry();
    const policy = new PermissionPolicy({ highRiskEnabled: false });

    expect(() => registry.prepare({
      requestId: 'extra-argument-1',
      toolName: 'builtin.files.create_file',
      arguments: { relativePath: 'new.txt', content: '不得进入审计或执行' }
    }, policy)).toThrowError(expect.objectContaining({ code: 'TOOL_ARGUMENTS_INVALID' }));
  });

  test('审计摘要不包含模型提供的绝对路径', () => {
    const registry = createBuiltinFileToolRegistry();
    const policy = new PermissionPolicy({ highRiskEnabled: false });
    const absolutePath = 'C:\\secret\\notes.txt';

    const prepared = registry.prepare({
      requestId: 'absolute-path-1',
      toolName: 'builtin.files.read_text',
      arguments: { relativePath: absolutePath }
    }, policy);

    expect(prepared.auditSummary).not.toContain(absolutePath);
    expect(prepared.auditSummary).toContain('[无效相对路径]');
  });
});
