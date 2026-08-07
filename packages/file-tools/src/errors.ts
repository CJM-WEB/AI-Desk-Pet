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
  | 'ACTION_EXPIRED';

export class FileToolError extends Error {
  constructor(
    public readonly code: FileToolErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'FileToolError';
  }
}
