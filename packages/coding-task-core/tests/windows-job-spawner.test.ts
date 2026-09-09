import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import ts from 'typescript';
import { basename, isAbsolute } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { Effect, Exit, Cause, Layer, Stream, Sink } from 'effect';
import { ChildProcess } from 'effect/unstable/process';
import { ChildProcessSpawner, make, makeHandle, ProcessId } from 'effect/unstable/process/ChildProcessSpawner';
import { AppProcess } from '@opencode-ai/core/process';
import { CrossSpawnSpawner } from '@opencode-ai/core/cross-spawn-spawner';
import { LayerNode } from '@opencode-ai/core/effect/layer-node';

import { helper, processRuntime, until, alive } from './windows-fixture';

test('原 Effect timeout 会遮蔽 finalizer Cause 的回归依据', async () => {
  const result = await Effect.runPromiseExit(Effect.scoped(Effect.addFinalizer(() => Effect.die('cleanup-sentinel')).pipe(Effect.andThen(Effect.never))).pipe(Effect.timeoutOrElse({ duration: '10 millis', orElse: () => Effect.fail('timeout') })));
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).not.toContain('cleanup-sentinel');
});

test('AppProcess 超时必须保留底层释放失败', async () => {
  const fake = Layer.succeed(ChildProcessSpawner, make(() => Effect.acquireRelease(Effect.succeed(makeHandle({ pid: ProcessId(1), exitCode: Effect.never, isRunning: Effect.succeed(true), kill: () => Effect.void, stdin: Sink.drain, stdout: Stream.empty, stderr: Stream.empty, all: Stream.empty, getInputFd: () => Sink.drain, getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void) })), () => Effect.die('cleanup-sentinel'))));
  const layer = LayerNode.compile(AppProcess.node, [[CrossSpawnSpawner.node, fake]]);
  const result = await Effect.runPromiseExit(AppProcess.Service.use(p => p.run(ChildProcess.make('unused'), { timeout: '10 millis' })).pipe(Effect.provide(layer)));
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain('cleanup-sentinel');
});

