import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { win32 } from 'node:path';

import {
  createNodeWindowsProcessTreePort,
  terminateExactPidProcessTree,
  type WindowsProcessTreePort
} from './windows-process-tree';

export type VerifiedPowerShellAction = Readonly<{
  kind: 'powershell';
  command: string;
  workingDirectoryLabel: string;
  runMode: 'foreground';
  generation: string;
  expiresAtMs: number;
}>;

export type PowerShellRunResult = Readonly<{
  ok: boolean;
  toolName: 'powershell';
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  timeoutKind: 'idle' | 'total' | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}>;

interface EventSource extends EventEmitter {
  setEncoding?(encoding: BufferEncoding): this;
}

interface RunningProcess extends EventEmitter {
  readonly pid?: number;
  readonly stdout: EventSource;
  readonly stderr: EventSource;
  kill(signal?: NodeJS.Signals): boolean;
}

/** 进程端口只为本模块隔离 Node 子进程细节，测试通过替身驱动所有运行分支。 */
interface ProcessPort extends WindowsProcessTreePort {
  spawn(input: {
    file: 'powershell.exe';
    args: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
    shell: false;
  }): RunningProcess;
  killTree(pid: number): Promise<void>;
}

interface InternalAction {
  readonly workingDirectory: string;
  readonly commandHash: string;
  readonly generation: string;
  readonly expiresAtMs: number;
}

interface ActiveRun {
  readonly child: RunningProcess;
  readonly finish: (
    status: PowerShellRunResult['status'],
    timeoutKind: PowerShellRunResult['timeoutKind'],
    exitCode: number | null,
    terminate: boolean
  ) => Promise<void>;
}

interface PowerShellToolOptions {
  processPort?: ProcessPort;
  now?: () => number;
  confirmationTtlMs?: number;
  cleanupTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
}

const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_STREAM_BYTES = 256 * 1024;
const IDLE_TIMEOUT_MS = 60_000;
const TOTAL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CONFIRMATION_TTL_MS = 120_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;
const ENVIRONMENT_KEYS = ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP'] as const;

/**
 * 前台非交互 PowerShell 深模块。公开确认对象仅是一次性能力票据，完整 cwd 与执行状态始终留在 Main 私有内存。
 * 这不是 OS 沙箱；进程树终止只作尽力清理，不能提供 Job Object 级别的隔离保证。
 */
