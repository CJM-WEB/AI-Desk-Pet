export type PublicFileTaskErrorDetails = Readonly<{
  message: string;
  nextAction?: string;
}>;

/** 文件能力跨 Service 与 Adapter 只使用这一份脱敏公开错误定义。 */
const 公开文件错误 = Object.freeze({
  FILE_AUTHORIZATION_REQUIRED: { message: '请先在设置中授权文件目录。' },
  FILE_DISCLOSURE_DENIED: { message: '文件数据类别未授权。' },
  ACTION_EXPIRED: { message: '待确认操作已失效，请重新发起任务。' },
  PATH_INVALID: { message: '文件路径无效。' },
  PATH_OUTSIDE_ROOT: { message: '文件路径超出授权目录。' },
  TARGET_EXISTS: { message: '目标已经存在，未执行覆盖。' },
  ENTRY_NOT_FOUND: { message: '指定条目不存在。' },
  ENTRY_CHANGED: {
    message: '文件在确认后发生变化，未执行操作。',
    nextAction: '请重新发起文件操作并确认最新内容。'
  },
  MOVE_RESULT_UNCERTAIN: {
    message: '文件移动后无法确认最终结果，未报告成功。',
    nextAction: '请检查文件状态后重新发起操作。'
  },
  CROSS_VOLUME_UNSUPPORTED: {
    message: '不支持跨卷移动文件。',
    nextAction: '请选择同一授权目录所在卷内的目标目录。'
  },
  ENTRY_TYPE_UNSUPPORTED: {
    message: '该文件类型或目录状态不支持此操作。',
    nextAction: '请选择普通文本文件、普通文件或空目录后重试。'
  },
  LINK_NOT_ALLOWED: {
    message: '不允许对符号链接或 Junction 执行此文件操作。',
    nextAction: '请选择授权目录内的普通文件或目录。'
  },
  RECYCLE_BIN_FAILED: {
    message: '无法将目标移入 Windows 回收站，原目标仍保留。',
    nextAction: '请检查目标是否被占用或 Windows 回收站是否可用后重试。'
  },
  PERMISSION_DENIED: { message: 'Windows 拒绝了本地文件操作。' },
  TOOL_PERMISSION_DENIED: { message: '该工具操作未获本地权限策略允许。' },
  FILE_TASK_USER_CANCELLED: { message: '文件操作已取消，未执行本地写入。' }
} satisfies Readonly<Record<string, PublicFileTaskErrorDetails>>);

export function publicFileTaskErrorDetails(code: string): PublicFileTaskErrorDetails | null {
  return Object.hasOwn(公开文件错误, code)
    ? 公开文件错误[code as keyof typeof 公开文件错误]
    : null;
}

export function isPublicFileTaskErrorCode(code: string): boolean {
  return publicFileTaskErrorDetails(code) !== null;
}
