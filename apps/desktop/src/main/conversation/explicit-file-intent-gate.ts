export type ConversationRoute =
  | Readonly<{ kind: 'chat' }>
  | Readonly<{ kind: 'file_task' }>;

const chatRoute: ConversationRoute = Object.freeze({ kind: 'chat' });
const fileTaskRoute: ConversationRoute = Object.freeze({ kind: 'file_task' });

const fileObjectPattern = /(?:\b[\w.-]+\.(?:txt|md|json|csv|ts|tsx|js|jsx|css|html|xml|yml|yaml|pdf|docx?|xlsx?|png|jpe?g|gif|zip)\b|(?:^|\s)(?:\.\/|\.\.\/)[^\s]+|\b(?:[\w.-]+\/)+[\w.-]+\b|\b(?:readme|license|makefile|dockerfile|file|files|folder|folders|directory|directories)\b|当前(?:文件|文件夹|目录)|授权目录|文件(?:夹)?)/iu;
const fileOperationPattern = /(?:读取|列出|创建|写入|修改|重命名|复制|移动|删除|搜索|整理|read|list|create|write|modify|rename|copy|move|delete|search|organize)/iu;
const chineseDirectExecutionPattern = /^(?:(?:请|请你|帮我|麻烦(?:你)?|给我)\s*)?(?:读取|列出|创建|写入|修改|重命名|复制|移动|删除|搜索|整理)/u;
const chineseReorderedExecutionPattern = /^(?:把|将).+(?:读取|列出|创建|写入|修改|重命名|复制|移动|删除|搜索|整理)/u;
const englishDirectExecutionPattern = /^(?:please\s+)?(?:read|list|create|write|modify|rename|copy|move|delete|search|organize)\b/iu;
const knowledgePattern = /(?:为什么|为何|如何|怎么|教程|解释|why\b|how\s+(?:to|do\s+i)|what\s+is)/iu;
const negationPattern = /(?:不要|别|无需|do\s+not|don't)/iu;

export class ExplicitFileIntentGate {
  /**
   * 只有文件对象、文件操作和直接执行请求三项独立证据同时成立才允许进入文件链路，
   * 使不完整、讨论性或否定性表达始终停留在默认聊天，避免意外提升文件权限。
   */
  static classify(text: string): ConversationRoute {
    const normalizedText = text.normalize('NFKC').trim().toLocaleLowerCase();
    if (!normalizedText || knowledgePattern.test(normalizedText) || negationPattern.test(normalizedText)) {
      return chatRoute;
    }

    const hasFileObject = fileObjectPattern.test(normalizedText);
    const hasFileOperation = fileOperationPattern.test(normalizedText);
    const hasDirectExecutionRequest = chineseDirectExecutionPattern.test(normalizedText)
      || chineseReorderedExecutionPattern.test(normalizedText)
      || englishDirectExecutionPattern.test(normalizedText);
    return hasFileObject && hasFileOperation && hasDirectExecutionRequest
      ? fileTaskRoute
      : chatRoute;
  }
}
