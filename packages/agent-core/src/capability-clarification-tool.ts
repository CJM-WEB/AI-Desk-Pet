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
  const chineseAction = /(?:执行|删除|移除|创建|修改|写入|运行|继续|覆盖|重命名|移动|复制|应用)/u;
  const chineseParameterQuestion = /(?:(?:哪个|哪一个|什么)(?:文件名|文件|目录|文件夹|路径|内容|补丁|命令)|哪里|何处)/u;
  const chineseConfirmation = chineseAction.test(question)
    && !chineseParameterQuestion.test(question)
    && (
      /(?:确认|确定|真的|是否|要不要|需不需要|同意|允许|可以|可否|能否)/u.test(question)
      || /[吗么]\s*[？?]?\s*$/u.test(question)
    );
  const normalized = question.toLowerCase();
  const englishParameterQuestion = (
    /\b(?:which|what)\s+(?:file|folder|directory|path|content|text|patch|command)\b/u.test(normalized)
    || /\bwhere\b.*\b(?:execute|run|delete|remove|create|write|modify|edit|apply|move|rename|copy)\b/u.test(normalized)
  );
  const englishConfirmation = (
    /\b(?:confirm|approve|sure|really|should|whether|can|could|may|would|will)\b/u.test(normalized)
    || normalized.includes('do you want me to')
  )
    && !englishParameterQuestion
    && /\b(?:execute|run|delete|remove|create|write|modify|edit|proceed|continue|apply|move|rename|copy)\b/u.test(normalized);
  return chineseConfirmation || englishConfirmation;
}

/** 结构化澄清必须指向缺失的执行参数或文件数据授权，不能承载自由提问。 */
export function hasCapabilityClarificationMissingParameterSignal(question: string): boolean {
  const chineseSignal = /(?:路径|文件名|目录名|文件夹名|目标文件|目标目录|目标文件夹|正文|内容|补丁|命令|工作目录|文件数据授权)/u;
  const chineseParameterQuestion = /(?:(?:哪个|哪一个|什么)(?:文件名|文件|目录|文件夹|路径|内容|补丁|命令)|哪里|何处)/u;
  const normalized = question.toLowerCase();
  const englishSignal = /\b(?:path|file\s+name|filename|directory\s+name|folder\s+name|content|text|patch|command|working\s+directory|cwd)\b/u;
  const englishParameterQuestion = (
    /\b(?:which|what)\s+(?:file|folder|directory|path|content|text|patch|command)\b/u.test(normalized)
    || /\bwhere\b.*\b(?:execute|run|delete|remove|create|write|modify|edit|apply|move|rename|copy)\b/u.test(normalized)
  );
  return chineseSignal.test(question)
    || chineseParameterQuestion.test(question)
    || englishSignal.test(normalized)
    || englishParameterQuestion;
}
