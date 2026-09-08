export type ModelResponseContract = Readonly<{
  type: 'json_object';
  name: 'character_autonomy' | 'character_expression';
  jsonSchema: Readonly<Record<string, unknown>>;
  /** 表现信封必须完整严格有效，不承担聊天正文恢复。 */
  validateStructuredOutput(value: unknown): boolean;
}>;
export type ResponseContractDecodeResult =
  | Readonly<{ kind: 'structured_only'; structured_output: Record<string, unknown> }>
  | Readonly<{ kind: 'invalid' }>;

/** 表现请求只有无正文信封；旧联合协议及截断恢复均已退役。 */
export function decodeResponseContractText(raw: string, contract: ModelResponseContract): ResponseContractDecodeResult {
  if (contract.name !== 'character_expression' && contract.name !== 'character_autonomy') return { kind: 'invalid' };
  if (new TextEncoder().encode(raw).byteLength > 16 * 1024) return { kind: 'invalid' };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !contract.validateStructuredOutput(parsed)) return { kind: 'invalid' };
    return { kind: 'structured_only', structured_output: parsed as Record<string, unknown> };
  } catch { return { kind: 'invalid' }; }
}
