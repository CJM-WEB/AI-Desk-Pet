import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { basename, isAbsolute } from 'node:path';
import { NodeStream } from '@effect/platform-node';
import { Effect, Layer, Sink, Stream } from 'effect';
import * as PlatformError from 'effect/PlatformError';
import { ChildProcess } from 'effect/unstable/process';
import { ChildProcessSpawner, make, makeHandle, ProcessId, ExitCode } from 'effect/unstable/process/ChildProcessSpawner';
import { which } from '@opencode-ai/core/util/which';
import { verifyExecutable } from './trusted-executable';

export interface WindowsJobHelper { readonly executablePath: string; readonly sha256: string }
const error = (cause: unknown) => PlatformError.systemError({ _tag: 'Unknown', module: 'ChildProcess', method: 'WindowsJob', cause });
const quote = (value: string) => '"' + value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1') + '"';

// 仅实现已核对的 bash/rg 参数形态；未知 FD、后台和流输入明确拒绝。
async function launch(command: ChildProcess.Command, trusted: WindowsJobHelper | undefined, onCleanupFailure: (error: Error) => void) {
  if (command._tag !== 'StandardCommand') throw new Error('Windows Job 不支持管道命令形态');
  const options = command.options;
  if (options.stdin !== 'ignore' || options.detached || options.additionalFds || (options.stdout && options.stdout !== 'pipe') || (options.stderr && options.stderr !== 'pipe')) throw new Error('Windows Job 不支持该进程参数形态');
  const executablePath = await verifyExecutable(trusted);
  const shell = typeof options.shell === 'string' ? options.shell : undefined;
  if (options.shell === true) throw new Error('命令 shell 必须由宿主固定');
  const program = shell ?? command.command;
  const executable = isAbsolute(program) ? program : which(program);
  if (!executable) throw new Error('命令可执行文件不存在');
  if (shell && !/^cmd(?:\.exe)?$/iu.test(basename(shell))) throw new Error('此 shell 必须用显式参数启动');
  const commandLine = shell ? `${quote(executable)} /d /s /c "${command.command}"` : [executable, ...command.args].map(quote).join(' ');
  const cwd = await realpath(options.cwd ? String(options.cwd) : process.cwd());
  const env = { ...(options.extendEnv === false ? {} : process.env), ...options.env };
  const name = 'aipet-job-' + randomUUID().replaceAll('-', '');
  const helper = spawn(executablePath, [name], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let socket: Socket | undefined; let pid = 0; let settled: number | undefined; let rootExited = false;
  let failure: Error | undefined; let ended = false; let cancelSent = false; let buffer = '';
  let readyResolve!: () => void; let readyReject!: (e: Error) => void;
  const ready = new Promise<void>((yes, no) => { readyResolve = yes; readyReject = no; });
  let doneResolve!: (code: number) => void; let doneReject!: (e: Error) => void;
  const done = new Promise<number>((yes, no) => { doneResolve = yes; doneReject = no; });
  void done.catch(() => undefined); void ready.catch(() => undefined);
  const fail = (reason: unknown) => {
    if (failure) return;
    failure = reason instanceof Error ? reason : new Error(String(reason)); onCleanupFailure(failure); readyReject(failure);
    socket?.destroy(); helper.kill(); // 只终止本调用持有的 helper；其 Job 最后句柄关闭是内核兜底，仍报告未确认。
  };
  helper.once('error', fail);
  helper.once('close', code => {
    ended = true; socket?.destroy();
    if (!failure && (code !== 0 || settled === undefined)) fail(new Error('Windows Job 清理未确认：helper 未正常结算'));
    if (failure) { readyReject(failure); doneReject(failure); } else doneResolve(settled!);
  });
  const deadline = setTimeout(() => fail(new Error('Windows Job 启动超时')), 5000);
  const pipe = `\\\\.\\pipe\\${name}`;
  const connectPipe = () => {
    if (ended || failure) return;
    const attempt = connect(pipe);
    attempt.once('error', cause => {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT' && !failure && !ended) setTimeout(connectPipe, 10);
      else fail(cause);
    });
    attempt.once('connect', () => {
      socket = attempt;
      const startup = JSON.stringify({ executable, commandLine, cwd, env });
      if (Buffer.byteLength(startup) > 250000) { fail(new Error('启动参数超过上限')); return; }
      attempt.write(startup + '\n');
      attempt.setEncoding('utf8');
      attempt.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 65536) { fail(new Error('Job 控制消息超过上限')); return; }
        let boundary: number;
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
          try {
            const frame = JSON.parse(line) as { type: string; pid?: number; exit?: number; activeProcesses?: number; cancelled?: boolean };
            if (frame.type === 'ready' && !pid && Number.isSafeInteger(frame.pid) && frame.pid! > 0) { pid = frame.pid!; clearTimeout(deadline); readyResolve(); }
            else if (frame.type === 'root_exit' && pid && !rootExited && settled === undefined && Number.isInteger(frame.exit)) rootExited = true;
            else if (frame.type === 'settled' && pid && (rootExited || (cancelSent && frame.cancelled === true)) && settled === undefined && frame.activeProcesses === 0 && Number.isInteger(frame.exit)) settled = frame.exit!;
            else throw new Error('Windows Job 清理失败或控制消息顺序无效');
          } catch (cause) { fail(cause); }
        }
      });
      attempt.once('end', () => { if (settled === undefined) fail(new Error('Windows Job 控制通道提前断开')); });
    });
  };
  connectPipe();
  try { await ready; } catch (cause) { clearTimeout(deadline); await done.catch(() => undefined); throw cause; }
  const close = async () => {
    if (!ended && settled === undefined && !cancelSent) { cancelSent = true; socket?.write('{"type":"cancel"}\n'); }
    const timeout = setTimeout(() => fail(new Error('Windows Job 清理超时，未确认退出')), 5000);
    try { await done; } finally { clearTimeout(timeout); }
  };
  return { helper, pid, done, close, running: () => !ended && !rootExited };
}

export function windowsJobLayer(trusted: WindowsJobHelper | undefined, onCleanupFailure: (error: Error) => void = () => undefined) {
  return Layer.succeed(ChildProcessSpawner, make(command => Effect.gen(function* () {
    const owned = yield* Effect.acquireRelease(Effect.tryPromise({ try: () => launch(command, trusted, onCleanupFailure), catch: error }), owned => Effect.tryPromise({ try: owned.close, catch: error }).pipe(Effect.orDie));
    const stdout = NodeStream.fromReadable({ evaluate: () => owned.helper.stdout!, onError: error });
    const stderr = NodeStream.fromReadable({ evaluate: () => owned.helper.stderr!, onError: error });
    return makeHandle({ pid: ProcessId(owned.pid), stdout, stderr, all: Stream.merge(stdout, stderr), stdin: Sink.drain,
      getInputFd: () => Sink.drain, getOutputFd: () => Stream.empty,
      exitCode: Effect.tryPromise({ try: () => owned.done.then(ExitCode), catch: error }),
      isRunning: Effect.sync(owned.running), kill: () => Effect.tryPromise({ try: owned.close, catch: error }), unref: Effect.succeed(Effect.void)
    });
  })));
}
