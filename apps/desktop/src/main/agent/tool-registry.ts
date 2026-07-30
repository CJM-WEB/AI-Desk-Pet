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
      'builtin.files.list_directory',
      '列出授权根目录内指定相对目录的内容。',
      {
        type: 'object',
        properties: { relativePath: { type: 'string', default: '.' } },
        additionalProperties: false
      }
    ),
    argumentsSchema: toolArguments.list_directory,
    executionToolName: 'list_directory',
    risk: 'read',
    enabled: true,
    auditSummary: arguments_ => `列出目录 ${displayRelativePath(arguments_['relativePath'])}`
  });

  registry.register({
    definition: definition(
      'builtin.files.read_text',
      '读取授权根目录内的 UTF-8 文本文件。',
      {
        type: 'object',
        properties: { relativePath: { type: 'string' } },
        required: ['relativePath'],
        additionalProperties: false
      }
    ),
    argumentsSchema: toolArguments.read_text_file,
    executionToolName: 'read_text_file',
    risk: 'read',
    enabled: true,
    auditSummary: arguments_ => `读取文本 ${displayRelativePath(arguments_['relativePath'])}`
  });

  registry.register({
    definition: definition(
      'builtin.files.create_file',
      '创建空文件，需要用户确认。',
      {
        type: 'object',
        properties: { relativePath: { type: 'string' } },
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
      'builtin.files.create_directory',
      '创建目录，需要用户确认。',
      {
        type: 'object',
        properties: { relativePath: { type: 'string' } },
        required: ['relativePath'],
        additionalProperties: false
      }
    ),
    argumentsSchema: toolArguments.create_directory,
    executionToolName: 'create_directory',
    risk: 'recoverable',
    enabled: true,
    auditSummary: arguments_ => `创建目录 ${displayRelativePath(arguments_['relativePath'])}`
  });

  registry.register({
    definition: definition(
      'builtin.files.rename_entry',
      '在同一目录内重命名文件或目录，需要用户确认。',
      {
        type: 'object',
        properties: {
          sourceRelativePath: { type: 'string' },
          targetRelativePath: { type: 'string' }
        },
        required: ['sourceRelativePath', 'targetRelativePath'],
        additionalProperties: false
      }
    ),
    argumentsSchema: toolArguments.rename_entry,
    executionToolName: 'rename_entry',
    risk: 'recoverable',
    enabled: true,
    auditSummary: arguments_ => (
      `重命名 ${displayRelativePath(arguments_['sourceRelativePath'])}`
      + ` 为 ${displayRelativePath(arguments_['targetRelativePath'])}`
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
