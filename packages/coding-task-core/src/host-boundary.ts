import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';
import { assertUnprotectedFilePath } from '../../file-tools/src/path-policy';

// 完整命令、固定 shell 和真实 cwd 共同形成不可被通配符扩张的资源标识。
export function commandResource(shell: string, cwd: string, command: string): string {
  return 'command-sha256:' + createHash('sha256').update(JSON.stringify([shell, cwd, command])).digest('hex');
}

export async function checkTaskPath(directory: string, input: string): Promise<void> {
  if (!input || input.includes('\0') || /^[\\/]{2}/u.test(input) || /^(?:[a-z]:)?[^]*:/iu.test(input.replace(/^[a-z]:[\\/]/iu, '')) || /^[a-z]:[^\\/]/iu.test(input)) throw new Error('路径格式不允许');
  const absolute = resolve(directory, input);
  assertUnprotectedFilePath(absolute);
  // 所有路径段先完成词法校验；缺失父目录不能跳过其后尚未创建的设备或歧义段。
  const root = parse(absolute).root; let cursor = root;
  const parts = absolute.slice(root.length).split(/[\\/]/u).filter(Boolean);
  for (const part of parts) {
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part) || /[. ]$/u.test(part)) throw new Error('设备或歧义路径不允许');
  }
  // 检查每个存在的祖先，不让 Junction、符号链接或特殊设备进入原文件执行器。
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('链接或特殊条目不允许');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
}
