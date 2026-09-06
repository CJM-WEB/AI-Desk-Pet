import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { fixture, waitForPermission } from './fixture';

test.each([
  { ending: 'cancel', settlement: 'resolve' }, { ending: 'cancel', settlement: 'reject' },
  { ending: 'close', settlement: 'resolve' }, { ending: 'close', settlement: 'reject' }
] as const)('原 runner 回收站 $settlement 结算前 $ending 不完成 run 或 close', async ({ ending, settlement }) => {
  let entered!: () => void;
  let release!: () => void;
  let reject!: (error: Error) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  const calls: string[] = [];
  const f = await fixture([[{ name: 'apply_patch', args: { patchText: '*** Begin Patch\n*** Delete File: note.txt\n*** Add File: late.txt\n+迟到变更\n*** End Patch' } }], '迟到成功'], {
    trashFile: async path => { calls.push(path); entered(); await gate; await rename(path, path + '.trashed'); }
  });
  const controller = new AbortController();
  let run: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  try {
    await writeFile(join(f.directory, 'note.txt'), '原始正文');
    run = f.session.run('删除文件', controller.signal).catch(error => error);
    await f.session.replyPermission((await waitForPermission(f.events, 'delete')).id, 'once');
    await started;
    let runSettled = false;
    void run.then(() => { runSettled = true; });
    if (ending === 'cancel') controller.abort();
    closing = f.session.close();
    // 已确认副作用开始；观察取消是否在受控 Promise 兑现前错误释放 fiber。
    expect(await Promise.race([closing.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('pending'), 100))])).toBe('pending');
    expect(runSettled).toBe(false);
    expect(await readFile(join(f.directory, 'note.txt'), 'utf8')).toBe('原始正文');
    if (settlement === 'resolve') release(); else reject(new Error('回收站拒绝'));
    await Promise.all([run, closing]);
    expect(calls).toEqual([join(await realpath(f.directory), 'note.txt')]);
    expect(await readFile(join(f.directory, settlement === 'resolve' ? 'note.txt.trashed' : 'note.txt'), 'utf8')).toBe('原始正文');
    await expect(readFile(join(f.directory, 'late.txt'))).rejects.toBeDefined();
    expect(f.events.at(-1)).toEqual({ type: 'phase', phase: 'cancelled' });
    expect(f.events).not.toContainEqual({ type: 'phase', phase: 'completed' });
    expect(f.events).not.toContainEqual(expect.objectContaining({ type: 'tool', name: 'apply_patch', status: 'completed' }));
    expect(f.requests).toHaveLength(1);
  } finally { release(); controller.abort(); await run; await closing; await f.close(); }
});

test('原 runner 等待删除许可时仍可取消，回收站零调用', async () => {
  const calls: string[] = [];
  const f = await fixture([[{ name: 'apply_patch', args: { patchText: '*** Begin Patch\n*** Delete File: note.txt\n*** End Patch' } }]], { trashFile: async path => { calls.push(path); } });
  const controller = new AbortController();
  let run: Promise<unknown> | undefined;
  try {
    await writeFile(join(f.directory, 'note.txt'), '原始正文');
    run = f.session.run('删除文件', controller.signal).catch(error => error);
    const permission = await waitForPermission(f.events, 'delete');
    controller.abort();
    await Promise.all([run, f.session.close()]);
    await expect(f.session.replyPermission(permission.id, 'once')).rejects.toBeDefined();
    expect(calls).toEqual([]);
    expect(await readFile(join(f.directory, 'note.txt'), 'utf8')).toBe('原始正文');
    expect(f.events.at(-1)).toEqual({ type: 'phase', phase: 'cancelled' });
  } finally { controller.abort(); await run; await f.close(); }
});

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
