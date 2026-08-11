import { parse } from 'tldts';

/** C1 不授予行为权限；后续阶段只能显式扩展这个封闭联合。 */
export type ExplicitBehaviorHint = never;

/** 文件分流只暴露已验证的正向意图，不携带路径或正文。 */
export type ExplicitFileEvidence = Readonly<{ kind: 'explicit_file_operation' }>;

/** Shell 分流只暴露已验证的正向意图，不携带命令正文。 */
export type ExplicitShellEvidence = Readonly<{ kind: 'explicit_shell_execution' }>;

export type CapabilityIntent =
  | Readonly<{ kind: 'chat'; behaviorHint: ExplicitBehaviorHint | null }>
  | Readonly<{ kind: 'file_task'; evidence: ExplicitFileEvidence }>
  | Readonly<{ kind: 'powershell_task'; evidence: ExplicitShellEvidence }>;

export interface CapabilityIntentRouter {
  route(prompt: string): CapabilityIntent;
}

const chatIntent: CapabilityIntent = Object.freeze({ kind: 'chat', behaviorHint: null });
const fileTaskIntent: CapabilityIntent = Object.freeze({
  kind: 'file_task',
  evidence: Object.freeze({ kind: 'explicit_file_operation' })
});
const powershellTaskIntent: CapabilityIntent = Object.freeze({
  kind: 'powershell_task',
  evidence: Object.freeze({ kind: 'explicit_shell_execution' })
});

type LocalObjectScan = Readonly<{
  hasLocalObject: boolean;
  semanticText: string;
}>;

type TextRange = readonly [start: number, end: number];
type StructureSlot = Readonly<{
  kind: 'operation' | 'target';
  range: TextRange;
  sourceMarkerIndex: number | null;
}>;

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
const chineseShellExecutionPattern = /^(?:(?:请|请你|帮我|麻烦(?:你|给我)?)\s*)?(?:运行\s+(?:powershell\b\s+\S+|命令\s+\S+|脚本\s+\S+)|执行\s*(?:(?:这条|以下|下面)?\s*命令\s+\S+|powershell\b\s+\S+|脚本\s+\S+)|后台运行\s*(?:构建|测试|build\b|test\b))/iu;
const englishShellExecutionPattern = /^(?:(?:please\s+)|(?:(?:can|could|would)\s+you\s+(?:please\s+)?))?(?:run\s+(?:powershell\b\s+\S+|(?:this|the)\s+command\s*:?[\s]*\S+)|execute\s+(?:(?:this|the)\s+command\s*:?[\s]*\S+|powershell\b\s+\S+)|run\s+(?:build\b|test\b)\s+in\s+the\s+background)/iu;
const embeddedFileContentPattern = /(?:文件正文(?:是|为|如下)?|file\s+contents?(?:\s+(?:are|is))?)\s*(?::|：)\s*([\s\S]*)$/iu;

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

function isSentenceBoundaryAt(text: string, index: number): boolean {
  const character = text[index];
  return character === '.'
    ? text[index + 1] === undefined || /\s/u.test(text[index + 1] ?? '')
    : /[，,。！？!?；;\n]/u.test(character ?? '');
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
    // 正则不得截取路径或邮箱形态的畸形 token 前缀充当完整目标。
    .filter(([, end]) => {
      const nextCharacter = text[end];
      return !/[\\/@]/u.test(nextCharacter ?? '')
        && (nextCharacter !== '.'
          || text[end + 1] === undefined
          || /\s/u.test(text[end + 1] ?? ''));
    });
}

function isWhitespaceGap(text: string, left: TextRange, right: TextRange): boolean {
  return text.slice(left[1], right[0]).trim().length === 0;
}

/** 英文强结构只接受“操作 + 源 + 连接词 + 目标”的连续槽位。 */
function hasEnglishSourceTargetConnection(
  text: string,
  operationRange: TextRange,
  sourceRange: TextRange,
  targetRange: TextRange
): boolean {
  return operationRange[1] <= sourceRange[0]
    && sourceRange[1] <= targetRange[0]
    && areInSameSentence(text, operationRange, targetRange)
    && isWhitespaceGap(text, operationRange, sourceRange)
    && /^\s+(?:to|as|into)\s+$/u.test(text.slice(sourceRange[1], targetRange[0]));
}

/** 中文强结构只接受“把/将 + 源 + 操作 + 为/到/至 + 目标”的连续槽位。 */
function hasChineseSourceTargetConnection(
  text: string,
  operationRange: TextRange,
  sourceRange: TextRange,
  targetRange: TextRange,
  sourceMarkerIndex: number | null
): boolean {
  if (sourceRange[1] > operationRange[0]
    || operationRange[1] > targetRange[0]
    || !areInSameSentence(text, sourceRange, targetRange)
    || !isWhitespaceGap(text, sourceRange, operationRange)
    || !/^\s*(?:为|到|至)\s*$/u.test(text.slice(operationRange[1], targetRange[0]))) {
    return false;
  }
  return sourceMarkerIndex !== null;
}

