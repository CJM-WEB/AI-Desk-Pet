import { ProviderError } from './openai-provider';
import { ProviderResponseError } from './provider-response-error';

export const LOCAL_DECISION_JSON_BYTE_BUDGET = 64 * 1024;
export const LOCAL_THINKING_TAG_PATTERN = /<\/?think(?:\s[^>]*)?>/iu;

/** 只识别两个字符串字段的 JSON 前缀；未完成的转义不参与 JSON.parse。 */
function readDecisionPrefix(raw: string): { kind?: string; text?: string; textComplete?: boolean } | undefined {
  let position = 0;
  const result: { kind?: string; text?: string; textComplete?: boolean } = {};
  const keys = new Set<string>();
  const whitespace = () => { while (/[\t\r\n ]/.test(raw[position] ?? '\0')) position += 1; };
  const readString = () => {
    const match = /^"((?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[\da-fA-F]{4})*)("?)/u.exec(raw.slice(position));
    if (!match) return;
    position += match[0].length;
    return { text: JSON.parse('"' + match[1] + '"') as string, complete: match[2] === '"' };
  };
  whitespace();
  if (raw[position++] !== '{') return;
  for (let field = 0; field < 2; field += 1) {
    whitespace();
    if (position === raw.length) return result;
    const key = readString();
    if (!key) return;
    if (!key.complete) return result;
    if ((key.text !== 'kind' && key.text !== 'text') || keys.has(key.text)) return;
    keys.add(key.text);
    whitespace();
    if (position === raw.length) return result;
    if (raw[position++] !== ':') return;
    whitespace();
    if (position === raw.length) return result;
    const value = readString();
    if (!value) return;
    if (key.text === 'text') { result.text = value.text; result.textComplete = value.complete; }
    else if (value.complete) {
      if (value.text !== 'chat' && value.text !== 'task') return;
      result.kind = value.text;
    }
    if (!value.complete) return result;
    whitespace();
    if (position === raw.length) return result;
    if (raw[position] === '}') {
      position += 1;
      whitespace();
      return position === raw.length && keys.size === 2 ? result : undefined;
    }
    if (raw[position++] !== ',') return;
  }
  return;
}

/** 私有分类未确认时缓冲正文；这里只提供展示增量，最终判定仍由完整响应校验负责。 */
export function createLocalConversationTextStream(onTextDelta: (delta: string) => void): (delta: string) => void {
  let raw = '';
  let emitted = 0;
  return delta => {
    raw += delta;
    if (Buffer.byteLength(raw, 'utf8') > LOCAL_DECISION_JSON_BYTE_BUDGET) {
      throw new ProviderResponseError('RESPONSE_FORMAT_UNSUPPORTED', 'chat_control');
    }
    const prefix = readDecisionPrefix(raw);
    if (prefix?.kind !== 'chat' || prefix.text === undefined) return;
    if (Array.from(prefix.text).length > 4000) throw new ProviderResponseError('RESPONSE_FORMAT_UNSUPPORTED', 'chat_control');
    if (LOCAL_THINKING_TAG_PATTERN.test(prefix.text)) throw new ProviderError('LOCAL_MODEL_REASONING_LEAK', false);

    // 尾部代理对与潜在思考标签保持私有，跨传输块完成后才决定是否可公开。
    let end = prefix.text.length;
    const lastAngle = prefix.text.lastIndexOf('<');
    if (lastAngle >= 0 && !prefix.textComplete) {
      const suffix = prefix.text.slice(lastAngle).toLowerCase();
      if ('<think'.startsWith(suffix) || '</think'.startsWith(suffix) || /^<\/?think\s[^>]*$/u.test(suffix)) end = lastAngle;
    }
    if (!prefix.textComplete && end > 0 && /[\ud800-\udbff]/u.test(prefix.text[end - 1]!)) end -= 1;
    if (end > emitted) {
      const text = prefix.text.slice(emitted, end);
      emitted = end;
      onTextDelta(text);
    }
  };
}
