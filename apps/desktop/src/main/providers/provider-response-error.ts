export type ProviderResponseErrorCode =
  | 'HTTP_BODY_NOT_JSON'
  | 'RESPONSE_SHAPE_INVALID'
  | 'CONTROL_SCHEMA_INVALID'
  | 'TOOL_ARGUMENTS_INVALID'
  | 'STREAM_TERMINAL_MISSING'
  | 'RESPONSE_FORMAT_UNSUPPORTED';

export type ProviderResponseErrorStage =
  | 'transport'
  | 'chat_control'
  | 'tool_call'
  | 'stream';

/** 格式故障只携带稳定分类，不保存 Provider 原文、密钥、路径或文件内容。 */
export class ProviderResponseError extends Error {
  readonly name = 'ProviderResponseError';
  readonly retryable = false;

  constructor(
    readonly code: ProviderResponseErrorCode,
    readonly stage: ProviderResponseErrorStage
  ) {
    super(code);
  }
}
