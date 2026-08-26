import { posix, win32 } from 'node:path';
import type {
  PreparedToolRequest,
  ToolDefinition,
  ToolRisk
} from '@myself/agent-core';
import { toolArguments, toolJsonSchemas } from '@myself/file-tools';
import {
  toolNameSchema,
  toolRequestSchema,
  type ToolRequest
} from '@myself/shared-types';
import type { z } from 'zod';
import { z as zod } from 'zod';
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
  private sealed = false;

  register(registration: ToolRegistration): void {
    if (this.sealed) throw registryError('TOOL_REGISTRY_SEALED');
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

  /** 本地能力任务签发后冻结工具表，阻止后续混入其他执行能力。 */
  seal(): this {
    this.sealed = true;
    return this;
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
      toolJsonSchemas.list_files
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
      toolJsonSchemas.read_file
    ),
    argumentsSchema: toolArguments.read_file,
    executionToolName: 'read_file',
    risk: 'read',
    enabled: true,
    auditSummary: arguments_ => `读取文件 ${displayRelativePath(arguments_['relativePath'])}`
  });

  registry.register({
    definition: definition(
      'builtin.files.glob_files',
      '按文件名模式检索授权根目录内的普通文件。',
      toolJsonSchemas.glob_files
    ),
    argumentsSchema: toolArguments.glob_files,
    executionToolName: 'glob_files',
    risk: 'read',
    enabled: true,
    auditSummary: arguments_ => `检索文件 ${displayRelativePath(arguments_['relativePath'])}`
  });

  registry.register({
    definition: definition(
      'builtin.files.grep_files',
      '按文字内容检索授权根目录内的 UTF-8 文本文件。',
      toolJsonSchemas.grep_files
    ),
    argumentsSchema: toolArguments.grep_files,
    executionToolName: 'grep_files',
    risk: 'read',
    enabled: true,
    auditSummary: arguments_ => `搜索内容 ${displayRelativePath(arguments_['relativePath'])}`
  });

  registry.register({
    definition: definition(
      'builtin.files.create_file',
      '创建文件，需要用户确认。',
      toolJsonSchemas.create_file
    ),
    argumentsSchema: toolArguments.create_file,
    executionToolName: 'create_file',
    risk: 'recoverable',
    enabled: true,
    auditSummary: arguments_ => `创建文件 ${displayRelativePath(arguments_['relativePath'])}`
  });

  registry.register({
    definition: definition(
      'builtin.files.move_file',
      '将授权根内的一个普通文件或目录移动到另一个已存在目录，需要用户确认。',
      toolJsonSchemas.move_file
    ),
    argumentsSchema: toolArguments.move_file,
    executionToolName: 'move_file',
    risk: 'recoverable',
    enabled: true,
    auditSummary: arguments_ => (
      `移动文件或目录 ${displayRelativePath(arguments_['sourceRelativePath'])} 到 ${displayRelativePath(arguments_['targetDirectoryRelativePath'])}`
    )
  });

  registry.register({
    definition: definition(
      'builtin.files.create_directory',
      '创建一个父目录已经存在的相对目录，需要用户确认。',
      toolJsonSchemas.create_directory
    ),
    argumentsSchema: toolArguments.create_directory,
    executionToolName: 'create_directory',
    risk: 'recoverable',
    enabled: true,
    auditSummary: arguments_ => `创建目录 ${displayRelativePath(arguments_['relativePath'])}`
  });

  registry.register({
    definition: definition(
      'builtin.files.apply_patch',
      '应用带完整文件头的统一补丁；可包含多个现有文件，每个文件都需要单独确认。',
      toolJsonSchemas.apply_patch
    ),
    argumentsSchema: toolArguments.apply_patch,
    executionToolName: 'apply_patch',
    risk: 'recoverable',
    enabled: true,
    auditSummary: arguments_ => arguments_['relativePath'] === undefined
      ? '应用多文件补丁（逐文件确认）'
      : `应用补丁 ${displayRelativePath(arguments_['relativePath'])}`
  });

  registry.register({
    definition: definition(
      'builtin.files.edit_file',
      '在单个 UTF-8 文本文件中执行精确替换，需要用户确认。',
      toolJsonSchemas.edit_file
    ),
    argumentsSchema: toolArguments.edit_file,
    executionToolName: 'edit_file',
    risk: 'recoverable',
    enabled: true,
    auditSummary: arguments_ => `修改文件 ${displayRelativePath(arguments_['relativePath'])}`
  });

  registry.register({
    definition: definition(
      'builtin.files.delete_file',
      '将授权根目录内的文件或空目录移入 Windows 回收站，需要用户确认。',
      toolJsonSchemas.delete_file
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

/** 当前 PowerShell 任务只公开一个前台命令能力，不能混入文件工具。 */
export function createBuiltinPowerShellToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const argumentsSchema = zod.object({
    command: zod.string().min(1).max(16_384)
  }).strict();
  registry.register({
    definition: definition(
      'builtin.powershell.run',
      '在授权工作目录以前台非交互方式运行 PowerShell 命令，需要用户确认。',
      {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties: { command: { type: 'string', minLength: 1, maxLength: 16_384 } }
      }
    ),
    argumentsSchema,
    executionToolName: 'powershell',
    risk: 'high',
    enabled: true,
    auditSummary: () => '运行 PowerShell 命令'
  });
  return registry;
}

/** 文件数据授权由任务上下文收窄模型可见面，Main 始终保留完整文件注册表供本地核验。 */
export function createSessionToolRegistry(input: {
  taskKind: 'file' | 'powershell';
  fileDisclosureAllowed: boolean;
}): ToolRegistry {
  if (input.taskKind === 'powershell') return createBuiltinPowerShellToolRegistry().seal();
  return createBuiltinFileToolRegistry().seal();
}
