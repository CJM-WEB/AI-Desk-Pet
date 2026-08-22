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

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_RESPONSE_TEXT_LENGTH;
}

function extractClosedText(raw: string, textField: string): string | null {
  const escapedField = textField.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`"${escapedField}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, 'u').exec(raw);
  if (!match?.[1]) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    return validText(value) ? value : null;
  } catch {
    return null;
  }
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
      const text = extractClosedText(trimmed, contract.textField);
      if (text !== null) {
        return { kind: 'structured', text, structured_output: { [contract.textField]: text } };
      }
    }
    return { kind: 'invalid' };
  }

  if (!contract.allowPlainTextFallback || !validText(raw)) return { kind: 'invalid' };
  return { kind: 'plain_text', text: raw };
}
