const STABLE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;

/**
 * 工具失败回注只保留可修复的稳定码；异常正文可能含绝对路径、文件内容或系统信息，
 * 因此绝不能进入模型上下文。
 */
export function createToolFailureResult(toolName: string, error: unknown): Readonly<{
  ok: false;
  toolName: string;
  code: string;
}> {
  const candidate = error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    && STABLE_ERROR_CODE.test(error.code)
    ? error.code
    : 'TOOL_EXECUTION_FAILED';
  return Object.freeze({ ok: false, toolName, code: candidate });
}
