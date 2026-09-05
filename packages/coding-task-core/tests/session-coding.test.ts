import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { fixture } from './fixture';
import { helper, ripgrepExecutable } from './windows-fixture';

test('原 runner 完成搜索、编辑、真实失败测试、修复再测试的六工具闭环', async () => {
  const f = await fixture([
    [{ name: 'glob', args: { pattern: '*.cjs' } }],
    [{ name: 'read', args: { path: 'value.cjs' } }],
    [{ name: 'edit', args: { path: 'value.cjs', oldString: '= 1', newString: '= 2' } }],
    [{ name: 'bash', args: { command: 'node check.cjs' }, id: 'failed_check' }],
    [{ name: 'edit', args: { path: 'value.cjs', oldString: '= 2', newString: '= 3' } }],
    [{ name: 'bash', args: { command: 'node check.cjs' }, id: 'passed_check' }], '已完成修复'
  ], { approvedCommands: ['node check.cjs'], windowsJobHelper: await helper(), ripgrepExecutable: await ripgrepExecutable() });
  try {
    await writeFile(join(f.directory, 'value.cjs'), 'module.exports = 1;\n');
    await writeFile(join(f.directory, 'check.cjs'), 'const assert = require("node:assert/strict"); assert.equal(require("./value.cjs"), 3); console.log("checked-three");\n');
    const result = await f.session.run('查找并修复测试', new AbortController().signal);
    expect(result.toolCalls).toBe(6);
    expect(await readFile(join(f.directory, 'value.cjs'), 'utf8')).toBe('module.exports = 3;\n');
    const returned = f.requests.at(-1)?.messages.filter(m => m.role === 'tool');
    expect(JSON.stringify(returned?.find(m => m.tool_call_id === 'failed_check')?.content)).toContain('code 1');
    expect(JSON.stringify(returned?.find(m => m.tool_call_id === 'passed_check')?.content)).toContain('checked-three');
    expect(JSON.stringify(returned?.find(m => m.tool_call_id === 'passed_check')?.content)).toContain('code 0');
    expect(f.events.at(-1)).toEqual({ type: 'phase', phase: 'completed' });
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'tool', callId: 'failed_check', facts: { exit: 1, truncated: false } }));
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'tool', callId: 'passed_check', facts: { exit: 0, truncated: false } }));
    expect(f.events.filter(e => e.type === 'permission')).toEqual([]);
    expect(f.events.filter(e => e.type === 'tool' && e.status === 'completed')).toHaveLength(6);
  } finally { await f.close(); }
});

test('递归 grep 不读取或返回受保护配置文件', async () => {
  const f = await fixture([[{ name: 'grep', args: { pattern: 'nonce', path: '.' } }], '结束'], { windowsJobHelper: await helper(), ripgrepExecutable: await ripgrepExecutable() });
  try {
    await mkdir(join(f.directory, '.codex')); await writeFile(join(f.directory, '.codex', 'settings.json'), 'private-nonce');
    await writeFile(join(f.directory, '.npmrc'), 'registry-secret-nonce'); await writeFile(join(f.directory, 'normal.txt'), 'public-nonce');
    await f.session.run('搜索 nonce', new AbortController().signal);
    const results = JSON.stringify(f.requests.at(-1)?.messages.filter(m => m.role === 'tool'));
    expect(results).toContain('public-nonce'); expect(results).not.toContain('private-nonce'); expect(results).not.toContain('registry-secret-nonce');
  } finally { await f.close(); }
});

test('原 grep、apply_patch 和 todowrite 均执行真实项目任务', async () => {
  const f = await fixture([
    [{ name: 'grep', args: { pattern: 'needle', path: '.' } }],
    [{ name: 'apply_patch', args: { patchText: '*** Begin Patch\n*** Update File: note.txt\n@@\n-needle\n+changed\n*** Add File: new.txt\n+created\n*** End Patch' } }],
    [{ name: 'todowrite', args: { todos: [{ content: '修改文件', status: 'completed', priority: 'high' }] } }], '完成'
  ], { windowsJobHelper: await helper(), ripgrepExecutable: await ripgrepExecutable() });
  try {
    await writeFile(join(f.directory, 'note.txt'), 'needle\n');
    await f.session.run('搜索后补丁修改', new AbortController().signal);
    expect(JSON.stringify(f.requests[1]?.messages.filter(m => m.role === 'tool'))).toContain('needle');
    expect(await readFile(join(f.directory, 'note.txt'), 'utf8')).toBe('changed\n');
    expect(await readFile(join(f.directory, 'new.txt'), 'utf8')).toBe('created\n');
    expect(f.events.filter(e => e.type === 'tool' && e.status === 'completed').map(e => e.type === 'tool' && e.name)).toEqual(['grep', 'apply_patch', 'todowrite']);
  } finally { await f.close(); }
});

test.runIf(process.platform === 'win32')('真实 PowerShell 原生命令 stdout/stderr 中文完整返回', async () => {
  const command = 'Write-Output "中文输出"; [Console]::Error.WriteLine("中文错误"); exit 7';
  const f = await fixture([[{ name: 'bash', args: { command } }], '结束'], { approvedCommands: [command], commandShell: join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), windowsJobHelper: await helper() });
  try {
    await f.session.run('运行中文输出测试', new AbortController().signal);
    const results = JSON.stringify(f.requests.at(-1)?.messages.filter(m => m.role === 'tool'));
    expect(results).toContain('中文输出'); expect(results).toContain('中文错误'); expect(results).toContain('code 7');
  } finally { await f.close(); }
});
