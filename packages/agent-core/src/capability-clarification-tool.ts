import type { ToolDefinition } from './types';

export const CAPABILITY_CLARIFICATION_TOOL_NAME =
  'builtin.capability.request_clarification' as const;

export const CAPABILITY_CLARIFICATION_MISSING_FIELDS = [
  'target_path',
  'content',
  'patch',
  'command',
  'working_directory',
  'file_data_authorization'
] as const;

export type CapabilityClarificationMissingField =
  typeof CAPABILITY_CLARIFICATION_MISSING_FIELDS[number];

export type CapabilityClarificationRequest = Readonly<{
  missingField: CapabilityClarificationMissingField;
}>;

/** 模型只选择缺失字段；面向用户的文字完全由宿主固定生成。 */
const CAPABILITY_CLARIFICATION_MESSAGES = Object.freeze({
  target_path: '请提供目标文件或目录的相对路径。',
  content: '请提供要写入的文件内容。',
  patch: '请提供要应用的补丁内容。',
  command: '请提供要执行的 PowerShell 命令。',
  working_directory: '请提供要使用的工作目录。',
  file_data_authorization: '请先开启文件数据授权。'
} satisfies Readonly<Record<CapabilityClarificationMissingField, string>>);

/** 能力规划仅可通过这个无副作用工具声明一个缺失的执行必需字段。 */
export const capabilityClarificationToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: CAPABILITY_CLARIFICATION_TOOL_NAME,
    description: '当且仅当缺少执行必需参数时，选择一个缺失字段交由宿主澄清。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['missingField'],
      properties: {
        missingField: {
          type: 'string',
          enum: [...CAPABILITY_CLARIFICATION_MISSING_FIELDS]
        }
      }
    }
  }
};

function clarificationError(): Error {
  return Object.assign(new Error('CAPABILITY_CLARIFICATION_INVALID'), {
    code: 'CAPABILITY_CLARIFICATION_INVALID'
  });
}

/** 澄清参数必须是只含一个受控缺失字段枚举的严格对象。 */
export function parseCapabilityClarificationRequest(
  raw: unknown
): CapabilityClarificationRequest {
  if (
    typeof raw !== 'object'
    || raw === null
    || Array.isArray(raw)
    || Object.keys(raw).length !== 1
    || !Object.hasOwn(raw, 'missingField')
  ) throw clarificationError();

  const missingField = (raw as Record<string, unknown>).missingField;
  if (
    typeof missingField !== 'string'
    || !CAPABILITY_CLARIFICATION_MISSING_FIELDS.includes(
      missingField as CapabilityClarificationMissingField
    )
  ) throw clarificationError();

  return { missingField: missingField as CapabilityClarificationMissingField };
}

/** 公开文案来自宿主枚举映射，永不回显 Provider 自由文本。 */
export function getCapabilityClarificationMessage(
  missingField: CapabilityClarificationMissingField
): string {
  return CAPABILITY_CLARIFICATION_MESSAGES[missingField];
}
