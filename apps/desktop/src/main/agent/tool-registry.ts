import type {
  PreparedToolRequest,
  ToolDefinition,
  ToolRisk
} from '@myself/agent-core';
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

  /** 注册完成后冻结工具表，阻止后续混入其他执行能力。 */
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