export class PowerShellTool {
  readonly #processPort: ProcessPort;
  readonly #now: () => number;
  readonly #confirmationTtlMs: number;
  readonly #cleanupTimeoutMs: number;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #actions = new WeakMap<VerifiedPowerShellAction, InternalAction>();
  #active: ActiveRun | null = null;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: PowerShellToolOptions = {}) {
    this.#processPort = options.processPort ?? createNodeProcessPort();
    this.#now = options.now ?? Date.now;
    this.#confirmationTtlMs = requirePositive(options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS, 'CONFIRMATION_TTL');
    this.#cleanupTimeoutMs = requirePositive(options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS, 'CLEANUP_TIMEOUT');
    this.#environment = options.environment ?? process.env;
  }

  preview(input: {
    command: string;
    workingDirectory: string;
    workingDirectoryLabel: string;
    generation: string;
  }): VerifiedPowerShellAction {
    if (this.#closed) throw new Error('POWERSHELL_TOOL_CLOSED');
    if (Buffer.byteLength(input.command, 'utf8') > MAX_COMMAND_BYTES) {
      throw new Error('POWERSHELL_COMMAND_TOO_LONG');
    }
    if (isDirectHighRiskCommand(input.command)) {
      throw new Error('POWERSHELL_COMMAND_REJECTED');
    }
    const expiresAtMs = this.#now() + this.#confirmationTtlMs;
    const action: VerifiedPowerShellAction = Object.freeze({
      kind: 'powershell',
      command: input.command,
      workingDirectoryLabel: input.workingDirectoryLabel,
      runMode: 'foreground',
      generation: input.generation,
      expiresAtMs
    });
    this.#actions.set(action, Object.freeze({
      workingDirectory: input.workingDirectory,
      commandHash: sha256(input.command),
      generation: input.generation,
      expiresAtMs
    }));
    return action;
  }

  execute(action: VerifiedPowerShellAction, signal: AbortSignal): Promise<PowerShellRunResult> {
    const internal = this.#consume(action);
    if (this.#closed) throw new Error('POWERSHELL_TOOL_CLOSED');
    if (this.#active !== null) throw new Error('POWERSHELL_RUN_ACTIVE');

    const startedAtMs = this.#now();
    if (signal.aborted) {
      return Promise.resolve(createResult('cancelled', null, null, '', '', false, false, startedAtMs, this.#now()));
    }

    let child: RunningProcess;
    try {
      child = this.#processPort.spawn({
        file: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', action.command],
        cwd: internal.workingDirectory,
        env: safeEnvironment(this.#environment),
        shell: false
      });
    } catch {
      return Promise.resolve(createResult('failed', null, null, '', '', false, false, startedAtMs, this.#now()));
    }

    return new Promise<PowerShellRunResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;
      let finishPromise: Promise<void> | undefined;
      let idleTimeout: ReturnType<typeof setTimeout> | undefined;
      let totalTimeout: ReturnType<typeof setTimeout> | undefined;
      let resolveChildClosed!: () => void;
      const childClosed = new Promise<void>((resolveChildClose) => {
        resolveChildClosed = resolveChildClose;
      });

      const clearTimers = (): void => {
        if (idleTimeout !== undefined) clearTimeout(idleTimeout);
        if (totalTimeout !== undefined) clearTimeout(totalTimeout);
        idleTimeout = undefined;
        totalTimeout = undefined;
      };
      const armIdleTimeout = (): void => {
        if (idleTimeout !== undefined) clearTimeout(idleTimeout);
        idleTimeout = setTimeout(() => void finish('timed_out', 'idle', null, true), IDLE_TIMEOUT_MS);
      };
      const finish = (
        status: PowerShellRunResult['status'],
        timeoutKind: PowerShellRunResult['timeoutKind'],
        exitCode: number | null,
        terminate: boolean
      ): Promise<void> => {
        if (finishPromise !== undefined) return finishPromise;
        settled = true;
        clearTimers();
        signal.removeEventListener('abort', onAbort);
        finishPromise = (async () => {
          const cleanup = terminate
            ? await terminateProcess(this.#processPort, child, childClosed, this.#cleanupTimeoutMs)
            : { resultTrusted: true, releaseRun: true };
          const finalStatus = cleanup.resultTrusted ? status : 'failed';
          const finalTimeoutKind = cleanup.resultTrusted ? timeoutKind : null;
          if (cleanup.releaseRun && this.#active?.child === child) this.#active = null;
          resolve(createResult(
            finalStatus,
            finalTimeoutKind,
            exitCode,
            stdout,
            stderr,
            stdoutTruncated,
            stderrTruncated,
            startedAtMs,
            this.#now()
          ));
        })();
        return finishPromise;
      };
      const onAbort = (): void => { void finish('cancelled', null, null, true); };
      const append = (value: string, stream: 'stdout' | 'stderr'): void => {
        if (settled) return;
        if (stream === 'stdout') {
          const collected = appendBounded(stdout, value);
          stdout = collected.value;
          stdoutTruncated ||= collected.truncated;
        } else {
          const collected = appendBounded(stderr, value);
          stderr = collected.value;
          stderrTruncated ||= collected.truncated;
        }
        armIdleTimeout();
      };

      this.#active = { child, finish };
      // StringDecoder 保留跨 Buffer 的 UTF-8 半字符，两个流仍独立收集。
      child.stdout.setEncoding?.('utf8');
      child.stderr.setEncoding?.('utf8');
      child.stdout.on('data', (chunk: Buffer | string) => append(String(chunk), 'stdout'));
      child.stderr.on('data', (chunk: Buffer | string) => append(String(chunk), 'stderr'));
      child.once('close', (exitCode: number | null) => {
        resolveChildClosed();
        if (settled && this.#active?.child === child) this.#active = null;
        void finish(exitCode === 0 ? 'succeeded' : 'failed', null, exitCode, false);
      });
      child.once('error', () => void finish('failed', null, null, true));
      signal.addEventListener('abort', onAbort, { once: true });
      armIdleTimeout();
      totalTimeout = setTimeout(() => void finish('timed_out', 'total', null, true), TOTAL_TIMEOUT_MS);
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    const active = this.#active;
    this.#closePromise = active === null
      ? Promise.resolve()
      : (async () => {
          await active.finish('cancelled', null, null, true);
          if (this.#active?.child === active.child) {
            throw new Error('PROCESS_CLEANUP_FAILED');
          }
        })();
    return this.#closePromise;
  }

  #consume(action: VerifiedPowerShellAction): InternalAction {
    const internal = this.#actions.get(action);
    this.#actions.delete(action);
    if (
      internal === undefined
      || action.kind !== 'powershell'
      || action.runMode !== 'foreground'
      || action.expiresAtMs !== internal.expiresAtMs
      || action.generation !== internal.generation
      || sha256(action.command) !== internal.commandHash
      || action.expiresAtMs <= this.#now()
    ) {
      throw new Error('ACTION_EXPIRED');
    }
    return internal;
  }
}

function createNodeProcessPort(): ProcessPort {
  return {
    ...createNodeWindowsProcessTreePort(),
    spawn(input): RunningProcess {
      return spawn(input.file, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        shell: input.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }) as unknown as RunningProcess;
    }
  };
}

function safeEnvironment(environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const key of ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined && value !== '') result[key] = value;
  }
  return Object.freeze(result);
}

function appendBounded(previous: string, chunk: string): { value: string; truncated: boolean } {
  const remaining = MAX_STREAM_BYTES - Buffer.byteLength(previous, 'utf8');
  if (remaining <= 0) return { value: previous, truncated: chunk.length > 0 };
  if (Buffer.byteLength(chunk, 'utf8') <= remaining) return { value: previous + chunk, truncated: false };
  const bytes = Buffer.from(chunk, 'utf8');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = remaining; end > 0; end -= 1) {
    try {
      // 截断点必须落在完整 UTF-8 字符后，替换字符本身也不能突破字节上限。
      return { value: previous + decoder.decode(bytes.subarray(0, end)), truncated: true };
    } catch {
      // UTF-8 最多回退三个字节即可命中字符边界，循环保持逻辑直接且无额外依赖。
    }
  }
  return { value: previous, truncated: true };
}

function createResult(
  status: PowerShellRunResult['status'],
  timeoutKind: PowerShellRunResult['timeoutKind'],
  exitCode: number | null,
  stdout: string,
  stderr: string,
  stdoutTruncated: boolean,
  stderrTruncated: boolean,
  startedAtMs: number,
  endedAtMs: number
): PowerShellRunResult {
  return Object.freeze({
    ok: status === 'succeeded',
    toolName: 'powershell',
    status,
    timeoutKind,
    exitCode,
    stdout,
    stderr,
    stdoutTruncated,
    stderrTruncated,
    durationMs: Math.max(0, endedAtMs - startedAtMs)
  });
}

async function terminateProcess(
  processPort: ProcessPort,
  child: RunningProcess,
  childClosed: Promise<void>,
  cleanupTimeoutMs: number
): Promise<Readonly<{ resultTrusted: boolean; releaseRun: boolean }>> {
  const result = await terminateExactPidProcessTree({
    child,
    processTreePort: processPort,
    cleanupTimeoutMs,
    waitForChildExit: false
  });
  if (result.ok) return { resultTrusted: true, releaseRun: true };
  try {
    // 树终止无法证明时只对原 child 做精确兜底；结果仍降为 failed，运行槽只由真实 close 释放。
    child.kill('SIGKILL');
  } catch {
    // 失败事实由返回值统一进入 ToolResult，不回显系统异常或路径。
  }
  return {
    resultTrusted: false,
    releaseRun: await waitForChildClose(childClosed, cleanupTimeoutMs)
  };
}

function waitForChildClose(childClosed: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(closed);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    void childClosed.then(() => finish(true));
  });
}

function requirePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name}_INVALID`);
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isDirectHighRiskCommand(command: string): boolean {
  return executableStatements(command).some((tokens) => {
    const [rawCommandName, ...argumentsList] = tokens;
    if (rawCommandName === undefined) return false;
    const commandName = normalizeStaticCommandName(rawCommandName);
    if (commandName === 'start-process') {
      return hasToken(argumentsList, '-verb') && hasTokenAfter(argumentsList, '-verb', 'runas');
    }
    if (commandName === 'remove-item') {
      return hasToken(argumentsList, '-recurse') && hasToken(argumentsList, '-force');
    }
    return commandName === 'runas'
      || commandName === 'runas.exe'
      || commandName === 'get-credential'
      || commandName === 'cmdkey'
      || commandName === 'cmdkey.exe'
      || commandName === 'vaultcmd'
      || commandName === 'vaultcmd.exe';
  });
}

/** 路径与模块限定命令只按其静态末段比较，动态调用仍不在本地猜测。 */
function normalizeStaticCommandName(commandName: string): string {
  return win32.basename(commandName).toLowerCase();
}

/**
 * 仅抽取 PowerShell 语句的直接命令位置，不尝试解释脚本语义或构建 AST。
 * 引号内容、注释和帮助参数不是可执行命令；分号、换行、管道与调用运算符才开启下一命令位置。
 */
function executableStatements(source: string): readonly (readonly string[])[] {
  const statements: Array<readonly string[]> = [];
  let tokens: string[] = [];
  let token = '';
  let staticCallPending = false;
  const pushToken = (): void => {
    if (token === '') return;
    tokens.push(token.toLowerCase());
    token = '';
  };
  const finishStatement = (): void => {
    pushToken();
    if (tokens.length > 0) statements.push(tokens);
    tokens = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "'" || character === '"') {
      const quoted = readQuoted(source, index, character);
      if (staticCallPending && token === '') {
        token = quoted.value;
        pushToken();
      }
      staticCallPending = false;
      index = quoted.end;
      continue;
    }
    if ((character === '$' || character === '@') && source[index + 1] === '(') {
      pushToken();
      const end = findClosingDelimiter(source, index + 1, '(', ')');
      statements.push(...executableStatements(source.slice(index + 2, end)));
      staticCallPending = false;
      index = end;
      continue;
    }
    if (character === '(') {
      pushToken();
      const end = findClosingDelimiter(source, index, '(', ')');
      statements.push(...executableStatements(source.slice(index + 1, end)));
      staticCallPending = false;
      index = end;
      continue;
    }
    if (character === '{') {
      pushToken();
      const end = findClosingDelimiter(source, index, '{', '}');
      statements.push(...executableStatements(source.slice(index + 1, end)));
      staticCallPending = false;
      index = end;
      continue;
    }
    if (character === '#') {
      pushToken();
      while (index + 1 < source.length && source[index + 1] !== '\n' && source[index + 1] !== '\r') index += 1;
      staticCallPending = false;
      continue;
    }
    if (character === '&') {
      finishStatement();
      staticCallPending = source[index + 1] !== '&';
      if (source[index + 1] === '&') index += 1;
      continue;
    }
    if (character === ';' || character === '\n' || character === '\r' || character === '|') {
      finishStatement();
      staticCallPending = false;
      continue;
    }
    if (/\s/.test(character)) {
      pushToken();
      continue;
    }
    token += character;
  }
  finishStatement();
  return statements;
}

function readQuoted(source: string, start: number, quote: "'" | '"'): { value: string; end: number } {
  let value = '';
  for (let index = start + 1; index < source.length; index += 1) {
    if (quote === '"' && source[index] === '`') {
      value += source[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (source[index] === quote) {
      if (quote === "'" && source[index + 1] === "'") {
        value += quote;
        index += 1;
        continue;
      }
      return { value, end: index };
    }
    value += source[index];
  }
  return { value, end: source.length };
}

/** 以嵌套深度寻找当前子表达式或脚本块的终点；字符串和注释内的括号不参与计数。 */
function findClosingDelimiter(source: string, start: number, open: '(' | '{', close: ')' | '}'): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "'" || character === '"') {
      index = readQuoted(source, index, character).end;
      continue;
    }
    if (character === '#') {
      while (index + 1 < source.length && source[index + 1] !== '\n' && source[index + 1] !== '\r') index += 1;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length;
}

function hasToken(tokens: readonly string[], expected: string): boolean {
  return tokens.includes(expected);
}

function hasTokenAfter(tokens: readonly string[], before: string, expected: string): boolean {
  const index = tokens.indexOf(before);
  return index >= 0 && tokens[index + 1] === expected;
}
