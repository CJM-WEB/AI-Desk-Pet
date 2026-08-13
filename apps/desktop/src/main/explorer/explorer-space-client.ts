import { spawn as spawnProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { win32 } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import {
  EXPLORER_SPACE_MAX_LINE_BYTES,
  EXPLORER_SPACE_PROTOCOL_VERSION,
  parseBridgeLine,
  parseBridgeStderrLine,
  serializeBridgeCommand,
  type ExplorerBridgeCommand,
  type ExplorerSnapshot
} from './explorer-space-protocol';

export interface ExplorerBridgeChild extends EventEmitter {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Writable;
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ExplorerBridgeSpawnSpec {
  executable: string;
  args: string[];
  options: SpawnOptions;
}

export interface ExplorerSpaceClientSnapshot {
  state: 'idle' | 'starting' | 'ready' | 'closing' | 'closed' | 'failed';
  errorCode?: string;
}

interface PendingRequest {
  timeout: ReturnType<typeof setTimeout>;
  resolve(value: { ok: true }): void;
  reject(error: Error): void;
}

type ExplorerBridgeCommandInput =
  | { command: 'start-observing' }
  | { command: 'stop-observing' }
  | { command: 'shutdown' };

interface ExplorerSpaceClientOptions {
  spawn?: () => ExplorerBridgeChild;
  spawnSpec?: ExplorerBridgeSpawnSpec;
  helloTimeoutMs?: number;
  observationTimeoutMs?: number;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
}

export function buildExplorerBridgeSpawnSpec(input: {
  windowsDirectory: string;
  resourceRoot: string;
  tempDirectory: string;
}): ExplorerBridgeSpawnSpec {
  const systemRoot = win32.normalize(input.windowsDirectory);
  const executable = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const scriptPath = win32.join(input.resourceRoot, 'windows', 'explorer-space-bridge.ps1');
  return {
    executable,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath],
    options: {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        ComSpec: win32.join(systemRoot, 'System32', 'cmd.exe'),
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        TEMP: input.tempDirectory,
        TMP: input.tempDirectory
      }
    }
  };
}

