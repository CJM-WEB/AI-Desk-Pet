import { parse } from 'tldts';

export type ConversationRoute =
  | Readonly<{ kind: 'chat' }>
  | Readonly<{ kind: 'file_task' }>;

const chatRoute: ConversationRoute = Object.freeze({ kind: 'chat' });
const fileTaskRoute: ConversationRoute = Object.freeze({ kind: 'file_task' });

type LocalObjectScan = Readonly<{
  hasLocalObject: boolean;
  semanticText: string;
}>;

type TextRange = readonly [start: number, end: number];

const localObjectCandidatePattern = /(?:[a-z][a-z\d+.-]*:\/\/[^\s“”"'（）()<>，,。！？!?；;]+|\.{1,2}[\\/][^\s“”"'（）()<>，,。！？!?；;]+|(?:[^\s“”"'（）()<>\\/，,。！？!?；;]+[\\/])+[^\s“”"'（）()<>\\/，,。！？!?；;]+|[^\s“”"'（）()<>\\/，,。！？!?；;]*\.[a-z\d_-]+(?:\.[a-z\d_-]+)*|\b(?:readme|license|makefile|dockerfile|file|files|folder|folders|directory|directories)\b|当前(?:文件夹|文件|目录)|授权目录|文件夹|文件|目录)/giu;
const emailPattern = /^[^@\s]+@[^@\s]+\.[a-z\d-]+$/iu;
const quotePairs = new Map<string, string>([
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’']
]);
const fileOperationPattern = /(?:读取|列出|创建|写入|修改|重命名|复制|移动|删除|搜索|整理|\b(?:read|list|create|write|modify|rename|copy|move|delete|search|organize)\b)/giu;
const strongFileOperationPattern = /(?:重命名|复制|移动|\b(?:rename|copy|move)\b)/giu;
const chineseDirectExecutionPattern = /^(?:在[^，,。！？!?]*(?:中|里)\s*)?(?:(?:你能(?:不能)?\s*(?:帮我)?|请|请你|帮我|麻烦(?:你)?|给我)\s*)?(?:读取|列出|创建|写入|修改|重命名|复制|移动|删除|搜索|整理)/u;
const chineseReorderedExecutionPattern = /^(?:(?:请|请你|帮我|麻烦(?:你)?|给我)\s*)?(?:把|将).+(?:读取|列出|创建|写入|修改|重命名|复制|移动|删除|搜索|整理)/u;
const englishDirectExecutionPattern = /^(?:(?:please\s+)|(?:(?:can|could|would)\s+you\s+(?:please\s+)?))?(?:read|list|create|write|modify|rename|copy|move|delete|search|organize)\b/iu;
const englishPoliteExecutionShellPattern = /^(?:can|could|would)\s+you\s+(?:please\s+)?([a-z]+)\b/iu;
const knowledgePattern = /(?:为什么|为何|如何|怎么|教程|解释|什么意思|是什么(?:意思|功能)?|翻译|why\b|how\s+(?:to|do\s+i)|what\s+is|meaning\b|translate\b|definition\b)/iu;
const negationPattern = /(?:不要|别|无需|do\s+not|don't)/iu;
const statementPattern = /(?:需要|会|可能|风险|危险|权限|requires?|will|may|risk|dangerous|permission)/iu;

function getHostPart(candidate: string): string {
  const pathSeparatorIndex = candidate.search(/[\\/]/u);
  return pathSeparatorIndex >= 0 ? candidate.slice(0, pathSeparatorIndex) : candidate;
}

/** 公共后缀裸名称存在本地/远程歧义，除非有显式本地或强文件结构，否则默认远程。 */
function hasPublicSuffix(candidate: string): boolean {
  return parse(getHostPart(candidate)).isIcann === true;
}

function isNumericVersion(candidate: string): boolean {
  const equalsIndex = candidate.lastIndexOf('=');
  const versionText = equalsIndex >= 0 ? candidate.slice(equalsIndex + 1) : candidate;
  const segments = versionText.split('.');
  return segments.length >= 2
    && segments.every(segment => segment.length > 0
      && Array.from(segment).every(character => character >= '0' && character <= '9'));
}

/** 先排除远程标识、邮箱和纯数字版本，其余候选由语法形态而非扩展名决定。 */
function isLocalObjectCandidate(candidate: string, allowPublicSuffix: boolean): boolean {
  if (/^\.{1,2}[\\/]/u.test(candidate)) {
    return true;
  }
  if (candidate.includes('://')) {
    return false;
  }
  if (emailPattern.test(candidate)) {
    return false;
  }
  if (isNumericVersion(candidate)) {
    return false;
  }
  if (/[\\/]/u.test(candidate) && !getHostPart(candidate).includes('.')) {
    return true;
  }
  if (!allowPublicSuffix && hasPublicSuffix(candidate)) {
    return false;
  }
  return true;
}

/** 英文点号仅在后接空白或文本结束时作为句号，文件名内部点号不分句。 */
function hasSentenceBoundary(text: string): boolean {
  return /[，,。！？!?；;\n]|\.(?=\s|$)/u.test(text);
}

function isWordInternalApostrophe(text: string, index: number): boolean {
  const wordCharacterPattern = /[\p{L}\p{N}]/u;
  return text[index] === "'"
    && wordCharacterPattern.test(text[index - 1] ?? '')
    && wordCharacterPattern.test(text[index + 1] ?? '');
}

/** 单引号闭合扫描跳过词内撇号，避免把所有格或缩写误当成引用边界。 */
function findClosingQuote(text: string, openingIndex: number, closingQuote: string): number {
  let closingIndex = text.indexOf(closingQuote, openingIndex + 1);
  while (closingQuote === "'"
    && closingIndex >= 0
    && isWordInternalApostrophe(text, closingIndex)) {
    closingIndex = text.indexOf(closingQuote, closingIndex + 1);
  }
  return closingIndex;
}

/** 成对引号及其内容以等长空格屏蔽，引用不得贡献对象、操作或执行结构证据。 */
function maskQuotedText(text: string): string {
  const characters = text.split('');
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) {
      continue;
    }
    const closingQuote = quotePairs.get(character);
    if (closingQuote === undefined) {
      continue;
    }
    if (isWordInternalApostrophe(text, index)) {
      continue;
    }
    const closingIndex = findClosingQuote(text, index, closingQuote);
    if (closingIndex < 0) {
      continue;
    }
    characters.fill(' ', index, closingIndex + 1);
    index = closingIndex;
  }
  return characters.join('');
}

