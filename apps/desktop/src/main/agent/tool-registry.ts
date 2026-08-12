import { posix, win32 } from 'node:path';
import type {
  PreparedToolRequest,
  ToolDefinition,
  ToolRisk
} from '@myself/agent-core';
import { toolArguments } from '@myself/file-tools';
import {
  toolNameSchema,
  toolRequestSchema,
  type ToolRequest
} from '@myself/shared-types';
import type { z } from 'zod';
import type { PermissionPolicy } from './permission-policy';

export interface ToolRegistration {
  definition: ToolDefinition;
  argumentsSchema: z.ZodType<Record<string, unknown>>;
  executionToolName: string;
  risk: ToolRisk;
  enabled: boolean;
  auditSummary(arguments_: Record<string, unknown>): string;
}

function registryError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function cloneDefinition(definition: ToolDefinition): ToolDefinition {
  return structuredClone(definition);
}

function displayRelativePath(value: unknown): string {
  const path = String(value);
  if (posix.isAbsolute(path) || win32.isAbsolute(path)) return '[无效相对路径]';
  return path;
}

function definition(
  name: string,
  description: string,
  parameters: Record<string, unknown>
): ToolDefinition {
  return {
    type: 'function',
    function: { name, description, parameters }
  };
}

export class ToolRegistry {
  private readonly registrations = new Map<string, ToolRegistration>();

  register(registration: ToolRegistration): void {
    const name = registration.definition.function.name;
    if (!toolNameSchema.safeParse(name).success) throw registryError('TOOL_NAME_INVALID');
    if (this.registrations.has(name)) throw registryError('TOOL_ALREADY_REGISTERED');
    this.registrations.set(name, {
      ...registration,
      definition: cloneDefinition(registration.definition)
    });
  }

  definitions(): ToolDefinition[] {
    return [...this.registrations.values()]
      .filter(registration => registration.enabled)
      .map(registration => cloneDefinition(registration.definition));
  }

  prepare(raw: unknown, permissionPolicy: PermissionPolicy): PreparedToolRequest {
    // 基础契约先阻断模型伪造的权限元数据，再查询本地注册信息。
    const basicRequest = toolRequestSchema.safeParse(raw);
    if (!basicRequest.success) throw registryError('TOOL_REQUEST_INVALID');

    const registration = this.registrations.get(basicRequest.data.toolName);
    if (!registration) throw registryError('TOOL_UNKNOWN');
    if (!registration.enabled) throw registryError('TOOL_DISABLED');

    // 工具参数必须先完成严格校验，权限策略只接收本地可信风险等级。
    const argumentsResult = registration.argumentsSchema.safeParse(basicRequest.data.arguments);
    if (!argumentsResult.success) throw registryError('TOOL_ARGUMENTS_INVALID');

    const request: ToolRequest = {
      ...basicRequest.data,
      arguments: argumentsResult.data
    };
    const executionRequest: ToolRequest = {
      ...request,
      toolName: registration.executionToolName
    };
    const auditSummary = registration.auditSummary(argumentsResult.data);
    const decision = permissionPolicy.decide(registration.risk);
    return {
      request,
      executionRequest,
      risk: registration.risk,
      decision,
      auditSummary
    };
  }
}

export function createBuiltinFileToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    definition: definition(
      'builtin.files.list_files',
      '列出授权根目录内指定相对目录的文件。',
      {
        type: 'object',
        properties: {
          relativePath: { type: 'string', default: '.' },
          maxDepth: { type: 'integer', default: 1 },
          maxResults: { type: 'integer', default: 100 }
        },
        additionalProperties: false
      }
    ),
    argumentsSchema: toolArguments.list_files,
    executionToolName: 'list_files',
    risk: 'read',
    enabled: true,
    auditSummary: arguments_ => `列出文件 ${displayRelativePath(arguments_['relativePath'])}`
  });

  registry.register({
    definition: definition(
      'builtin.files.read_file',
      '读取授权根目录内的 UTF-8 文本文件。',
      {
        type: 'object',
        properties: {
          relativePath: { type: 'string' },
          startLine: { type: 'integer', default: 1 },
          lineCount: { type: 'integer', default: 200 }
        },
        required: ['relativePath'],
        additionalProperties: false
      }
    ),
    argumentsSchema: toolArguments.read_file,
    executionToolName: 'read_file',
    risk: 'read',
    enabled: true,
    auditSummary: arguments_ => `读取文件 ${displayRelativePath(arguments_['relativePath'])}`
  });

  registry.register({
    definition: definition(
      'builtin.files.create_file',
      '创建文件，需要用户确认。',
      {
        type: 'object',
        properties: {
          relativePath: { type: 'string' },
          content: { type: 'string', default: '' }
        },
        required: ['relativePath'],
        additionalProperties: false
      }
    ),
    argumentsSchema: toolArguments.create_file,
    executionToolName: 'create_file',
    risk: 'recoverable',
    enabled: true,
    auditSummary: arguments_ => `创建文件 ${displayRelativePath(arguments_['relativePath'])}`
  });

  registry.register({
    definition: definition(
      'builtin.files.apply_patch',
      '向单个文件应用补丁，需要用户确认。',
      {
        type: 'object',
        properties: {
          relativePath: { type: 'string' },
          patch: { type: 'string' }
        },
        required: ['relativePath', 'patch'],
        additionalProperties: false
      }
    ),
    argumentsSchema: toolArguments.apply_patch,
    executionToolName: 'apply_patch',
    risk: 'recoverable',
    enabled: true,
    auditSummary: arguments_ => `应用补丁 ${displayRelativePath(arguments_['relativePath'])}`
  });

  registry.register({
    definition: definition(
      'builtin.files.delete_file',
      '将授权根目录内的文件或空目录移入 Windows 回收站，需要用户确认。',
      {
        type: 'object',
        properties: { relativePath: { type: 'string' } },
        required: ['relativePath'],
        additionalProperties: false
      }
    ),
    argumentsSchema: toolArguments.delete_file,
    executionToolName: 'delete_file',
    risk: 'recoverable',
    enabled: true,
    auditSummary: arguments_ => (
      `删除文件 ${displayRelativePath(arguments_['relativePath'])}`
    )
  });

  return registry;
}

/**
 * 按当前会话的数据授权构建工具表，避免把未授权能力暴露给模型。
 */
export function createSessionToolRegistry(fileDisclosureAllowed: boolean): ToolRegistry {
  return fileDisclosureAllowed ? createBuiltinFileToolRegistry() : new ToolRegistry();
}
