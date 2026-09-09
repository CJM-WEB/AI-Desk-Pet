import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export interface TrustedExecutable { readonly executablePath: string; readonly sha256: string }
// 每次执行核对宿主固定路径和内容；不搜索 PATH，不自动下载或编译程序。
export async function verifyExecutable(trusted: TrustedExecutable | undefined): Promise<string> {
  if (!trusted || !isAbsolute(trusted.executablePath) || !/^[a-f0-9]{64}$/u.test(trusted.sha256)) throw new Error('可信可执行程序未配置');
  if (!(await lstat(trusted.executablePath)).isFile()) throw new Error('可信程序必须是普通文件');
  const executable = await realpath(trusted.executablePath);
  if (createHash('sha256').update(await readFile(executable)).digest('hex') !== trusted.sha256) throw new Error('可信程序哈希不匹配');
  return executable;
}
