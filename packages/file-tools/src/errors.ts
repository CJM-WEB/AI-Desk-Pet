export type FileToolErrorCode =
  | 'PATH_INVALID'
  | 'PATH_OUTSIDE_ROOT'
  | 'ENTRY_NOT_FOUND'
  | 'TARGET_EXISTS'
  | 'ENTRY_TYPE_UNSUPPORTED'
  | 'LINK_NOT_ALLOWED'
  | 'PERMISSION_DENIED'
  | 'ENTRY_CHANGED'
  | 'MOVE_RESULT_UNCERTAIN'
  | 'CROSS_VOLUME_UNSUPPORTED'
  | 'RECYCLE_BIN_FAILED'
  | 'ACTION_EXPIRED';

export class FileToolError extends Error {
  constructor(
    public readonly code: FileToolErrorCode,
    message: string,
    _options?: ErrorOptions
  ) {
    // 底层异常可能包含绝对路径或正文；稳定边界只公开 code 与安全中文消息。
    super(message);
    this.name = 'FileToolError';
  }
}
