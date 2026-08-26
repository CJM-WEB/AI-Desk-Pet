import { parse } from 'tldts';
import type { FilePlanningHint, FilePlanningOperation } from '@myself/agent-core';

/** Router 不授予角色行为权限；行为控制由独立 Gate 处理。 */
export type ExplicitBehaviorHint = never;
/** 文件分流仅携带已验证证据，不携带路径或正文。 */
export type ExplicitFileEvidence = Readonly<{ kind: 'explicit_file_operation' }>;
/** Shell 分流仅携带运行方式，不携带命令正文。 */
export type ExplicitShellEvidence = Readonly<{
  kind: 'explicit_shell_execution';
  requestedRunMode: 'foreground' | 'background';
}>;
/** 记录后续模型控制计划能否补充升级当前聊天回合。 */
export type ModelEscalation = 'allowed' | 'blocked';
export type CapabilityIntent =
  | Readonly<{
      kind: 'chat';
      behaviorHint: ExplicitBehaviorHint | null;
      modelEscalation: ModelEscalation;
    }>
  | Readonly<{ kind: 'file_task'; evidence: ExplicitFileEvidence }>
  | Readonly<{ kind: 'unsupported_file_operation'; operation: 'copy_file' }>
  | Readonly<{ kind: 'powershell_task'; evidence: ExplicitShellEvidence }>;

export interface CapabilityIntentRouter {
  route(prompt: string): CapabilityIntent;
  routeTrustedFileContinuation(): Extract<CapabilityIntent, { kind: 'file_task' }>;
}

const chatIntent: CapabilityIntent = Object.freeze({
  kind: 'chat', behaviorHint: null, modelEscalation: 'allowed'
});
const blockedChatIntent: CapabilityIntent = Object.freeze({
  kind: 'chat', behaviorHint: null, modelEscalation: 'blocked'
});
const fileTaskIntent: Extract<CapabilityIntent, { kind: 'file_task' }> = Object.freeze({
  kind: 'file_task',
  evidence: Object.freeze({ kind: 'explicit_file_operation' })
});
const unsupportedCopyIntent: CapabilityIntent = Object.freeze({
  kind: 'unsupported_file_operation', operation: 'copy_file'
});
const powershellTaskIntent: CapabilityIntent = Object.freeze({
  kind: 'powershell_task',
  evidence: Object.freeze({ kind: 'explicit_shell_execution', requestedRunMode: 'foreground' })
});
const backgroundPowerShellTaskIntent: CapabilityIntent = Object.freeze({
  kind: 'powershell_task',
  evidence: Object.freeze({ kind: 'explicit_shell_execution', requestedRunMode: 'background' })
});

type TextRange = readonly [number, number];

