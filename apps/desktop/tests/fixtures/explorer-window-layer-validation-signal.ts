export type FixedValidationSignal =
  | 'observe-a' | 'observe-b' | 'observe-a-return'
  | 'observe-single' | 'observe-minimized' | 'observe-restored' | 'observe-closed'
  | 'observe-negative-baseline' | 'observe-negative-restore'
  | 'observe-three-a' | 'observe-three-c'
  | 'observe-three-a-return'
  | 'observe-same-dir-b'
  | 'observe-window-a' | 'observe-window-b' | 'observe-window-a-return';
export type FixedValidationSignalProfile =
  'layer' | 'lifecycle' | 'negative' | 'accuracy-core';
const FIXED_SIGNAL_SEQUENCES: Record<
  FixedValidationSignalProfile,
  readonly FixedValidationSignal[]
> = {
  layer: ['observe-a', 'observe-b', 'observe-a-return'],
  lifecycle: ['observe-single', 'observe-minimized', 'observe-restored', 'observe-closed'],
  negative: ['observe-negative-baseline', 'observe-negative-restore'],
  'accuracy-core': [
    'observe-three-a', 'observe-same-dir-b', 'observe-three-c', 'observe-three-a-return',
    'observe-window-a', 'observe-window-b', 'observe-window-a-return'
  ]
};

/** 只暴露代码内固定序列的副本，调用方不能注入或扩展命令。 */
export function getFixedValidationSignalSequence(
  profile: FixedValidationSignalProfile
): readonly FixedValidationSignal[] {
  return [...FIXED_SIGNAL_SEQUENCES[profile]];
}

interface PendingSignal {
  expected: FixedValidationSignal;
  timeout: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(error: Error): void;
}

/** 每条认证信号流只建立一个持久读取器，跨 A/B/A 阶段保留同 chunk 余行。 */
class FixedValidationSignalReader {
  private readonly queue: string[] = [];
  private buffer = '';
  private pending: PendingSignal | undefined;
  private terminalError: Error | undefined;
  private receivedCount = 0;
  readonly failure: Promise<never>;
  private rejectFailure!: (error: Error) => void;

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly sequence: readonly FixedValidationSignal[]
  ) {
    this.failure = new Promise<never>((_resolve, reject) => { this.rejectFailure = reject; });
    void this.failure.catch(() => undefined);
    input.on('data', this.onData);
    input.once('end', this.onEnd);
    input.once('error', this.onEnd);
  }

  wait(expected: FixedValidationSignal, timeoutMs: number): Promise<void> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
      return Promise.reject(new Error('VALIDATION_MANUAL_TIMEOUT_INVALID'));
    }
    if (this.pending !== undefined) {
      return Promise.reject(new Error('VALIDATION_MANUAL_SIGNAL_CONCURRENT'));
    }
    if (this.queue.length > 0) return this.consume(expected);
    if (this.terminalError !== undefined) return Promise.reject(this.terminalError);

    return new Promise<void>((resolveSignal, reject) => {
      const timeout = setTimeout(() => {
        this.pending = undefined;
        reject(new Error('VALIDATION_MANUAL_SIGNAL_TIMEOUT'));
      }, timeoutMs);
      this.pending = { expected, timeout, resolve: resolveSignal, reject };
    });
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.terminalError !== undefined) return;
    this.buffer += chunk.toString();
    if (this.buffer.length > 256) {
      this.fail(new Error('VALIDATION_MANUAL_SIGNAL_INVALID'));
      return;
    }
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== this.sequence[this.receivedCount]) {
        this.fail(new Error('VALIDATION_MANUAL_SIGNAL_INVALID'));
        return;
      }
      this.receivedCount++;
      this.queue.push(line);
      this.flushPending();
      newline = this.buffer.indexOf('\n');
    }
  };

  private readonly onEnd = (): void => {
    this.fail(new Error('VALIDATION_MANUAL_SIGNAL_ENDED'));
  };

  private flushPending(): void {
    const pending = this.pending;
    if (pending === undefined || this.queue.length === 0) return;
    this.pending = undefined;
    clearTimeout(pending.timeout);
    const actual = this.queue.shift();
    if (actual !== pending.expected) pending.reject(new Error('VALIDATION_MANUAL_SIGNAL_INVALID'));
    else pending.resolve();
  }

  private consume(expected: FixedValidationSignal): Promise<void> {
    const actual = this.queue.shift();
    return actual === expected
      ? Promise.resolve()
      : Promise.reject(new Error('VALIDATION_MANUAL_SIGNAL_INVALID'));
  }

  private fail(error: Error): void {
    if (this.terminalError !== undefined) return;
    this.terminalError = error;
    this.rejectFailure(error);
    const pending = this.pending;
    this.pending = undefined;
    if (pending !== undefined) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.input.off('data', this.onData);
    this.input.off('end', this.onEnd);
    this.input.off('error', this.onEnd);
  }
}

const readers = new WeakMap<NodeJS.ReadableStream, {
  profile: FixedValidationSignalProfile;
  reader: FixedValidationSignalReader;
}>();

function getReader(
  input: NodeJS.ReadableStream,
  profile: FixedValidationSignalProfile
): FixedValidationSignalReader {
  let entry = readers.get(input);
  if (entry === undefined) {
    entry = {
      profile,
      reader: new FixedValidationSignalReader(input, FIXED_SIGNAL_SEQUENCES[profile])
    };
    readers.set(input, entry);
  }
  if (entry.profile !== profile) throw new Error('VALIDATION_MANUAL_PROFILE_MISMATCH');
  return entry.reader;
}

/** Task 0E manual 模式仅等待当前阶段固定信号，最长五分钟。 */
export function waitForFixedValidationSignal(
  input: NodeJS.ReadableStream,
  expected: FixedValidationSignal,
  timeoutMs: number,
  profile: FixedValidationSignalProfile = 'layer'
): Promise<void> {
  return getReader(input, profile).wait(expected, timeoutMs);
}

/** 由 manual 主流程持续竞速读取器的终态错误。 */
export function monitorFixedValidationSignalFailure(
  input: NodeJS.ReadableStream,
  profile: FixedValidationSignalProfile = 'layer'
): Promise<never> {
  return getReader(input, profile).failure;
}