/** 目标槽只做词法分段，是否为合法本地对象由独立证据随后判断。 */
function scanTargetRanges(text: string): readonly TextRange[] {
  return Array.from(text.matchAll(localObjectCandidatePattern))
    .map(match => [match.index, match.index + match[0].length] as const)
    // 正则不得截取以路径分隔符结尾的畸形 token 前缀充当完整目标。
    .filter(([, end]) => !/[\\/]/u.test(text[end] ?? ''));
}

/** rename/copy/move 只有在同一短句出现至少两个目标槽时才构成强文件结构。 */
function hasStrongFileStructure(text: string, targetRanges: readonly TextRange[]): boolean {
  const operationRanges = Array.from(text.matchAll(strongFileOperationPattern))
    .map(match => [match.index, match.index + match[0].length] as const);
  return operationRanges.some(operationRange => targetRanges
    .filter(targetRange => areInSameSentence(text, operationRange, targetRange))
    .length >= 2);
}

/** 对象词法扫描不读取操作证据，只过滤目标槽的本地属性。 */
function scanLocalObjectRanges(
  text: string,
  targetRanges: readonly TextRange[]
): readonly TextRange[] {
  const allowPublicSuffix = hasStrongFileStructure(text, targetRanges);
  return targetRanges.filter(([start, end]) =>
    isLocalObjectCandidate(text.slice(start, end), allowPublicSuffix));
}