const quotePairs = new Map<string, string>([
  ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']
]);
const fileOperationPattern = /(?:按文件名匹配|读取|列出|创建|新建|写入|修改|替换|重命名|复制|移动|删除|搜索|查找|匹配|整理|\b(?:read|list|create|write|modify|replace|rename|copy|move|delete|search|match|glob|grep|organize)\b)/giu;
const localObjectPattern = /(?:\.{1,2}[\\/][^\s“”"'（）()<>，,。！？!?；;]+|(?:[^\s“”"'（）()<>\\/，,。！？!?；;]+[\\/])+[^\s“”"'（）()<>\\/，,。！？!?；;]+|[^\s“”"'（）()<>\\/，,。！？!?；;]*\.[a-z\d_-]+(?:\.[a-z\d_-]+)*|\b(?:readme|license|makefile|dockerfile|file|files|folder|folders|directory|directories)\b|当前(?:文件夹|文件|目录)|授权目录|回收站|文件夹|文件|目录)/giu;
const quotedOrCodePrefixPattern = /^(?:>|[`'"“”‘’]|~~~)/u;
const explicitReferencePrefixPattern = /^(?:引用|翻译|read\s+the\s+phrase\b)/iu;
const explicitNegationPrefixPattern = /^(?:never\b|我不想让你|你不能帮我|千万(?:不要|不用|不必|无需|不需要|别)|(?:(?:请你?|麻烦你?|你(?:能不能|能)帮我|可以帮我|帮我)\s*)?(?:不要|不用|不必|无需|不需要|别|(?:please\s+)?(?:do\s+not|don't)\b))/iu;
const quotedReferenceEnvelopePattern = /^(?:(?:把|将)[^\n]{0,40}[“”‘’"'][^\n]{1,240}[“”‘’"'][^\n]{0,40}翻译|[^\n]{0,40}说\s*[：:][^\n]{0,20}[“”‘’"'])/u;
const indentedCodeLinePattern = /(?:^|\r?\n)(?: {4}|\t)/u;
const fencedCodeLinePattern = /(?:^|\r?\n)[ \t]*(?:```|~~~)/u;
const chineseRequestPrefixPattern = /^(?:(?:那|那么)\s*)?(?:请你?帮我|请你?|你能(?:不能)?帮我|可以帮我|麻烦你?帮我|麻烦你?|帮我|给我)?\s*/u;
const englishRequestPrefixPattern = /^(?:(?:please\s+)|(?:(?:can|could|would)\s+you\s+(?:please\s+)?))?/iu;
const chineseLocationPrefixPattern = /^(?:在)?(?:当前(?:文件夹|文件|目录)|授权目录)(?:中|里|下)?(?:帮我)?/u;
const chineseClarificationPattern = /^(?:请你?|帮我)?\s*(?:删除|修改|移动|创建|读取)一个(?:文件|文件夹|目录)[，,][^\n]{1,160}(?:目标)?(?:相对)?路径[^\n]{0,80}$/u;
const embeddedFileContentPattern = /(?:文件正文(?:是|为|如下)?|file\s+contents?(?:\s+(?:are|is))?)\s*(?::|：)\s*([\s\S]*)$/iu;
const missingTargetPathPattern = /(?:(?:没有|尚未|未|没)\s*(?:提供|填写|指定)|(?:缺少|缺失))[^。！？!?\n]{0,16}(?:目标)?(?:相对)?路径/iu;
const clarifiedTargetMarker = '补充信息(覆盖此前缺失字段):';

const chineseExplicitPowerShellPattern = /^(?:(?:请|请你|帮我|麻烦(?:你|给我)?)\s*)?(?:运行|执行)\s+powershell\s+([\s\S]+)$/iu;
const englishExplicitPowerShellPattern = /^(?:(?:please\s+)|(?:(?:can|could|would)\s+you\s+(?:please\s+)?))?(?:run|execute)\s+powershell\s+([\s\S]+)$/iu;
const chineseShellPattern = /^(?:(?:请|请你|帮我|麻烦(?:你|给我)?)\s*)?(?:运行\s+|执行\s*(?:(?:这条|以下|下面)?\s*(?:命令|powershell|脚本)\s+))([\s\S]+)$/iu;
const englishShellPattern = /^(?:(?:please\s+)|(?:(?:can|could|would)\s+you\s+(?:please\s+)?))?(?:run\s+|execute\s+(?:(?:this|the)\s+command\s*:?\s*|powershell\s+))([\s\S]+)$/iu;
const backgroundShellPattern = /^(?:(?:请|请你|帮我|麻烦(?:你|给我)?)\s*)?后台运行\s*(?:构建|测试|build\b|test\b)$/iu;
const commandPayloadPattern = /^(?:[a-z][a-z\d._-]*|\.{1,2}[\\/](?:[a-z\d._-]+[\\/])*[a-z\d._-]+)(?:\s+\S+){0,16}$/iu;
const assignmentScriptPattern = /^\$[a-z_][a-z\d_:]*\s*=\s*[^;\r\n]+;\s*\S[\s\S]*$/iu;
const scriptBlockPattern = /^&\s*\{[\s\S]+\}$/u;
const shellDiscussionTailPattern = /(?:安全吗|好不好|值得吗|是什么(?:意思)?|会怎样|合适吗)[？?]?$/u;
const englishNaturalLanguageTokenPattern = /^(?:am|is|are|was|were|be|been|being|do|does|did|can|could|would|will|shall|should|may|might|must|has|have|had|what|why|how|when|where|who|whom|whose|which)$/u;

/** 任意行出现缩进代码或围栏时，整段文本都不能升级为系统能力任务。 */
function containsDeterministicCodeStructure(text: string): boolean {
  return indentedCodeLinePattern.test(text) || fencedCodeLinePattern.test(text);
}

function isWordInternalApostrophe(text: string, index: number): boolean {
  return text[index] === "'"
    && /[\p{L}\p{N}]/u.test(text[index - 1] ?? '')
    && /[\p{L}\p{N}]/u.test(text[index + 1] ?? '');
}

/** 成对引用以等长空格屏蔽，引用内容不能贡献操作或目标证据。 */
function maskQuotedText(text: string): string {
  const characters = text.split('');
  for (let index = 0; index < text.length; index += 1) {
    const closingQuote = quotePairs.get(text[index] ?? '');
    if (closingQuote === undefined || isWordInternalApostrophe(text, index)) continue;
    let closingIndex = text.indexOf(closingQuote, index + 1);
    while (closingQuote === "'" && closingIndex >= 0 && isWordInternalApostrophe(text, closingIndex)) {
      closingIndex = text.indexOf(closingQuote, closingIndex + 1);
    }
    if (closingIndex < 0) continue;
    characters.fill(' ', index, closingIndex + 1);
    index = closingIndex;
  }
  return characters.join('');
}

function isLocalObject(candidate: string, allowPublicSuffix: boolean): boolean {
  if (/^\.{1,2}[\\/]/u.test(candidate)) return true;
  if (candidate.includes('://') || /^[^@\s]+@[^@\s]+\.[a-z\d-]+$/iu.test(candidate)) return false;
  if (/^(?:version\s*=?\s*)?\d+(?:\.\d+)+$/iu.test(candidate)) return false;
  const separator = candidate.search(/[\\/]/u);
  if (separator >= 0 && !candidate.slice(0, separator).includes('.')) return true;
  const host = separator >= 0 ? candidate.slice(0, separator) : candidate;
  return allowPublicSuffix || parse(host).isIcann !== true;
}

function scanRanges(text: string, pattern: RegExp): readonly TextRange[] {
  return Array.from(text.matchAll(pattern), match => [match.index, match.index + match[0].length] as const);
}

function scanLocalObjects(text: string): readonly TextRange[] {
  const allowPublicSuffix = /(?:\bfile\s+|(?:rename|copy|move)\s+\S+\s+(?:to|into|as)\s+|(?:把|将)[^。！？!?\n]{1,80}(?:重命名|复制|移动)[^。！？!?\n]{1,80}(?:为|到|至))/iu.test(text);
  const operations = scanRanges(text, fileOperationPattern);
  return Array.from(text.matchAll(localObjectPattern))
    .map(match => {
      const end = match.index + match[0].length;
      const overlappingOperation = operations.find(operation =>
        match.index <= operation[0] && operation[1] < end);
      const start = overlappingOperation?.[1] ?? match.index;
      return { match, start, end, candidate: text.slice(start, end) };
    })
    .filter(({ end }) => {
      return !/[\\/@]/u.test(text[end] ?? '')
        && (text[end] !== '.' || text[end + 1] === undefined || /\s/u.test(text[end + 1] ?? ''));
    })
    .filter(({ candidate }) => candidate.length > 0 && isLocalObject(candidate, allowPublicSuffix))
    .map(({ start, end }) => [start, end] as const);
}

function sameSentence(left: TextRange, right: TextRange, text: string): boolean {
  if (left[0] < right[1] && right[0] < left[1]) return false;
  const start = Math.min(left[1], right[1]);
  const end = Math.max(left[0], right[0]);
  return !/[，,。！？!?；;\n]|\.(?=\s|$)/u.test(text.slice(start, end));
}

function hasClosedTermination(text: string, objects: readonly TextRange[]): boolean {
  const lastObjectEnd = objects.reduce((end, object) => Math.max(end, object[1]), 0);
  const tail = text.slice(lastObjectEnd).trim();
  if (!tail || /^[。！？!?.]$/u.test(tail)) return true;
  if (/^(?:吗|可以吗)[？?]?$/u.test(tail)) return true;
  if (/^because\b[^.!?]{1,120}[?]?$/iu.test(tail)) return true;
  if (/^(?:下|中|里)?(?:的)?(?:文件|文件夹|目录)?(?:了)?[。！]?$/u.test(tail)) return true;
  if (/^(?:到|至|为)\s*(?:当前(?:文件夹|文件|目录)|授权目录)(?:中|里|下)?[。！]?$/u.test(tail)) return true;
  if (/^(?:并|并且|然后|再)\s*(?:写入|修改|替换|移动|删除)[^。！？!?\n]{0,120}[。！]?$/u.test(tail)) return true;
  if (/^中(?:的)?[^。！？!?\n]{1,80}(?:替换|修改|写入|搜索|查找)[^。！？!?\n]{0,80}[。！]?$/u.test(tail)) return true;
  if (/^(?:读取|列出|创建|新建|写入|修改|替换|重命名|复制|移动|删除|搜索|匹配|整理)(?:了)?[。！]?$/u.test(tail)) return true;
  return false;
}

function hasClosedChineseShape(text: string, objects: readonly TextRange[]): boolean {
  if (text.includes('\n')) return false;
  if (chineseClarificationPattern.test(text)) return true;
  const prefix = chineseRequestPrefixPattern.exec(text)?.[0] ?? '';
  const core = text.slice(prefix.length);
  const direct = fileOperationPattern.exec(core);
  fileOperationPattern.lastIndex = 0;
  const startsWithOperation = direct?.index === 0 && /[\u3400-\u9fff]/u.test(direct[0]);
  const location = chineseLocationPrefixPattern.exec(core);
  const afterLocation = location === null ? '' : core.slice(location[0].length);
  const locationOperation = fileOperationPattern.exec(afterLocation);
  fileOperationPattern.lastIndex = 0;
  const startsWithLocation = location !== null
    && locationOperation?.index === 0
    && /[\u3400-\u9fff]/u.test(locationOperation[0]);
  const startsWithSourceMarker = /^(?:把|将)/u.test(core)
    && /(?:重命名|复制|移动|删除|修改|替换)/u.test(core);
  const targetFirst = /^[^。！？!?\n]{1,80}(?:在)?(?:当前(?:文件夹|文件|目录)|授权目录)(?:中|里|下)?帮我(?:读取|列出|创建|新建|写入|修改|替换|重命名|复制|移动|删除|搜索|匹配|整理)[了！。]?$/u.test(core);
  if (!startsWithOperation && !startsWithLocation && !startsWithSourceMarker && !targetFirst) return false;
  if (targetFirst) return true;
  if (startsWithSourceMarker) {
    return /^(?:把|将)[^。！？!?\n]{1,120}(?:重命名|复制|移动|删除|修改|替换)(?:为|到|至)?[^。！？!?\n]{0,120}[。！]?$/u.test(core)
      && hasClosedTermination(text, objects);
  }
  if (/[？?]/u.test(core)) {
    return prefix.trim().length > 0
      && /(?:吗|可以吗)[？?]?$/u.test(core)
      && hasClosedTermination(text, objects);
  }
  return !/[。！？!?]\s*\S/u.test(core) && hasClosedTermination(text, objects);
}

function hasClosedEnglishShape(text: string, objects: readonly TextRange[]): boolean {
  if (text.includes('\n')) return false;
  const prefix = englishRequestPrefixPattern.exec(text)?.[0] ?? '';
  const core = text.slice(prefix.length);
  const operation = fileOperationPattern.exec(core);
  fileOperationPattern.lastIndex = 0;
  return operation?.index === 0
    && /^[\x00-\x7f]+$/u.test(operation[0])
    && core.slice(operation[0].length).trim().length > 0
    && !/[.!?]\s+\S/u.test(core.slice(operation[0].length))
    && hasClosedTermination(text, objects);
}

/**
 * Main 只识别封闭直接命令形状；未命中的开放式语义交给模型控制计划，
 * 不再维护知识、咨询或可行性词表来模拟自然语言理解。
 */
function hasExplicitFileIntent(text: string): boolean {
  if (!text || quotedOrCodePrefixPattern.test(text)
    || explicitReferencePrefixPattern.test(text)
    || explicitNegationPrefixPattern.test(text)) return false;
  const unquotedText = maskQuotedText(text);
  const closedSourceTarget = /^(?:(?:请你?帮我|请你?|帮我|麻烦你?帮我)\s*)?(?:把|将)\s*\S+\s*(?:重命名为|移动到|复制到)\s*\S+[。！]?$/u.test(unquotedText);
  if (closedSourceTarget) return true;
  const operations = scanRanges(unquotedText, fileOperationPattern)
    .filter(([, end]) => unquotedText[end] !== '.');
  const objects = scanLocalObjects(unquotedText);
  if (operations.length === 0 || objects.length === 0
    || !operations.some(operation => objects.some(object => sameSentence(operation, object, unquotedText)))) {
    return false;
  }
  return hasClosedChineseShape(unquotedText, objects)
    || hasClosedEnglishShape(unquotedText, objects);
}

function hasNaturalLanguageShellTail(commandText: string): boolean {
  const unquoted = maskQuotedText(commandText);
  const argumentStart = unquoted.search(/\s/u);
  if (argumentStart < 0) return false;
  const argumentsText = unquoted.slice(argumentStart).trim();
  const tokens = argumentsText.split(/\s+/u).map(token => token.replace(/^[,，]/u, ''));
  return /[^\x00-\x7f]/u.test(argumentsText) || /\?\s*$/u.test(argumentsText)
    || tokens.some((token, index) => index < tokens.length - 1
      && englishNaturalLanguageTokenPattern.test(token));
}

function isShellPayload(payload: string): boolean {
  const commandText = payload.trim().replace(/^powershell\s+/iu, '');
  return (commandPayloadPattern.test(commandText)
    || assignmentScriptPattern.test(commandText)
    || scriptBlockPattern.test(commandText)) && !hasNaturalLanguageShellTail(commandText);
}

function isExplicitPowerShellPayload(payload: string): boolean {
  const commandText = payload.trim();
  return commandText.length > 0
    && new TextEncoder().encode(commandText).byteLength <= 16 * 1_024
    && maskQuotedText(commandText).trim().length > 0
    && !shellDiscussionTailPattern.test(maskQuotedText(commandText).trim())
    && !hasNaturalLanguageShellTail(commandText);
}

function explicitPowerShellIntent(text: string): CapabilityIntent | undefined {
  const payload = chineseExplicitPowerShellPattern.exec(text)?.[1]
    ?? englishExplicitPowerShellPattern.exec(text)?.[1];
  if (payload === undefined) return undefined;
  return isExplicitPowerShellPayload(payload) ? powershellTaskIntent : blockedChatIntent;
}

function shellIntent(text: string): CapabilityIntent | null {
  if (backgroundShellPattern.test(text)) return backgroundPowerShellTaskIntent;
  const explicit = explicitPowerShellIntent(text);
  if (explicit !== undefined) return explicit.kind === 'powershell_task' ? explicit : null;
  const chinesePayload = chineseShellPattern.exec(text)?.[1];
  if (chinesePayload !== undefined) return isShellPayload(chinesePayload) ? powershellTaskIntent : null;
  const englishPayload = englishShellPattern.exec(text)?.[1];
  return englishPayload !== undefined && isShellPayload(englishPayload) ? powershellTaskIntent : null;
}

function hasEmbeddedShellExecution(text: string): boolean {
  const embedded = embeddedFileContentPattern.exec(text)?.[1]?.trim();
  return embedded !== undefined && shellIntent(embedded) !== null;
}

/** 确定性引用、代码和显式否定不能被后续模型建议重新提升为本地能力。 */
function blocksModelEscalation(text: string): boolean {
  return quotedOrCodePrefixPattern.test(text)
    || explicitReferencePrefixPattern.test(text)
    || explicitNegationPrefixPattern.test(text)
    || quotedReferenceEnvelopePattern.test(text)
    || embeddedFileContentPattern.test(text);
}

function filePlanningOperation(text: string): FilePlanningOperation | null {
  if (/(?:创建|新建).{0,24}(?:文件夹|目录)|\b(?:create|make)\b.{0,24}\b(?:folder|directory)\b/iu.test(text)) return 'create_directory';
  if (/(?:回收站|recycle\s+bin)/iu.test(text) && /(?:删除|移动|移入|\b(?:delete|move)\b)/iu.test(text)) return 'delete_file';
  if (/(?:删除|\bdelete\b)/iu.test(text)) return 'delete_file';
  if (/(?:搜索|查找).{0,16}(?:内容|正文|包含)|(?:内容|正文).{0,16}(?:搜索|查找)|\bgrep\b/iu.test(text)) return 'grep_files';
  if (/(?:按文件名|文件名匹配)|\bglob\b/iu.test(text)) return 'glob_files';
  if (/(?:列出|\blist\b)/iu.test(text)) return 'list_files';
  if (/(?:读取|\bread\b)/iu.test(text)) return 'read_file';
  if (/(?:创建|新建|\bcreate\b)/iu.test(text)) return 'create_file';
  if (/(?:修改|替换|写入|\b(?:modify|replace|write)\b)/iu.test(text)) return 'edit_file';
  if (/(?:移动|\bmove\b)/iu.test(text)) return 'move_file';
  return null;
}

/** Main 只传递操作类别，不在 Router 中解释路径或执行结果。 */
export function createFilePlanningHint(prompt: string): FilePlanningHint | null {
  const normalizedText = prompt.normalize('NFKC').trim();
  const operation = filePlanningOperation(normalizedText);
  if (operation === null) return null;
  return Object.freeze({ operation,
    ...(missingTargetPathPattern.test(normalizedText) && !normalizedText.includes(clarifiedTargetMarker)
      ? { missingField: 'target_path' as const } : {}) });
}

export class DefaultCapabilityIntentRouter implements CapabilityIntentRouter {
  constructor(private readonly fileIntentGate: (text: string) => boolean = hasExplicitFileIntent) {}

  /** 只有封闭直接命令可跳过任务级授权；其他文本保守回落普通聊天。 */
  route(prompt: string): CapabilityIntent {
    const normalizedPrompt = prompt.normalize('NFKC');
    if (containsDeterministicCodeStructure(normalizedPrompt)) return blockedChatIntent;
    const text = normalizedPrompt.trim().toLocaleLowerCase();
    const explicitShell = explicitPowerShellIntent(text);
    if (explicitShell !== undefined) return explicitShell;
    if (hasEmbeddedShellExecution(text)) return blockedChatIntent;
    const shell = shellIntent(text);
    if (shell !== null) return shell;
    if (!this.fileIntentGate(text)) {
      return blocksModelEscalation(text) ? blockedChatIntent : chatIntent;
    }
    if (/(?:复制|\bcopy\b)/iu.test(text)) return unsupportedCopyIntent;
    return fileTaskIntent;
  }

  /** 仅供 Coordinator 在持有同代澄清状态时恢复文件任务，不解析任何用户可伪造标记。 */
  routeTrustedFileContinuation(): Extract<CapabilityIntent, { kind: 'file_task' }> {
    return fileTaskIntent;
  }
}

export const capabilityIntentRouter: CapabilityIntentRouter = new DefaultCapabilityIntentRouter();