/** 强文件结构必须存在真实源到目标连接，不能由操作词与两个近邻候选凑成。 */
function hasStrongFileStructure(text: string, targetRanges: readonly TextRange[]): boolean {
  const operationRanges = Array.from(text.matchAll(strongFileOperationPattern))
    .map(match => [match.index, match.index + match[0].length] as const);
  const orderedSlots: StructureSlot[] = [];
  let operationIndex = 0;
  let targetIndex = 0;
  let scannedUntil = 0;
  let recentMarkerIndex: number | null = null;
  let markerHasOnlyWhitespace = true;
  const appendSlot = (kind: StructureSlot['kind'], range: TextRange): void => {
    for (let index = scannedUntil; index < range[0]; index += 1) {
      const character = text[index];
      if (isSentenceBoundaryAt(text, index)) {
        recentMarkerIndex = null;
        markerHasOnlyWhitespace = true;
      } else if (character === '把' || character === '将') {
        recentMarkerIndex = index;
        markerHasOnlyWhitespace = true;
      } else if (recentMarkerIndex !== null && !/\s/u.test(character ?? '')) {
        markerHasOnlyWhitespace = false;
      }
    }
    orderedSlots.push({
      kind,
      range,
      sourceMarkerIndex: markerHasOnlyWhitespace ? recentMarkerIndex : null
    });
    if (recentMarkerIndex !== null) {
      markerHasOnlyWhitespace = false;
    }
    scannedUntil = Math.max(scannedUntil, range[1]);
  };
  while (operationIndex < operationRanges.length || targetIndex < targetRanges.length) {
    const operationRange = operationRanges[operationIndex];
    const targetRange = targetRanges[targetIndex];
    if (operationRange !== undefined
      && (targetRange === undefined || operationRange[0] < targetRange[0])) {
      appendSlot('operation', operationRange);
      operationIndex += 1;
    } else if (targetRange !== undefined) {
      appendSlot('target', targetRange);
      targetIndex += 1;
    }
  }

  // 只检查文本顺序中相邻的三槽，避免操作、源、目标的全组合。
  for (let index = 0; index + 2 < orderedSlots.length; index += 1) {
    const first = orderedSlots[index];
    const second = orderedSlots[index + 1];
    const third = orderedSlots[index + 2];
    if (first === undefined || second === undefined || third === undefined) {
      continue;
    }
    if (first.kind === 'operation' && second.kind === 'target' && third.kind === 'target'
      && hasEnglishSourceTargetConnection(text, first.range, second.range, third.range)) {
      return true;
    }
    if (first.kind === 'target' && second.kind === 'operation' && third.kind === 'target'
      && hasChineseSourceTargetConnection(
        text,
        second.range,
        first.range,
        third.range,
        first.sourceMarkerIndex
      )) {
      return true;
    }
  }
  return false;
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

/** 只有用户消息开头的明确执行措辞才能进入 Shell 能力分支。 */
function hasExplicitShellExecution(normalizedText: string): boolean {
  return chineseShellExecutionPattern.test(normalizedText)
    || englishShellExecutionPattern.test(normalizedText);
}

/** 文件正文只作为内容引用；抽出的正文片段复用完整 Shell 正向证据判断。 */
function hasEmbeddedShellExecution(normalizedText: string): boolean {
  const embeddedContent = embeddedFileContentPattern.exec(normalizedText)?.[1]?.trim();
  return embeddedContent !== undefined && hasExplicitShellExecution(embeddedContent);
}

export class DefaultCapabilityIntentRouter implements CapabilityIntentRouter {
  /**
   * 只有文件对象、文件操作和直接执行请求三项独立证据同时成立才允许进入文件链路，
   * 使不完整、陈述讨论或否定性表达始终停留在默认聊天，避免意外提升文件权限。
   */
  route(prompt: string): CapabilityIntent {
    const normalizedText = prompt.normalize('NFKC').trim().toLocaleLowerCase();
    const unquotedText = maskQuotedText(normalizedText);
    const targetRanges = scanTargetRanges(unquotedText);
    const objectRanges = scanLocalObjectRanges(unquotedText, targetRanges);
    const localObjectScan = scanLocalObjects(unquotedText, objectRanges);
    if (!normalizedText
      || knowledgePattern.test(localObjectScan.semanticText)
      || negationPattern.test(localObjectScan.semanticText)
      || statementPattern.test(localObjectScan.semanticText)) {
      return chatIntent;
    }
    if (hasEmbeddedShellExecution(normalizedText)) return chatIntent;
    if (hasExplicitShellExecution(normalizedText)) return powershellTaskIntent;

    const operationRanges = scanFileOperationRanges(localObjectScan.semanticText);
    const requestedOperationRanges = bindRequestedOperationRanges(
      localObjectScan.semanticText,
      operationRanges
    );
    const hasFileOperation = requestedOperationRanges.length > 0;
    const hasDirectExecutionRequest = hasExecutionStructure(
      unquotedText,
      objectRanges,
      operationRanges
    );
    return localObjectScan.hasLocalObject && hasFileOperation && hasDirectExecutionRequest
      ? fileTaskIntent
      : chatIntent;
  }
}

/** 对话协调器共享的唯一能力意图分流入口。 */
export const capabilityIntentRouter: CapabilityIntentRouter = new DefaultCapabilityIntentRouter();
