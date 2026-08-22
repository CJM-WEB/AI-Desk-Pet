export type ModelResponseContract = Readonly<{
  type: 'json_object';
  name: 'character_chat';
  jsonSchema: Readonly<Record<string, unknown>>;
  textField: 'text';
  allowPlainTextFallback: true;
}>;

export type ResponseContractDecodeResult =
  | Readonly<{ kind: 'structured'; text: string; structured_output: Record<string, unknown> }>
  | Readonly<{ kind: 'plain_text'; text: string }>
  | Readonly<{ kind: 'invalid' }>;

const MAX_RESPONSE_TEXT_LENGTH = 4_000;
/** 4,000 个字符最坏可编码为约 24 KiB；仅截断恢复限制在 64 KiB。 */
const MAX_TRUNCATED_RESPONSE_CONTRACT_LENGTH = 64 * 1024;

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_RESPONSE_TEXT_LENGTH;
}

function skipWhitespace(raw: string, index: number): number {
  while (index < raw.length && /\s/u.test(raw[index]!)) index += 1;
  return index;
}

function readJsonString(raw: string, start: number): { value: string; end: number } | null {
  if (raw[start] !== '"') return null;
  let escaped = false;
  for (let index = start + 1; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;
    try {
      const value: unknown = JSON.parse(raw.slice(start, index + 1));
      return typeof value === 'string' ? { value, end: index + 1 } : null;
    } catch {
      return null;
    }
  }
  return null;
}

function skipJsonValue(raw: string, start: number): number | null {
  const first = raw[start];
  if (first === '"') return readJsonString(raw, start)?.end ?? null;
  if (first !== '{' && first !== '[') {
    let index = start;
    while (index < raw.length && !/[\s,}\]]/u.test(raw[index]!)) index += 1;
    if (index === start) return null;
    try {
      JSON.parse(raw.slice(start, index));
      return index;
    } catch {
      return null;
    }
  }

  const opening = first;
  const stack: string[] = [opening === '{' ? '}' : ']'];
  for (let index = start + 1; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (character === '"') {
      const string = readJsonString(raw, index);
      if (!string) return null;
      index = string.end - 1;
      continue;
    }
    if (character === '{') stack.push('}');
    else if (character === '[') stack.push(']');
    else if (character === '}' || character === ']') {
      if (stack.pop() !== character) return null;
      if (stack.length === 0) return index + 1;
    }
  }
  return null;
}

/** 仅扫描外层对象键，截断恢复时绝不把嵌套字段冒充聊天正文。 */
function extractTopLevelText(raw: string, textField: string): string | null {
  let index = skipWhitespace(raw, 1);
  while (index < raw.length) {
    if (raw[index] === '}') return null;
    const key = readJsonString(raw, index);
    if (!key) return null;
    index = skipWhitespace(raw, key.end);
    if (raw[index] !== ':') return null;
    index = skipWhitespace(raw, index + 1);
    if (key.value === textField) {
      const value = readJsonString(raw, index);
      return value && validText(value.value) ? value.value : null;
    }
    const valueEnd = skipJsonValue(raw, index);
    if (valueEnd === null) return null;
    index = skipWhitespace(raw, valueEnd);
    if (raw[index] === '}') return null;
    if (raw[index] !== ',') return null;
    index = skipWhitespace(raw, index + 1);
  }
  return null;
}

/** 仅恢复可显示正文；行为字段继续由上层按角色契约单独验证。 */
export function decodeResponseContractText(
  raw: string,
  contract: ModelResponseContract
): ResponseContractDecodeResult {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'invalid' };

  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const structuredOutput = parsed as Record<string, unknown>;
        const text = structuredOutput[contract.textField];
        if (validText(text)) {
          return { kind: 'structured', text, structured_output: structuredOutput };
        }
      }
    } catch {
      if (trimmed.length > MAX_TRUNCATED_RESPONSE_CONTRACT_LENGTH) return { kind: 'invalid' };
      const text = extractTopLevelText(trimmed, contract.textField);
      if (text !== null) {
        return { kind: 'structured', text, structured_output: { [contract.textField]: text } };
      }
    }
    return { kind: 'invalid' };
  }

  if (!contract.allowPlainTextFallback || !validText(raw)) return { kind: 'invalid' };
  return { kind: 'plain_text', text: raw };
}