/** 只遮蔽对象本身，保留紧邻目标的语义后缀供知识判断。 */
function scanLocalObjects(text: string, objectRanges: readonly TextRange[]): LocalObjectScan {
  const semanticCharacters = text.split('');
  for (const [start, end] of objectRanges) {
    semanticCharacters.fill(' ', start, end);
  }

  return Object.freeze({
    hasLocalObject: objectRanges.length > 0,
    semanticText: semanticCharacters.join('')
  });
}

function scanFileOperationRanges(text: string): readonly TextRange[] {
  return Array.from(text.matchAll(fileOperationPattern))
    .map(match => [match.index, match.index + match[0].length] as const);
}

/** 礼貌壳只把紧随请求前缀的动词作为操作槽，不能借用句尾讨论中的操作词。 */
function bindRequestedOperationRanges(
  text: string,
  operationRanges: readonly TextRange[]
): readonly TextRange[] {
  const politeMatch = englishPoliteExecutionShellPattern.exec(text);
  const action = politeMatch?.[1];
  if (politeMatch?.index === undefined || action === undefined) {
    return operationRanges;
  }
  const actionStart = politeMatch.index + politeMatch[0].lastIndexOf(action);
  return operationRanges.filter(([start, end]) =>
    start === actionStart && end === actionStart + action.length);
}

function areInSameSentence(text: string, left: TextRange, right: TextRange): boolean {
  const gapStart = Math.min(left[1], right[1]);
  const gapEnd = Math.max(left[0], right[0]);
  return !hasSentenceBoundary(text.slice(gapStart, gapEnd));
}

/** 执行结构负责把操作槽与对象绑定在同一短句，操作词是否合法由独立证据判断。 */
function hasExecutionStructure(
  text: string,
  targetRanges: readonly TextRange[],
  operationRanges: readonly TextRange[]
): boolean {
  const hasKnownDirectRequest = chineseDirectExecutionPattern.test(text)
    || chineseReorderedExecutionPattern.test(text)
    || englishDirectExecutionPattern.test(text);
  if (hasKnownDirectRequest) {
    return operationRanges.some(operationRange =>
      targetRanges.some(targetRange => areInSameSentence(text, operationRange, targetRange)));
  }

  if (!englishPoliteExecutionShellPattern.test(text)) {
    return false;
  }
  return targetRanges.some(([start]) => !hasSentenceBoundary(text.slice(0, start)));
}

export class ExplicitFileIntentGate {
  /**
   * 只有文件对象、文件操作和直接执行请求三项独立证据同时成立才允许进入文件链路，
   * 使不完整、陈述讨论或否定性表达始终停留在默认聊天，避免意外提升文件权限。
   */
  static classify(text: string): ConversationRoute {
    const normalizedText = text.normalize('NFKC').trim().toLocaleLowerCase();
    const unquotedText = maskQuotedText(normalizedText);
    const targetRanges = scanTargetRanges(unquotedText);
    const objectRanges = scanLocalObjectRanges(unquotedText, targetRanges);
    const localObjectScan = scanLocalObjects(unquotedText, objectRanges);
    if (!normalizedText
      || knowledgePattern.test(localObjectScan.semanticText)
      || negationPattern.test(localObjectScan.semanticText)
      || statementPattern.test(localObjectScan.semanticText)) {
      return chatRoute;
    }

    const operationRanges = scanFileOperationRanges(localObjectScan.semanticText);
    const requestedOperationRanges = bindRequestedOperationRanges(
      localObjectScan.semanticText,
      operationRanges
    );
    const hasFileOperation = requestedOperationRanges.length > 0;
    const hasDirectExecutionRequest = hasExecutionStructure(
      unquotedText,
      targetRanges,
      operationRanges
    );
    return localObjectScan.hasLocalObject && hasFileOperation && hasDirectExecutionRequest
      ? fileTaskRoute
      : chatRoute;
  }
}
