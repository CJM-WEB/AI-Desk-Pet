import type { ToolDefinition } from '@myself/agent-core';

export interface OpenAIToolNameCodec {
  encode(internalName: string): string;
  decode(providerName: string): string;
}

function codecError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/**
 * 为单次 Provider 请求固定内部工具名与安全外部别名，避免响应阶段临时猜测工具。
 */
export function createOpenAIToolNameCodec(
  definitions: readonly ToolDefinition[]
): OpenAIToolNameCodec {
  const internalToProvider = new Map<string, string>();
  const providerToInternal = new Map<string, string>();

  for (const definition of definitions) {
    const internalName = definition.function.name;
    const providerName = internalName.replace(/\./gu, '__');
    if (!/^[A-Za-z0-9_-]+$/u.test(providerName)) {
      throw codecError('OPENAI_TOOL_NAME_INVALID');
    }
    if (providerName.length > 64) {
      throw codecError('OPENAI_TOOL_NAME_TOO_LONG');
    }

    const existingInternalName = providerToInternal.get(providerName);
    if (existingInternalName !== undefined && existingInternalName !== internalName) {
      throw codecError('OPENAI_TOOL_NAME_COLLISION');
    }

    internalToProvider.set(internalName, providerName);
    providerToInternal.set(providerName, internalName);
  }

  return {
    encode(internalName: string): string {
      const providerName = internalToProvider.get(internalName);
      if (providerName === undefined) {
        throw codecError('OPENAI_TOOL_NAME_UNKNOWN_INTERNAL');
      }
      return providerName;
    },
    decode(providerName: string): string {
      const internalName = providerToInternal.get(providerName);
      if (internalName === undefined) {
        throw codecError('OPENAI_TOOL_NAME_UNKNOWN_PROVIDER');
      }
      return internalName;
    }
  };
}