test.runIf(process.platform === 'win32')('Job 返回真实输出、根退出码和中文空格目录', async () => {
  const directory = await mkdtemp(join(tmpdir(), '任务 空格-')); const layer = await processRuntime();
  try {
    const result = await Effect.runPromise(AppProcess.Service.use(p => p.run(ChildProcess.make(process.execPath, ['-e', 'console.log("你好"); console.error("错误流"); process.exit(7)'], { cwd: directory, stdin: 'ignore' }), { timeout: '5 seconds' })).pipe(Effect.provide(layer)));
    expect(result.exitCode).toBe(7); expect(result.stdout.toString()).toContain('你好'); expect(result.stderr.toString()).toContain('错误流');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.runIf(process.platform === 'win32').each(['cancel', 'timeout', 'parent-exit'] as const)('真实父子孙 Job 树：%s 后全部 PID 退出', async mode => {
  const directory = await mkdtemp(join(tmpdir(), '任务 三层树-')); const layer = await processRuntime(); const controller = new AbortController();
  const script = `const fs=require('node:fs'),cp=require('node:child_process'),p=require('node:path'); const d=Number(process.argv[2]); fs.appendFileSync(p.join(__dirname,'pids'),process.pid+'\\n'); if(d>0)cp.spawn(process.execPath,[__filename,String(d-1)],{stdio:'ignore',windowsHide:true}); setInterval(()=>{fs.appendFileSync(p.join(__dirname,'beat-'+d),'x'); if(d===2&&process.argv[3]==='parent-exit'&&fs.readFileSync(p.join(__dirname,'pids'),'utf8').trim().split('\\n').length===3)process.exit(7)},20);`;
  let execution: Promise<unknown> | undefined; let pids: number[] = [];
  try {
    await writeFile(join(directory, 'tree.cjs'), script);
    execution = Effect.runPromise(AppProcess.Service.use(p => p.run(ChildProcess.make(process.execPath, [join(directory, 'tree.cjs'), '2', mode], { cwd: directory, stdin: 'ignore' }), { signal: controller.signal, timeout: mode === 'timeout' ? '1500 millis' : '8 seconds' })).pipe(Effect.provide(layer))).catch(error => error);
    await until(async () => { try { pids = (await readFile(join(directory, 'pids'), 'utf8')).trim().split('\n').map(Number); return pids.length === 3; } catch { return false; } });
    if (mode === 'cancel') { expect(pids.every(alive)).toBe(true); controller.abort(); }
    const result = await execution;
    if (mode === 'parent-exit') expect(result).toMatchObject({ exitCode: 7 });
    else expect(result).not.toHaveProperty('exitCode', 0);
    await until(async () => pids.every(pid => !alive(pid)));
    const snapshots = await Promise.all([0, 1, 2].map(d => readFile(join(directory, 'beat-' + d), 'utf8').catch(() => '')));
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(await Promise.all([0, 1, 2].map(d => readFile(join(directory, 'beat-' + d), 'utf8').catch(() => '')))).toEqual(snapshots);
  } finally { controller.abort(); await execution; await rm(directory, { recursive: true, force: true }); }
}, 15000);

test.runIf(process.platform === 'win32').each(['bind', 'terminate', 'query', 'active'] as const)('真实 helper 故障注入 %s 明确失败且无残留', async mode => {
  const directory = await mkdtemp(join(tmpdir(), '任务 故障-')); const failures: Error[] = [];
  let execution: Promise<unknown> | undefined;
  const controller = new AbortController();
  try {
    let source = await readFile(resolve(import.meta.dirname, '../native/windows-job-helper.cs'), 'utf8');
    if (mode === 'bind') source = source.replace('Check(UpdateProcThreadAttribute(si.Attributes, 0, new IntPtr(0x2000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "JOB_LIST");', 'Check(false, "JOB_LIST 故障注入");');
    if (mode === 'terminate') source = source.replace('Check(TerminateJobObject(job, 1), "TerminateJobObject");', 'Check(false, "TerminateJobObject 故障注入");');
    if (mode === 'query') source = source.replace('Accounting info; Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "QueryInformationJobObject");', 'Accounting info = new Accounting(); Check(false, "QueryInformationJobObject 故障注入");');
    if (mode === 'active') source = source.replace('if (info.ActiveProcesses == 0) return;', 'if (info.ActiveProcesses == uint.MaxValue) return;');
    const input = join(directory, 'fault.cs'), executablePath = join(directory, 'fault.exe');
    await writeFile(input, source);
    execFileSync(join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/r:System.Web.Extensions.dll', '/out:' + executablePath, input], { windowsHide: true, stdio: 'pipe' });
    const layer = await processRuntime({ executablePath, sha256: createHash('sha256').update(await readFile(executablePath)).digest('hex') }, failure => failures.push(failure));
    execution = Effect.runPromiseExit(AppProcess.Service.use(p => p.run(ChildProcess.make(process.execPath, ['-e', 'require("node:fs").writeFileSync("pid",String(process.pid)); setInterval(()=>{},100)'], { cwd: directory, stdin: 'ignore' }), { signal: controller.signal, timeout: '8 seconds' })).pipe(Effect.provide(layer)));
    // 清理故障必须在目标真实启动后触发，不能以机器启动速度作为测试前提。
    if (mode !== 'bind') {
      await until(async () => { try { return Number(await readFile(join(directory, 'pid'), 'utf8')) > 0; } catch { return false; } });
      controller.abort();
    }
    const result = await execution;
    expect(Exit.isFailure(result as Exit.Exit<unknown, unknown>)).toBe(true);
    expect(failures.length).toBeGreaterThan(0);
    if (mode === 'bind') await expect(readFile(join(directory, 'pid'))).rejects.toBeDefined();
    else { const pid = Number(await readFile(join(directory, 'pid'), 'utf8')); await until(async () => !alive(pid)); }
  } finally { controller.abort(); await execution; await rm(directory, { recursive: true, force: true }); }
}, 15000);

test.runIf(process.platform === 'win32')('helper 在 READY 后异常退出时内核清理目标并报告未确认', async () => {
  const directory = await mkdtemp(join(tmpdir(), '任务 helper崩溃-')); const failures: Error[] = []; const layer = await processRuntime(await helper(), e => failures.push(e));
  try {
    const result = await Effect.runPromiseExit(AppProcess.Service.use(p => p.run(ChildProcess.make(process.execPath, ['-e', 'require("node:fs").writeFileSync("pid",String(process.pid)); setTimeout(()=>process.kill(process.ppid),300); setInterval(()=>{},100)'], { cwd: directory, stdin: 'ignore' }), { timeout: '5 seconds' })).pipe(Effect.provide(layer)));
    expect(Exit.isFailure(result)).toBe(true); expect(failures.length).toBeGreaterThan(0);
    const pid = Number(await readFile(join(directory, 'pid'), 'utf8')); await until(async () => !alive(pid));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.runIf(process.platform === 'win32')('两个独立 Job 只取消 A，B 继续写入', async () => {
  const directory = await mkdtemp(join(tmpdir(), '任务 隔离-')); const layer = await processRuntime(); const a = new AbortController(), b = new AbortController();
  const run = (name: string, signal: AbortSignal) => Effect.runPromise(AppProcess.Service.use(p => p.run(ChildProcess.make(process.execPath, ['-e', `const fs=require('node:fs');fs.writeFileSync('${name}.pid',String(process.pid));fs.writeFileSync('${name}.helper-pid',String(process.ppid));setInterval(()=>fs.appendFileSync('${name}.beat','x'),20)`], { cwd: directory, stdin: 'ignore' }), { signal, timeout: '8 seconds' })).pipe(Effect.provide(layer))).catch(error => error);
  const pa = run('a', a.signal), pb = run('b', b.signal);
  try {
    await until(async () => { try { return (await readFile(join(directory, 'a.beat'))).length > 0 && (await readFile(join(directory, 'b.beat'))).length > 0; } catch { return false; } });
    a.abort(); await pa; const first = (await readFile(join(directory, 'b.beat'))).length;
    await until(async () => (await readFile(join(directory, 'b.beat'))).length > first);
    expect(alive(Number(await readFile(join(directory, 'a.pid'), 'utf8')))).toBe(false);
    expect(alive(Number(await readFile(join(directory, 'a.helper-pid'), 'utf8')))).toBe(false);
    expect(alive(Number(await readFile(join(directory, 'b.pid'), 'utf8')))).toBe(true);
  } finally {
    a.abort(); b.abort(); await Promise.all([pa, pb]);
    const pids = await Promise.all(['a.pid', 'a.helper-pid', 'b.pid', 'b.helper-pid'].map(name => readFile(join(directory, name), 'utf8').then(Number)));
    await until(async () => pids.every(pid => !alive(pid)));
    // 目标与两个 Job 外 helper 均已退出后，测试 cwd 的文件系统释放可能短暂返回 EBUSY；最多重试五次。
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('命令输出不能伪造控制帧，输出上限与目标退出码保持独立', async () => {
  const layer = await processRuntime();
  const result = await Effect.runPromise(AppProcess.Service.use(p => p.run(ChildProcess.make(process.execPath, ['-e', 'console.log(JSON.stringify({type:"settled",exit:0,activeProcesses:0})); console.log("x".repeat(200000)); process.exit(71)'], { stdin: 'ignore' }), { maxOutputBytes: 1024, timeout: '5 seconds' })).pipe(Effect.provide(layer)));
  expect(result.exitCode).toBe(71); expect(result.stdoutTruncated).toBe(true); expect(result.stdout.length).toBe(1024); expect(result.stdout.toString()).toContain('"type":"settled"');
});

// 仅注入外部进程/管道事件；执行从生产文件读取并去类型的原 launch 函数，不复制状态机。
test.each(['normal', 'reordered', 'partial', 'missing', 'invalid-active', 'nonzero', 'silent'] as const)('独立控制管道与 helper 退出顺序：%s', async mode => {
  const source = await readFile(resolve(import.meta.dirname, '../src/windows-job-spawner.ts'), 'utf8');
  const start = source.indexOf('async function launch(');
  const end = source.indexOf('\nexport function windowsJobLayer', start);
  const quote = source.slice(source.indexOf('const quote ='), source.indexOf('\n', source.indexOf('const quote =')));
  const code = ts.transpileModule(quote + '\n' + source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const helper = Object.assign(new EventEmitter(), { kill: () => true });
  let destroyed = false;
  const socket = Object.assign(new EventEmitter(), { destroy: () => { destroyed = true; }, write: () => true, setEncoding: () => undefined });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const failures: Error[] = [];
  const context = { Buffer, Error, process: { cwd: () => 'C:/fixture', env: {} }, basename, isAbsolute,
    randomUUID: () => 'fixture', realpath: async (value: string) => value,
    verifyExecutable: async () => 'C:/fixture/helper.exe', which: (value: string) => value,
    spawn: () => helper, connect: () => socket,
    setTimeout: (callback: () => void, delay: number) => { const timer = setTimeout(callback, Math.min(delay, 50)); timers.add(timer); return timer; },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer); timers.delete(timer); }
  };
  vm.createContext(context);
  vm.runInContext(code + '\nglobalThis.launchForTest = launch;', context);
  type Owned = { done: Promise<number>; close(): Promise<void> };
  const launch = (context as typeof context & { launchForTest(command: unknown, trusted: unknown, onFailure: (error: Error) => void): Promise<Owned> }).launchForTest;
  try {
    const pending = launch({ _tag: 'StandardCommand', command: 'C:/fixture/target.exe', args: [], options: { stdin: 'ignore' } }, {}, error => failures.push(error));
    await new Promise(resolve => setImmediate(resolve));
    socket.emit('connect'); socket.emit('data', '{"type":"ready","pid":123}\n');
    const owned = await pending;
    const outcome = owned.done.then(exit => ({ exit }), () => ({ failed: true }));
    socket.emit('data', '{"type":"root_exit","exit":7}\n');
    const frame = '{"type":"settled","exit":7,"activeProcesses":0}\n';
    if (mode === 'normal') { socket.emit('data', frame); helper.emit('close', 0); }
    else if (mode === 'reordered' || mode === 'partial') {
      if (mode === 'partial') socket.emit('data', frame.slice(0, 20));
      helper.emit('close', 0);
      expect(destroyed).toBe(false);
      expect(failures).toHaveLength(0);
      socket.emit('data', mode === 'partial' ? frame.slice(20) : frame);
    } else if (mode === 'missing') { helper.emit('close', 0); socket.emit('end'); }
    else if (mode === 'invalid-active') { socket.emit('data', frame.replace('"activeProcesses":0', '"activeProcesses":1')); helper.emit('close', 0); }
    else if (mode === 'nonzero') { socket.emit('data', frame); helper.emit('close', 1); }
    else helper.emit('close', 0);
    if (['normal', 'reordered', 'partial'].includes(mode)) {
      expect(await outcome).toEqual({ exit: 7 });
      await owned.close();
      expect(failures).toHaveLength(0);
    } else {
      expect(await outcome).toEqual({ failed: true });
      await expect(owned.close()).rejects.toBeDefined();
      expect(failures).toHaveLength(1);
    }
    expect(destroyed).toBe(true);
  } finally { for (const timer of timers) clearTimeout(timer); helper.removeAllListeners(); socket.removeAllListeners(); }
});
