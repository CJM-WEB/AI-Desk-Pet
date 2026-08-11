export type ConversationRoute =
  | Readonly<{ kind: 'chat' }>
  | Readonly<{ kind: 'file_task' }>;

const chatRoute: ConversationRoute = Object.freeze({ kind: 'chat' });
const fileTaskRoute: ConversationRoute = Object.freeze({ kind: 'file_task' });

type LocalObjectScan = Readonly<{
  hasLocalObject: boolean;
  semanticText: string;
}>;

const localObjectCandidatePattern = /(?:[a-z][a-z\d+.-]*:\/\/[^\s“”"'（）()<>，,。！？!?；;]+|\.{1,2}[\\/][^\s“”"'（）()<>，,。！？!?；;]+|(?:[^\s“”"'（）()<>\\/，,。！？!?；;]+[\\/])+[^\s“”"'（）()<>\\/，,。！？!?；;]+|[^\s“”"'（）()<>\\/，,。！？!?；;]*\.[a-z\d_-]+(?:\.[a-z\d_-]+)*|\b(?:readme|license|makefile|dockerfile|file|files|folder|folders|directory|directories)\b|当前(?:文件夹|文件|目录)|授权目录|文件夹|文件|目录)/giu;
const remoteObjectPattern = /^(?:[a-z][a-z\d+.-]*:\/\/|www\.)/iu;
const emailPattern = /^[^@\s]+@[^@\s]+\.[a-z\d-]+$/iu;
const numericVersionPattern = /^\d+(?:\.\d+)+$/u;
const fileOperationPattern = /(?:读取|列出|创建|写入|修改|重命名|复制|移动|删除|搜索|整理|read|list|create|write|modify|rename|copy|move|delete|search|organize)/iu;
const chineseDirectExecutionPattern = /^(?:在[^，,。！？!?]*(?:中|里)\s*)?(?:(?:你能(?:不能)?\s*(?:帮我)?|请|请你|帮我|麻烦(?:你)?|给我)\s*)?(?:读取|列出|创建|写入|修改|重命名|复制|移动|删除|搜索|整理)/u;
const chineseReorderedExecutionPattern = /^(?:(?:请|请你|帮我|麻烦(?:你)?|给我)\s*)?(?:把|将).+(?:读取|列出|创建|写入|修改|重命名|复制|移动|删除|搜索|整理)/u;
const englishDirectExecutionPattern = /^(?:(?:please\s+)|(?:(?:can|could|would)\s+you\s+(?:please\s+)?))?(?:read|list|create|write|modify|rename|copy|move|delete|search|organize)\b/iu;
const knowledgePattern = /(?:为什么|为何|如何|怎么|教程|解释|什么意思|是什么(?:意思|功能)?|翻译|why\b|how\s+(?:to|do\s+i)|what\s+is|meaning\b|translate\b|definition\b)/iu;
const negationPattern = /(?:不要|别|无需|do\s+not|don't)/iu;
const statementPattern = /(?:需要|会|可能|风险|危险|权限|requires?|will|may|risk|dangerous|permission)/iu;

/** 先排除远程标识、邮箱和纯数字版本，其余候选由语法形态而非扩展名决定。 */
function isLocalObjectCandidate(candidate: string): boolean {
  if (remoteObjectPattern.test(candidate)) {
    return false;
  }
  if (emailPattern.test(candidate)) {
    return false;
  }
  if (numericVersionPattern.test(candidate)) {
    return false;
  }
  return true;
}

/** 只保护与文件操作处于同一短句的目标，保留紧邻目标的语义后缀供知识判断。 */
function scanLocalObjects(text: string): LocalObjectScan {
  const operationRanges = Array.from(text.matchAll(new RegExp(fileOperationPattern.source, 'giu')))
    .map(match => [match.index, match.index + match[0].length] as const);
  const semanticCharacters = text.split('');
  let hasLocalObject = false;

  for (const match of text.matchAll(localObjectCandidatePattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!isLocalObjectCandidate(match[0])) {
      continue;
    }
    const isOperationAdjacent = operationRanges.some(([operationStart, operationEnd]) => {
      const gapStart = Math.min(end, operationEnd);
      const gapEnd = Math.max(start, operationStart);
      return !/[，,。！？!?；;\n]/u.test(text.slice(gapStart, gapEnd));
    });
    if (!isOperationAdjacent) {
      continue;
    }

    hasLocalObject = true;
    semanticCharacters.fill(' ', start, end);
  }

  return Object.freeze({
    hasLocalObject,
    semanticText: semanticCharacters.join('')
  });
}

export class ExplicitFileIntentGate {
  /**
   * 只有文件对象、文件操作和直接执行请求三项独立证据同时成立才允许进入文件链路，
   * 使不完整、陈述讨论或否定性表达始终停留在默认聊天，避免意外提升文件权限。
   */
  static classify(text: string): ConversationRoute {
    const normalizedText = text.normalize('NFKC').trim().toLocaleLowerCase();
    const localObjectScan = scanLocalObjects(normalizedText);
    if (!normalizedText
      || knowledgePattern.test(localObjectScan.semanticText)
      || negationPattern.test(localObjectScan.semanticText)
      || statementPattern.test(localObjectScan.semanticText)) {
      return chatRoute;
    }

    const hasFileOperation = fileOperationPattern.test(normalizedText);
    const hasDirectExecutionRequest = chineseDirectExecutionPattern.test(normalizedText)
      || chineseReorderedExecutionPattern.test(normalizedText)
      || englishDirectExecutionPattern.test(normalizedText);
    return localObjectScan.hasLocalObject && hasFileOperation && hasDirectExecutionRequest
      ? fileTaskRoute
      : chatRoute;
  }
}
