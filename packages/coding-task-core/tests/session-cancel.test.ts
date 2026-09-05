import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { fixture } from './fixture';

test.runIf(process.platform === 'win32')('helper 缺失时批准命令也不得启动目标', async () => {
  const command = 'echo unexpected>started.txt';
  const f = await fixture([[{ name: 'bash', args: { command } }], '结束'], { approvedCommands: [command], onEvent: event => {
    if (event.type === 'permission') queueMicrotask(() => { void f.session.replyPermission(event.id, 'once'); });
  } });
  try {
    await f.session.run('执行命令', new AbortController().signal);
    await expect(readFile(join(f.directory, 'started.txt'))).rejects.toBeDefined();
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'tool', name: 'bash', status: 'failed' }));
  } finally { await f.close(); }
});

test.runIf(process.platform === 'win32').each(['cancel', 'close', 'powershell'] as const)('原 runner bash 生命周期：%s 等待真实进程退出', async mode => {
  const { helper, until, alive } = await import('./windows-fixture');
  const shell = mode === 'powershell' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : undefined;
  const command = 'node tree.cjs';
  const f = await fixture([[{ name: 'bash', args: { command } }], '迟到成功'], { approvedCommands: [command], windowsJobHelper: await helper(), ...(shell ? { commandShell: shell } : {}) });
  const controller = new AbortController(); let execution: Promise<unknown> | undefined;
  try {
    await writeFile(join(f.directory, 'tree.cjs'), 'const fs=require("node:fs"),cp=require("node:child_process"); const d=Number(process.argv[2]||2);fs.appendFileSync("pids",process.pid+"\\n"); if(d)cp.spawn(process.execPath,[__filename,String(d-1)],{stdio:"ignore",windowsHide:true});setInterval(()=>fs.appendFileSync("beat"+d,"x"),20);');
    execution = f.session.run('执行测试任务', controller.signal).catch(error => error);
    let pids: number[] = [];
    await until(async () => { try { pids = (await readFile(join(f.directory, 'pids'), 'utf8')).trim().split('\n').map(Number); return pids.length === 3; } catch { return false; } });
    if (mode === 'close') await Promise.all([f.session.close(), f.session.close()]); else controller.abort();
    await execution;
    expect(pids.every(pid => !alive(pid))).toBe(true);
    expect(f.events.at(-1)).toEqual({ type: 'phase', phase: 'cancelled' });
    expect(f.events).not.toContainEqual({ type: 'phase', phase: 'completed' });
    expect(f.requests).toHaveLength(1);
  } finally { controller.abort(); await execution; await f.close(); }
}, 15000);

test('helper 与 rg 哈希不匹配均在目标执行前拒绝', async () => {
  const { helper, ripgrepExecutable } = await import('./windows-fixture');
  const f = await fixture([[{ name: 'bash', args: { command: 'echo unexpected>marker' } }], [{ name: 'glob', args: { pattern: '*' } }], '结束'], { approvedCommands: ['echo unexpected>marker'], windowsJobHelper: { ...await helper(), sha256: '0'.repeat(64) }, ripgrepExecutable: { ...await ripgrepExecutable(), sha256: '0'.repeat(64) } });
  try {
    await f.session.run('执行任务', new AbortController().signal);
    await expect(readFile(join(f.directory, 'marker'))).rejects.toBeDefined();
    expect(f.events.filter(e => e.type === 'tool' && e.status === 'failed')).toHaveLength(2);
  } finally { await f.close(); }
});

test('搜索缺少可信 rg 时拒绝使用 PATH 程序或自动下载', async () => {
  const { helper } = await import('./windows-fixture');
  const f = await fixture([[{ name: 'glob', args: { pattern: '*' } }], '结束'], { windowsJobHelper: await helper() });
  try {
    await f.session.run('搜索文件', new AbortController().signal);
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'tool', name: 'glob', status: 'failed' }));
  } finally { await f.close(); }
});

test.runIf(process.platform === 'win32')('原 runner 的清理未确认产生失败并拒绝继续执行命令', async () => {
  const { helper, alive, until } = await import('./windows-fixture'); const trusted = await helper();
  const command = '$root=Get-CimInstance Win32_Process -Filter "ProcessId = $PID"; $parent=Get-CimInstance Win32_Process -Filter "ProcessId = $($root.ParentProcessId)"; if($parent.ExecutablePath -ne ' + "'" + trusted.executablePath.replaceAll("'", "''") + "'" + '){throw "unexpected parent"}; Set-Content -LiteralPath root-pid -Value $PID; Stop-Process -Id $root.ParentProcessId -Force; Start-Sleep -Seconds 5';
  const f = await fixture([[{ name: 'bash', args: { command } }], [{ name: 'bash', args: { command: 'echo late>late.txt' } }], '迟到成功'], { approvedCommands: [command, 'echo late>late.txt'], commandShell: join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), windowsJobHelper: trusted });
  try {
    // 仅对当前根进程直接父级且路径匹配的本次 helper 注入崩溃，不使用进程名扫描。
    await expect(f.session.run('执行任务', new AbortController().signal)).rejects.toBeDefined();
    const pid = Number((await readFile(join(f.directory, 'root-pid'), 'utf8')).trim()); await until(async () => !alive(pid));
    expect(f.events.at(-1)).toEqual({ type: 'phase', phase: 'failed' });
    await expect(f.session.run('继续', new AbortController().signal)).rejects.toBeDefined();
    await expect(readFile(join(f.directory, 'late.txt'))).rejects.toBeDefined();
    expect(f.events).not.toContainEqual({ type: 'phase', phase: 'completed' });
    await expect(f.session.close()).rejects.toBeDefined();
    await expect(f.session.close()).rejects.toBeDefined();
  } finally { await f.close().catch(() => undefined); }
}, 15000);
