import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';

import type { LocalModelPublicStatus } from '../../shared/local-model-ipc';
import type {
  LocalModelConnection,
  LocalModelConnectionPort
} from '../providers/local-model-provider';
import type { LocalModelServiceRuntime } from './local-model-service';

export interface MainE2eLocalModelRuntimeOptions {
  scriptPath: string;
  readyFile: string;
  pidFile: string;
  token: string;
  stderrCanary: string;
}

/**
 * 仅供未打包 E2E 使用：真实子进程与环回 HTTP 替代 GGUF 推理，正式 Service/Provider 链保持不变。
 */
export class MainE2eLocalModelRuntime
implements LocalModelServiceRuntime, LocalModelConnectionPort {
  readonly #options: MainE2eLocalModelRuntimeOptions;
  readonly #listeners = new Set<(status: LocalModelPublicStatus) => void>();
  #status: LocalModelPublicStatus = status(false, 'disabled', null);
  #connection: LocalModelConnection | null = null;
  #child: ChildProcess | null = null;
  #startController: AbortController | null = null;
  #startPromise: Promise<void> | null = null;
  #stopPromise: Promise<void> | null = null;
  #generation = 0;
  #closed = false;

  constructor(options: MainE2eLocalModelRuntimeOptions) {
    this.#options = options;
  }

  start(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('LOCAL_MODEL_RUNTIME_CLOSED'));
    if (this.#status.phase === 'ready') return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;
    const controller = new AbortController();
    this.#startController = controller;
    const operation = this.#start(controller.signal);
    const tracked = operation.finally(() => {
      if (this.#startPromise === tracked) this.#startPromise = null;
      if (this.#startController === controller) this.#startController = null;
    });
    this.#startPromise = tracked;
    return tracked;
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#startController?.abort();
    this.#publish(false, 'stopping', this.#status.backend);
    const operation = this.#stopChild().then(() => {
      this.#connection = null;
      this.#generation += 1;
      this.#publish(false, 'disabled', null);
    });
    const tracked = operation.finally(() => {
      if (this.#stopPromise === tracked) this.#stopPromise = null;
    });
    this.#stopPromise = tracked;
    return tracked;
  }

  close(): Promise<void> {
    this.#closed = true;
    return this.stop();
  }

  getStatus(): LocalModelPublicStatus {
    return this.#status;
  }

  subscribe(listener: (status: LocalModelPublicStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getReadyConnection(): LocalModelConnection {
    if (this.#status.phase !== 'ready' || this.#connection === null) {
      throw new Error('LOCAL_MODEL_NOT_READY');
    }
    return this.#connection;
  }

  async #start(signal: AbortSignal): Promise<void> {
    await this.#stopPromise;
    throwIfAborted(signal);
    const port = await allocateLoopbackPort();
    throwIfAborted(signal);
    const generation = `local-model-e2e-${++this.#generation}`;
    this.#publish(true, 'loading', 'cpu');
    const child = spawn(process.execPath, [
      this.#options.scriptPath,
      `--port=${String(port)}`,
      `--token=${this.#options.token}`,
      `--ready-file=${this.#options.readyFile}`,
      `--stderr-canary=${this.#options.stderrCanary}`
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.#child = child;
    child.stdout?.resume();
    child.stderr?.resume();
    if (!child.pid) throw new Error('LOCAL_MODEL_E2E_PROCESS_PID_INVALID');
    await writeFile(this.#options.pidFile, String(child.pid), 'utf8');
    await waitForReady(port, child, signal);
    throwIfAborted(signal);
    if (this.#child !== child) throw new DOMException('LOCAL_MODEL_START_ABORTED', 'AbortError');
    this.#connection = Object.freeze({
      generation,
      baseUrl: `http://127.0.0.1:${String(port)}/v1`,
      token: this.#options.token,
      modelId: 'ai-pet-local'
    });
    this.#publish(true, 'ready', 'cpu');
  }

  async #stopChild(): Promise<void> {
    const child = this.#child;
    this.#child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await waitForExit(child);
  }

  #publish(
    enabled: boolean,
    phase: LocalModelPublicStatus['phase'],
    backend: LocalModelPublicStatus['backend']
  ): void {
    this.#status = status(enabled, phase, backend);
    for (const listener of this.#listeners) listener(this.#status);
  }
}

function status(
  enabled: boolean,
  phase: LocalModelPublicStatus['phase'],
  backend: LocalModelPublicStatus['backend']
): LocalModelPublicStatus {
  return Object.freeze({ enabled, phase, backend, reasonCode: null });
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => {
        if (error) rejectPort(error);
        else if (!address || typeof address === 'string') rejectPort(new Error('PORT_UNAVAILABLE'));
        else resolvePort(address.port);
      });
    });
  });
}

async function waitForReady(port: number, child: ChildProcess, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('LOCAL_MODEL_E2E_PROCESS_CRASHED');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`, { signal });
      if (response.status === 200) {
        const body = await response.json() as unknown;
        if (
          typeof body === 'object'
          && body !== null
          && Object.keys(body).length === 1
          && Reflect.get(body, 'status') === 'ok'
        ) return;
      }
    } catch (error) {
      if (signal.aborted) throw error;
    }
    await waitForPoll(signal);
  }
  throw new DOMException('LOCAL_MODEL_START_ABORTED', 'AbortError');
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolvePoll, rejectPoll) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectPoll(new DOMException('LOCAL_MODEL_START_ABORTED', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolvePoll();
    }, 25);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      error ? rejectExit(error) : resolveExit();
    };
    const onExit = (): void => finish();
    const timeout = setTimeout(() => finish(new Error('LOCAL_MODEL_E2E_PROCESS_STILL_RUNNING')), 5_000);
    child.once('exit', onExit);
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('LOCAL_MODEL_START_ABORTED', 'AbortError');
}
