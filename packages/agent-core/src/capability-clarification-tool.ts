import type { ToolDefinition } from './types';

const CAPABILITY_CLARIFICATION_QUESTION_MAX_LENGTH = 1_000;

export const CAPABILITY_CLARIFICATION_TOOL_NAME =
  'builtin.capability.request_clarification' as const;

/** 能力规划仅可通过这个无副作用工具向用户补充执行必需参数。 */
export const capabilityClarificationToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: CAPABILITY_CLARIFICATION_TOOL_NAME,
    description: '当且仅当缺少执行必需参数时，向用户提出一个澄清问题。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: {
          type: 'string',
          minLength: 1,
          maxLength: CAPABILITY_CLARIFICATION_QUESTION_MAX_LENGTH
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

/** 澄清参数必须是只含非空、有限长度 question 的严格对象。 */
export function parseCapabilityClarificationRequest(
  raw: unknown
): Readonly<{ question: string }> {
  if (
    typeof raw !== 'object'
    || raw === null
    || Array.isArray(raw)
    || Object.keys(raw).length !== 1
    || !Object.hasOwn(raw, 'question')
  ) throw clarificationError();

  const question = (raw as Record<string, unknown>).question;
  if (
    typeof question !== 'string'
    || question.trim().length === 0
    || question.length > CAPABILITY_CLARIFICATION_QUESTION_MAX_LENGTH
  ) throw clarificationError();
  return { question };
}

/** 宿主独占执行确认，模型不能把确认问题伪装成参数澄清。 */
export function isCapabilityClarificationExecutionConfirmation(question: string): boolean {
  const chineseConfirmation = /(?:确认|确定|真的|是否|要不要|需不需要|同意)/u.test(question)
    && /(?:执行|删除|创建|修改|写入|运行|继续)/u.test(question);
  const normalized = question.toLowerCase();
  const englishConfirmation = (
    /\b(?:confirm|approve|sure|really|should|whether)\b/u.test(normalized)
    || normalized.includes('do you want me to')
  ) && /\b(?:execute|run|delete|remove|create|write|modify|edit|proceed|continue)\b/u.test(normalized);
  return chineseConfirmation || englishConfirmation;
}
