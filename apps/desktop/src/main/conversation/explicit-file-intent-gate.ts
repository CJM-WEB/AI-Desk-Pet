export type ConversationRoute =
  | Readonly<{ kind: 'chat' }>
  | Readonly<{ kind: 'file_task' }>;

const chatRoute: ConversationRoute = Object.freeze({ kind: 'chat' });
const fileTaskRoute: ConversationRoute = Object.freeze({ kind: 'file_task' });

const urlPattern = /\b[a-z][a-z\d+.-]*:\/\/[^\s]+/giu;
const fileObjectPattern = /(?:(?:^|[\s“"'（(])[^\s“”"'（）()<>\\/]+\.[^\s“”"'（）()<>\\/]+|(?:^|[\s“"'（(])(?:\.{1,2}[\\/])[^\s“”"'（）()<>]+|(?:^|\s)(?:[^\s\\/]+[\\/])+[^\s\\/]+|\b(?:readme|license|makefile|dockerfile|file|files|folder|folders|directory|directories)\b|当前(?:文件|文件夹|目录)|授权目录|文件(?:夹)?)/iu;
const fileOperationPattern = /(?:读取|列出|创建|写入|修改|重命名|复制|移动|删除|搜索|整理|read|list|create|write|modify|rename|copy|move|delete|search|organize)/iu;
const chineseDirectExecutionPattern = /^(?:在[^，,。！？!?]*(?:中|里)\s*)?(?:(?:请|请你|帮我|麻烦(?:你)?|给我)\s*)?(?:读取|列出|创建|写入|修改|重命名|复制|移动|删除|搜索|整理)/u;
const chineseReorderedExecutionPattern = /^(?:(?:请|请你|帮我|麻烦(?:你)?|给我)\s*)?(?:把|将).+(?:读取|列出|创建|写入|修改|重命名|复制|移动|删除|搜索|整理)/u;
const englishDirectExecutionPattern = /^(?:(?:please\s+)|(?:(?:can|could|would)\s+you\s+))?(?:read|list|create|write|modify|rename|copy|move|delete|search|organize)\b/iu;
const knowledgePattern = /(?:为什么|为何|如何|怎么|教程|解释|什么意思|是什么(?:意思|功能)?|翻译|why\b|how\s+(?:to|do\s+i)|what\s+is|meaning\b|translate\b|definition\b)/iu;
const negationPattern = /(?:不要|别|无需|do\s+not|don't)/iu;
const statementPattern = /(?:需要|会|可能|风险|危险|权限|requires?|will|may|risk|dangerous|permission)/iu;

/** 陈述词出现在文件名或路径中不代表用户在陈述文件操作。 */
function removeFileObjectFragments(text: string): string {
  return text.replace(new RegExp(fileObjectPattern.source, 'giu'), ' ');
}

export class ExplicitFileIntentGate {
  /**
   * 只有文件对象、文件操作和直接执行请求三项独立证据同时成立才允许进入文件链路，
   * 使不完整、陈述讨论或否定性表达始终停留在默认聊天，避免意外提升文件权限。
   */
  static classify(text: string): ConversationRoute {
    const normalizedText = text.normalize('NFKC').trim().toLocaleLowerCase();
    // URL 不是本地文件对象；先移除它，避免 URL 尾部文件名误入授权链。
    const localCandidateText = normalizedText.replace(urlPattern, ' ');
    const statementSubjectText = removeFileObjectFragments(localCandidateText);
    if (!normalizedText
      || knowledgePattern.test(statementSubjectText)
      || negationPattern.test(statementSubjectText)
      || statementPattern.test(statementSubjectText)) {
      return chatRoute;
    }

    const hasFileObject = fileObjectPattern.test(localCandidateText);
    const hasFileOperation = fileOperationPattern.test(localCandidateText);
    const hasDirectExecutionRequest = chineseDirectExecutionPattern.test(localCandidateText)
      || chineseReorderedExecutionPattern.test(localCandidateText)
      || englishDirectExecutionPattern.test(localCandidateText);
    return hasFileObject && hasFileOperation && hasDirectExecutionRequest
      ? fileTaskRoute
      : chatRoute;
  }
}
