import { expect, test } from 'vitest';
import { fixture } from './fixture';
import { checkTaskPath } from '../src/host-boundary';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test.each(['NUL', 'CON', 'trailing.', 'trailing '])('缺失父目录后仍拒绝设备或歧义段 %s', async tail => {
  const f = await fixture([]);
  try {
    // 直接验证生产保护函数，避免失败实现实际创建 Windows 设备路径。
    await expect(checkTaskPath(f.directory, `new-parent/deeper/${tail}`)).rejects.toThrow('设备或歧义路径不允许');
  } finally { await f.close(); }
});

test('允许普通缺失多层目录的新文件创建', async () => {
  const f = await fixture([[{ name: 'write', args: { path: 'new-parent/deeper/note.txt', content: '正常创建' } }], '结束']);
  try {
    await f.session.run('创建多层文件', new AbortController().signal);
    expect(await readFile(join(f.directory, 'new-parent/deeper/note.txt'), 'utf8')).toBe('正常创建');
  } finally { await f.close(); }
});

test.each(['note.txt:secret', '\\\\?\\C:\\Windows\\win.ini', '\\\\server\\share\\file', '../escape.txt', 'C:relative.txt', 'NUL', process.env.SystemRoot ?? 'C:\\Windows'])('原文件入口拒绝非法或系统路径 %s', async path => {
  const f = await fixture([[{ name: 'write', args: { path, content: 'unexpected' } }], '结束']);
  try {
    await f.session.run('写入文件', new AbortController().signal);
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'tool', name: 'write', status: 'failed' }));
    expect(f.events.filter(e => e.type === 'permission')).toEqual([]);
  } finally { await f.close(); }
});
