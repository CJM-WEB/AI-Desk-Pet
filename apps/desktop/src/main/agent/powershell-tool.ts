import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';

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
interface ProcessPort {
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
  environment?: NodeJS.ProcessEnv;
}

const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_STREAM_BYTES = 256 * 1024;
const IDLE_TIMEOUT_MS = 60_000;
const TOTAL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CONFIRMATION_TTL_MS = 120_000;
const ENVIRONMENT_KEYS = ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP'] as const;

/**
 * 前台非交互 PowerShell 深模块。公开确认对象仅是一次性能力票据，完整 cwd 与执行状态始终留在 Main 私有内存。
 * 这不是 OS 沙箱；进程树终止只作尽力清理，不能提供 Job Object 级别的隔离保证。
 */
export class PowerShellTool {
  readonly #processPort: ProcessPort;
  readonly #now: () => number;
  readonly #confirmationTtlMs: number;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #actions = new WeakMap<VerifiedPowerShellAction, InternalAction>();
  #active: ActiveRun | null = null;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: PowerShellToolOptions = {}) {
    this.#processPort = options.processPort ?? createNodeProcessPort();
    this.#now = options.now ?? Date.now;
    this.#confirmationTtlMs = requirePositive(options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS, 'CONFIRMATION_TTL');
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
      let idleTimeout: ReturnType<typeof setTimeout> | undefined;
      let totalTimeout: ReturnType<typeof setTimeout> | undefined;

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
      const finish = async (
        status: PowerShellRunResult['status'],
        timeoutKind: PowerShellRunResult['timeoutKind'],
        exitCode: number | null,
        terminate: boolean
      ): Promise<void> => {
        if (settled) return;
        settled = true;
        clearTimers();
        signal.removeEventListener('abort', onAbort);
        if (this.#active?.child === child) this.#active = null;
        if (terminate) await terminateProcess(this.#processPort, child);
        resolve(createResult(
          status,
          timeoutKind,
          exitCode,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          startedAtMs,
          this.#now()
        ));
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
      child.stdout.setEncoding?.('utf8');
      child.stderr.setEncoding?.('utf8');
      child.stdout.on('data', (chunk: Buffer | string) => append(String(chunk), 'stdout'));
      child.stderr.on('data', (chunk: Buffer | string) => append(String(chunk), 'stderr'));
      child.once('close', (exitCode: number | null) => void finish(
        exitCode === 0 ? 'succeeded' : 'failed',
        null,
        exitCode,
        false
      ));
      child.once('error', () => void finish('failed', null, null, true));
      signal.addEventListener('abort', onAbort, { once: true });
      armIdleTimeout();
      totalTimeout = setTimeout(() => void finish('timed_out', 'total', null, true), TOTAL_TIMEOUT_MS);
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#active === null
      ? Promise.resolve()
      : this.#active.finish('cancelled', null, null, true);
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
    spawn(input): RunningProcess {
      return spawn(input.file, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        shell: input.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }) as unknown as RunningProcess;
    },
    killTree(pid): Promise<void> {
      return new Promise((resolve) => {
        let taskkill: RunningProcess;
        try {
          taskkill = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore'
          }) as unknown as RunningProcess;
        } catch {
          resolve();
          return;
        }
        taskkill.once('error', () => resolve());
        taskkill.once('close', () => resolve());
      });
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

async function terminateProcess(processPort: ProcessPort, child: RunningProcess): Promise<void> {
  try {
    child.kill('SIGTERM');
  } catch {
    // 直接终止失败时仍继续尽力清理可见 pid 的子树。
  }
  if (child.pid === undefined) return;
  try {
    await processPort.killTree(child.pid);
  } catch {
    // taskkill 仅是尽力清理，不影响已确定的取消或超时事实。
  }
}

function requirePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name}_INVALID`);
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isDirectHighRiskCommand(command: string): boolean {
  return /\bstart-process\b[^;\r\n]*-verb\s+runas\b/i.test(command)
    || /\brunas\.exe\b/i.test(command)
    || /\bget-credential\b/i.test(command)
    || /\bcmdkey\b/i.test(command)
    || /\bvaultcmd\b/i.test(command)
    || (/\bremove-item\b(?=[^;\r\n]*-recurse\b)(?=[^;\r\n]*-force\b)/i.test(command));
}
