export type FileToolErrorCode =
  | 'PATH_INVALID'
  | 'PATH_OUTSIDE_ROOT'
  | 'ENTRY_NOT_FOUND'
  | 'TARGET_EXISTS'
  | 'ENTRY_TYPE_UNSUPPORTED'
  | 'LINK_NOT_ALLOWED'
  | 'PERMISSION_DENIED'
  | 'ENTRY_CHANGED'
  | 'RECYCLE_BIN_FAILED'
  | 'CROSS_DEVICE_MOVE_NOT_ALLOWED'
  | 'ACTION_EXPIRED';

export class FileToolError extends Error {
  constructor(
    public readonly code: FileToolErrorCode,
    message: string,
    _options?: ErrorOptions
  ) {
    // 底层异常可能含绝对路径或正文；稳定边界只公开 code 与安全中文消息。
    super(message);
    this.name = 'FileToolError';
  }
}