/** 管理固定桥接进程；所有窗口能力均通过严格协议收口。 */
export class ExplorerSpaceClient extends EventEmitter {
  private readonly requestTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly helloTimeoutMs: number;
  private readonly observationTimeoutMs: number;
  private child: ExplorerBridgeChild | undefined;
  private state: ExplorerSpaceClientSnapshot['state'] = 'idle';
  private errorCode: string | undefined;
  private nonce: string | undefined;
  private verifiedPid: number | undefined;
  private lastSequence = -1;
  private nextRequestId = 1;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private startPromise: Promise<void> | undefined;
  private restartPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private closeInProgress = false;
  private closeIntentToken = 0;
  private resolveStart: (() => void) | undefined;
  private rejectStart: ((error: Error) => void) | undefined;
  private helloTimeout: ReturnType<typeof setTimeout> | undefined;
  private observationTimeout: ReturnType<typeof setTimeout> | undefined;
  private bridgeGeneration = 0;
  private childTerminated = false;
  private childExited = false;
  private cleanupPromise: Promise<void> | undefined;
  private shutdownRequestId: string | undefined;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly options: ExplorerSpaceClientOptions) {
    super();
    this.helloTimeoutMs = options.helloTimeoutMs ?? 5_000;
    this.observationTimeoutMs = options.observationTimeoutMs ?? 5_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  }

  snapshot(): ExplorerSpaceClientSnapshot {
    return this.errorCode === undefined ? { state: this.state } : { state: this.state, errorCode: this.errorCode };
  }

  start(): Promise<void> {
    if (this.state === 'starting' || this.state === 'ready') {
      return this.startPromise ?? Promise.resolve();
    }
    if (this.state === 'closing') {
      return Promise.reject(new Error('BRIDGE_CLOSE_IN_PROGRESS'));
    }
    if (this.state === 'failed') {
      if (this.closeInProgress) {
        return Promise.reject(new Error('BRIDGE_CLOSE_IN_PROGRESS'));
      }
      if (this.child === undefined || this.childExited) {
        return this.beginGeneration();
      }
      if (this.cleanupPromise === undefined) {
        return Promise.reject(new Error('BRIDGE_PREVIOUS_PROCESS_ACTIVE'));
      }
      if (this.restartPromise !== undefined) return this.restartPromise;
      const generation = this.bridgeGeneration;
      const closeIntent = this.closeIntentToken;
      const restarting = this.cleanupPromise.then(() => {
        if (
          generation !== this.bridgeGeneration
          || closeIntent !== this.closeIntentToken
          || this.closeInProgress
          || this.state !== 'failed'
        ) throw new Error('BRIDGE_RESTART_CANCELLED');
        if (this.child !== undefined && !this.childExited) {
          throw new Error('BRIDGE_PREVIOUS_PROCESS_ACTIVE');
        }
        return this.beginGeneration();
      });
      this.restartPromise = restarting;
      void restarting.then(
        () => { if (this.restartPromise === restarting) this.restartPromise = undefined; },
        () => { if (this.restartPromise === restarting) this.restartPromise = undefined; }
      );
      return restarting;
    }
    return this.beginGeneration();
  }

  /** 为每个桥接子进程建立全新的协议代次，旧事件只可命中旧 generation。 */
  private beginGeneration(): Promise<void> {
    this.resetGenerationState();
    this.state = 'starting';
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    const generation = ++this.bridgeGeneration;
    try {
      const child = this.options.spawn?.() ?? this.spawnFixedBridge();
      this.child = child;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk, generation));
      child.stderr.on('data', (chunk: string) => this.consumeStderr(chunk, generation));
      child.once('error', () => {
        if (generation === this.bridgeGeneration) this.fail('BRIDGE_PROCESS_ERROR');
      });
      child.once('exit', () => this.handleChildExit(generation));
      this.helloTimeout = setTimeout(() => {
        if (generation === this.bridgeGeneration && this.state === 'starting') {
          this.fail('BRIDGE_HELLO_TIMEOUT');
        }
      }, this.helloTimeoutMs);
    } catch {
      this.fail('BRIDGE_PROCESS_START_FAILED');
    }
    return this.startPromise;
  }

  async startObserving(): Promise<{ ok: true }> {
    const response = await this.request({ command: 'start-observing' });
    this.armObservationTimeout();
    return response;
  }

  async stopObserving(): Promise<{ ok: true }> {
    const response = await this.request({ command: 'stop-observing' });
    this.clearObservationTimeout();
    return response;
  }

  close(): Promise<void> {
    this.closeIntentToken += 1;
    if (this.closePromise !== undefined) return this.closePromise;
    this.closeInProgress = true;
    this.closePromise = this.performClose();
    void this.closePromise.then(
      () => { this.closeInProgress = false; },
      () => { this.closeInProgress = false; }
    );
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    if (this.state === 'closed') return;
    if (this.state === 'idle') {
      this.state = 'closed';
      return;
    }
    if (this.snapshot().state === 'failed') {
      await this.waitForCleanup();
      return;
    }
    const wasStarting = this.state === 'starting';
    const canRequestShutdown = this.state === 'ready';
    this.state = 'closing';
    this.clearHelloTimeout();
    this.clearObservationTimeout();
    if (wasStarting) {
      const error = new Error('BRIDGE_CLOSE_REQUESTED');
      this.rejectStart?.(error);
      this.rejectPending(error);
      if (!this.childExited) {
        if (!this.terminateOwnedChild()) {
          this.markCloseFailure('BRIDGE_PROCESS_TERMINATION_FAILED');
          throw new Error('BRIDGE_PROCESS_TERMINATION_FAILED');
        }
        if (!await this.waitForChildExit(this.closeTimeoutMs)) {
          this.markCloseFailure('BRIDGE_PROCESS_EXIT_TIMEOUT');
          throw new Error('BRIDGE_PROCESS_EXIT_TIMEOUT');
        }
      }
      await this.finishCloseState();
      return;
    }
    if (canRequestShutdown) {
      try {
        await this.requestWhileClosing({ command: 'shutdown' });
      } catch {
        // 退出仍继续等待固定子进程，不能把协议错误扩展为其他终止目标。
      }
    }
    if (this.snapshot().state === 'failed') {
      await this.waitForCleanup();
      return;
    }
    if (!this.childExited) {
      const exited = await this.waitForChildExit(this.closeTimeoutMs);
      if (this.snapshot().state === 'failed') {
        await this.waitForCleanup();
        return;
      }
      if (!exited) {
        if (!this.terminateOwnedChild()) {
          this.markCloseFailure('BRIDGE_PROCESS_TERMINATION_FAILED');
          throw new Error('BRIDGE_PROCESS_TERMINATION_FAILED');
        }
        const terminated = await this.waitForChildExit(this.closeTimeoutMs);
        if (this.snapshot().state === 'failed') {
          await this.waitForCleanup();
          return;
        }
        if (!terminated) {
          this.markCloseFailure('BRIDGE_PROCESS_EXIT_TIMEOUT');
          throw new Error('BRIDGE_PROCESS_EXIT_TIMEOUT');
        }
      }
    }
    await this.finishCloseState();
  }

  async waitForCleanup(): Promise<void> {
    if (this.cleanupPromise !== undefined) {
      return this.cleanupPromise;
    }
    if (this.child === undefined || this.childExited) {
      return;
    }
    const exited = await this.waitForChildExit(this.closeTimeoutMs);
    if (!exited) throw new Error('BRIDGE_PROCESS_EXIT_TIMEOUT');
  }

  private spawnFixedBridge(): ExplorerBridgeChild {
    const spec = this.options.spawnSpec;
    if (spec === undefined) {
      throw new Error('BRIDGE_SPAWN_SPEC_MISSING');
    }
    return spawnProcess(spec.executable, spec.args, spec.options) as ExplorerBridgeChild;
  }

  private request(command: ExplorerBridgeCommandInput): Promise<{ ok: true }> {
    if (this.state !== 'ready') {
      return Promise.reject(new Error('BRIDGE_NOT_READY'));
    }
    return this.writeRequest(command);
  }

  private requestWhileClosing(command: ExplorerBridgeCommandInput): Promise<{ ok: true }> {
    return this.writeRequest(command, false);
  }

  private writeRequest(command: ExplorerBridgeCommandInput, failOnTimeout = true): Promise<{ ok: true }> {
    if (this.child === undefined || this.nonce === undefined) {
      return Promise.reject(new Error('BRIDGE_NOT_READY'));
    }
    const requestId = `request-${this.nextRequestId++}`;
    const generation = this.bridgeGeneration;
    if (command.command === 'shutdown') this.shutdownRequestId = requestId;
    const line = serializeBridgeCommand({
      version: EXPLORER_SPACE_PROTOCOL_VERSION,
      nonce: this.nonce,
      requestId,
      ...command
    } as ExplorerBridgeCommand);
    return new Promise<{ ok: true }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (generation !== this.bridgeGeneration || !this.pending.has(requestId)) return;
        if (failOnTimeout) {
          this.fail('BRIDGE_REQUEST_TIMEOUT');
          return;
        }
        this.pending.delete(requestId);
        reject(new Error('BRIDGE_REQUEST_TIMEOUT'));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { timeout, resolve, reject });
      try {
        this.child!.stdin.write(line, (error) => {
          if (generation !== this.bridgeGeneration || error === null || error === undefined) return;
          this.fail('BRIDGE_WRITE_FAILED');
        });
      } catch {
        this.fail('BRIDGE_WRITE_FAILED');
      }
    });
  }

  private consumeStdout(chunk: string, generation: number): void {
    if (
      generation !== this.bridgeGeneration
      || this.childExited
      || this.state === 'failed'
      || this.state === 'closed'
    ) return;
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > EXPLORER_SPACE_MAX_LINE_BYTES && !this.stdoutBuffer.includes('\n')) {
      this.fail('BRIDGE_LINE_TOO_LONG');
      return;
    }
    this.stdoutBuffer = this.consumeLines(this.stdoutBuffer, (line) => this.handleStdoutLine(line));
  }

  private consumeStderr(chunk: string, generation: number): void {
    if (
      generation !== this.bridgeGeneration
      || this.childExited
      || this.state === 'closing'
      || this.state === 'failed'
      || this.state === 'closed'
    ) return;
    this.stderrBuffer += chunk;
    if (Buffer.byteLength(this.stderrBuffer, 'utf8') > EXPLORER_SPACE_MAX_LINE_BYTES && !this.stderrBuffer.includes('\n')) {
      this.fail('BRIDGE_STDERR_INVALID');
      return;
    }
    this.stderrBuffer = this.consumeLines(this.stderrBuffer, (line) => {
      try {
        this.emit('diagnostic', parseBridgeStderrLine(line));
      } catch (error) {
        this.fail((error as Error).message);
      }
    });
  }

  private consumeLines(buffer: string, consume: (line: string) => void): string {
    let newline = buffer.indexOf('\n');
    while (newline >= 0 && this.state !== 'failed') {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      consume(line);
      newline = buffer.indexOf('\n');
    }
    return buffer;
  }

  private handleStdoutLine(raw: string): void {
    let line: ReturnType<typeof parseBridgeLine>;
    try {
      line = parseBridgeLine(raw);
    } catch (error) {
      if (this.state !== 'closing') this.fail((error as Error).message);
      return;
    }
    try {
      if (this.state === 'starting') {
        if (line.type !== 'hello') {
          throw new Error('BRIDGE_HELLO_REQUIRED');
        }
        this.nonce = line.nonce;
        if (this.helloTimeout !== undefined) {
          clearTimeout(this.helloTimeout);
          this.helloTimeout = undefined;
        }
        this.lastSequence = line.sequence;
        this.verifiedPid = this.child?.pid;
        this.state = 'ready';
        this.resolveStart?.();
        return;
      }
      if (this.state === 'closing' && (
        line.type !== 'response'
        || line.nonce !== this.nonce
        || line.requestId !== this.shutdownRequestId
      )) return;
      if (this.state !== 'ready' && this.state !== 'closing') return;
      if (line.type === 'hello' || line.nonce !== this.nonce) {
        throw new Error('BRIDGE_NONCE_INVALID');
      }
      if (line.sequence <= this.lastSequence) {
        throw new Error('BRIDGE_SEQUENCE_INVALID');
      }
      this.lastSequence = line.sequence;
      if (line.type === 'explorer-snapshot') {
        if (this.observationTimeout !== undefined) this.armObservationTimeout();
        this.emit('snapshot', this.toOpaqueSnapshot(line satisfies ExplorerSnapshot));
        return;
      }
      if (line.type === 'observer-heartbeat') {
        // 心跳只证明观察器仍存活，不携带或更新任何 Explorer 事实。
        if (this.observationTimeout !== undefined) this.armObservationTimeout();
        return;
      }
      const pending = this.pending.get(line.requestId);
      if (pending === undefined) {
        throw new Error('BRIDGE_RESPONSE_STALE');
      }
      clearTimeout(pending.timeout);
      this.pending.delete(line.requestId);
      if (line.requestId === this.shutdownRequestId) this.shutdownRequestId = undefined;
      if (line.ok) {
        pending.resolve({ ok: true });
      } else {
        pending.reject(new Error(line.errorCode));
      }
    } catch (error) {
      this.fail((error as Error).message);
    }
  }

  private fail(code: string): void {
    if (this.state === 'failed' || this.state === 'closed') {
      return;
    }
    this.state = 'failed';
    this.errorCode = code;
    this.clearHelloTimeout();
    this.clearObservationTimeout();
    const error = new Error(code);
    this.rejectStart?.(error);
    this.rejectPending(error);
    if (this.child === undefined || this.childExited) {
      this.cleanupPromise = Promise.resolve();
    } else {
      const terminated = this.terminateOwnedChild();
      this.cleanupPromise = terminated
        ? this.waitForChildExit(this.closeTimeoutMs).then((exited) => {
            if (!exited) throw new Error('BRIDGE_PROCESS_EXIT_TIMEOUT');
          })
        : Promise.reject(new Error('BRIDGE_PROCESS_TERMINATION_FAILED'));
    }
    void this.cleanupPromise.catch(() => undefined);
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    }
  }

  private handleChildExit(generation: number): void {
    if (generation !== this.bridgeGeneration) return;
    this.childExited = true;
    this.clearHelloTimeout();
    this.clearObservationTimeout();
    const error = new Error('BRIDGE_PROCESS_EXITED');
    this.rejectPending(error);
    if (this.state === 'starting' || this.state === 'ready') {
      this.fail(error.message);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.shutdownRequestId = undefined;
  }

  private toOpaqueSnapshot(snapshot: ExplorerSnapshot): ExplorerSnapshot {
    if (snapshot.status !== 'ready' || this.nonce === undefined) return snapshot;
    const instanceId = createHash('sha256')
      .update(`${this.bridgeGeneration}\0${this.nonce}\0${snapshot.instanceId}`, 'utf8')
      .digest('hex');
    return { ...snapshot, instanceId };
  }

  private terminateOwnedChild(): boolean {
    if (this.child === undefined || this.childTerminated) {
      return this.childTerminated;
    }
    let terminated = false;
    try {
      terminated = this.child.kill('SIGTERM');
    } catch {
      return false;
    }
    this.childTerminated = terminated;
    return terminated;
  }

  private resetGenerationState(): void {
    this.clearHelloTimeout();
    this.clearObservationTimeout();
    this.rejectPending(new Error('BRIDGE_GENERATION_REPLACED'));
    this.child = undefined;
    this.errorCode = undefined;
    this.nonce = undefined;
    this.verifiedPid = undefined;
    this.lastSequence = -1;
    this.nextRequestId = 1;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.startPromise = undefined;
    this.resolveStart = undefined;
    this.rejectStart = undefined;
    this.closePromise = undefined;
    this.closeInProgress = false;
    this.cleanupPromise = undefined;
    this.shutdownRequestId = undefined;
    this.childTerminated = false;
    this.childExited = false;
  }

  private async finishCloseState(): Promise<void> {
    if (this.snapshot().state === 'failed') {
      await this.waitForCleanup();
      return;
    }
    if (this.state === 'closing') this.state = 'closed';
  }

  /** 观察看门狗只约束桥接活性，不缓存或公开任何 Explorer 事实。 */
  private armObservationTimeout(): void {
    this.clearObservationTimeout();
    if (this.state !== 'ready') return;
    const generation = this.bridgeGeneration;
    this.observationTimeout = setTimeout(
      () => {
        if (generation === this.bridgeGeneration && this.state === 'ready') {
          this.fail('BRIDGE_OBSERVATION_TIMEOUT');
        }
      },
      this.observationTimeoutMs
    );
  }

  private clearObservationTimeout(): void {
    if (this.observationTimeout === undefined) return;
    clearTimeout(this.observationTimeout);
    this.observationTimeout = undefined;
  }

  private clearHelloTimeout(): void {
    if (this.helloTimeout === undefined) return;
    clearTimeout(this.helloTimeout);
    this.helloTimeout = undefined;
  }

  private markCloseFailure(code: string): void {
    this.state = 'failed';
    this.errorCode = code;
  }

  private waitForChildExit(timeoutMs: number): Promise<boolean> {
    const child = this.child;
    if (child === undefined || this.childExited) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(exited);
      };
      child.once('exit', () => finish(true));
      const timeout = setTimeout(() => finish(false), timeoutMs);
    });
  }
}
