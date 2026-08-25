import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

import type { LocalModelPublicStatus } from '../../shared/local-model-ipc';
import {
  createNodeWindowsProcessTreePort,
  terminateExactPidProcessTree,
  type WindowsProcessTreePort
} from '../agent/windows-process-tree';
import type { LocalModelConnection, LocalModelConnectionPort } from '../providers/local-model-provider';
import {
  BUILTIN_LOCAL_MODEL_RELEASE,
  LocalModelManifestError,
  validateLocalModelManifest,
  type LocalModelHashFile,
  type LocalModelReleasePolicy,
  type ValidatedLocalModelManifest
} from './local-model-manifest';

type LocalModelBackend = NonNullable<LocalModelPublicStatus['backend']>;
type LocalModelReasonCode = NonNullable<LocalModelPublicStatus['reasonCode']>;

interface EventSource extends EventEmitter {
  setEncoding?(encoding: BufferEncoding): this;
}

export interface LocalModelChildProcess extends EventEmitter {
  readonly pid?: number;
  readonly stdout: EventSource;
  readonly stderr: EventSource;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface LocalModelSpawnInput {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  shell: false;
  windowsHide: true;
}

export interface LocalModelHealthResult {
  status: number;
  body: unknown;
}

/** 外部副作用集中在可替换端口，测试不启动真实 llama-server 或占用真实端口。 */
export interface LocalModelProcessPort extends WindowsProcessTreePort {
  spawn(input: LocalModelSpawnInput): LocalModelChildProcess;
  findAvailablePort(): Promise<number>;
  getHealth(url: string, signal: AbortSignal): Promise<LocalModelHealthResult>;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  randomBytes(size: number): Buffer;
}

export interface LocalModelTokenFilePort {
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}

export interface LocalModelRuntimeOptions {
  root: string;
  applicationVersion: string;
  cachePath: string;
  tokenRoot: string;
  /** 仅供 Main 验收选择固定后端；正式产品默认 automatic 并保持 Vulkan→CPU。 */
  backendPreference?: 'automatic' | 'cpu-only' | 'vulkan-only';
  /** 验收只接收非零 GPU offload 布尔事实，原始进程输出仍封闭在 Runtime。 */
  acceptanceDiagnostics?: Readonly<{ onVulkanOffloadObserved(): void }>;
  releasePolicy?: LocalModelReleasePolicy;
  processPort?: LocalModelProcessPort;
  healthPollIntervalMs?: number;
  loadTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  manifestHashFile?: LocalModelHashFile;
  tokenFilePort?: LocalModelTokenFilePort;
}

interface ActiveProcess {
  child: LocalModelChildProcess;
  backend: LocalModelBackend;
  generation: string;
  abortController: AbortController;
  stdout: BoundedTail;
  stderr: BoundedTail;
  exited: boolean;
}

interface TokenFile {
  directory: string;
  path: string;
  token: string;
}

const DEFAULT_HEALTH_POLL_INTERVAL_MS = 250;
const DEFAULT_LOAD_TIMEOUT_MS = 5 * 60_000;
// 真实 Vulkan 后端卸载大模型时 child close 可能晚于 taskkill 返回；保持有界但覆盖实测退出延迟。
const DEFAULT_CLEANUP_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_PORT_ATTEMPTS = 3;
const ENVIRONMENT_KEYS = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'] as const;

export class LocalModelRuntimeError extends Error {
  constructor(readonly code: LocalModelReasonCode) {
    super(code);
    this.name = 'LocalModelRuntimeError';
  }
}

/**
 * Runtime 只管理固定发行进程和 Main 私有连接；Renderer 可见状态由四个白名单字段重新构造。
 * generation 在每次启动和失效时推进，迟到连接不能重新成为 ready。
 */
export class LocalModelRuntime implements LocalModelConnectionPort {
  readonly #options: LocalModelRuntimeOptions;
  readonly #processPort: LocalModelProcessPort;
  readonly #backendPreference: NonNullable<LocalModelRuntimeOptions['backendPreference']>;
  readonly #healthPollIntervalMs: number;
  readonly #loadTimeoutMs: number;
  readonly #cleanupTimeoutMs: number;
  readonly #tokenFilePort: LocalModelTokenFilePort;
  readonly #listeners = new Set<(status: LocalModelPublicStatus) => void>();
  #status: LocalModelPublicStatus = createStatus(false, 'disabled', null, null);
  #generation = 0;
  #lifecycleEpoch = 0;
  #connection: LocalModelConnection | null = null;
  #active: ActiveProcess | null = null;
  #tokenFile: TokenFile | null = null;
  #startAbort: AbortController | null = null;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #crashCleanup: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: LocalModelRuntimeOptions) {
    this.#options = options;
    this.#processPort = options.processPort ?? createNodeProcessPort();
    this.#backendPreference = options.backendPreference ?? 'automatic';
    this.#healthPollIntervalMs = requirePositive(
      options.healthPollIntervalMs ?? DEFAULT_HEALTH_POLL_INTERVAL_MS,
      'HEALTH_POLL_INTERVAL'
    );
    this.#loadTimeoutMs = requirePositive(options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS, 'LOAD_TIMEOUT');
    this.#cleanupTimeoutMs = requirePositive(
      options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
      'CLEANUP_TIMEOUT'
    );
    this.#tokenFilePort = options.tokenFilePort ?? { unlink, rmdir };
  }

  start(signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw new Error('LOCAL_MODEL_RUNTIME_CLOSED');
    if (this.#status.phase === 'ready') return Promise.resolve();
    if (this.#startPromise !== undefined) return this.#startPromise;
    // 接受 start 的同一同步调用栈就建立取消能力，确保紧随其后的 stop 不会漏过验证阶段。
    const controller = new AbortController();
    const epoch = ++this.#lifecycleEpoch;
    const onAbort = (): void => controller.abort(createAbortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted === true) controller.abort(createAbortError());
    this.#startAbort = controller;
    const barriers = [this.#stopPromise, this.#crashCleanup].filter(
      (barrier): barrier is Promise<void> => barrier !== undefined
    );
    const operation = Promise.all(barriers).then(() => {
      if (this.#closed) throw new Error('LOCAL_MODEL_RUNTIME_CLOSED');
      if (epoch !== this.#lifecycleEpoch || controller.signal.aborted) throw createAbortError();
      return this.#prepareStart(controller);
    });
    const tracked = operation.finally(() => {
      signal?.removeEventListener('abort', onAbort);
      if (this.#startAbort === controller) this.#startAbort = null;
      if (this.#startPromise === tracked) this.#startPromise = undefined;
    });
    this.#startPromise = tracked;
    return tracked;
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) {
      // stop Promise 可复用，但复用期间新排队的 start 仍必须在同步栈内失效。
      this.#lifecycleEpoch += 1;
      this.#startAbort?.abort(createAbortError());
      return this.#stopPromise;
    }
    if (this.#status.phase === 'disabled' && this.#startPromise === undefined) return Promise.resolve();
    this.#lifecycleEpoch += 1;
    this.#publish(false, 'stopping', this.#status.backend, null);
    this.#startAbort?.abort(createAbortError());
    const start = this.#startPromise;
    const backend = this.#status.backend;
    const operation = (async () => {
      if (start !== undefined) {
        try {
          await start;
        } catch (error) {
          if (runtimeCode(error) === 'PROCESS_CLEANUP_FAILED') {
            this.#invalidateConnection();
            this.#publish(false, 'faulted', backend, 'PROCESS_CLEANUP_FAILED');
            throw new LocalModelRuntimeError('PROCESS_CLEANUP_FAILED');
          }
        }
      }
      if (this.#crashCleanup !== undefined) await this.#crashCleanup;
      this.#invalidateConnection();
      try {
        await this.#cleanupActive();
        this.#publish(false, 'disabled', null, null);
      } catch {
        this.#publish(false, 'faulted', backend, 'PROCESS_CLEANUP_FAILED');
        throw new LocalModelRuntimeError('PROCESS_CLEANUP_FAILED');
      }
    })();
    const tracked = operation.finally(() => {
      if (this.#stopPromise === tracked) this.#stopPromise = undefined;
    });
    this.#stopPromise = tracked;
    return tracked;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    const operation = this.stop();
    const tracked = operation.catch(error => {
      if (this.#closePromise === tracked) this.#closePromise = undefined;
      throw error;
    });
    this.#closePromise = tracked;
    return tracked;
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

  async #prepareStart(controller: AbortController): Promise<void> {
    if (this.#active !== null || this.#tokenFile !== null) {
      try {
        await this.#cleanupActive();
      } catch {
        this.#publish(false, 'faulted', this.#status.backend, 'PROCESS_CLEANUP_FAILED');
        throw new LocalModelRuntimeError('PROCESS_CLEANUP_FAILED');
      }
    }
    throwIfAborted(controller.signal);
    await this.#runStart(controller);
  }

  async #runStart(controller: AbortController): Promise<void> {
    const generation = `local-model-${++this.#generation}`;
    let backend: LocalModelBackend | null = null;
    try {
      this.#publish(true, 'validating', null, null);
      throwIfAborted(controller.signal);
      const manifest = await validateLocalModelManifest({
        root: this.#options.root,
        applicationVersion: this.#options.applicationVersion,
        cachePath: this.#options.cachePath,
        releasePolicy: this.#options.releasePolicy ?? BUILTIN_LOCAL_MODEL_RELEASE,
        ...(this.#options.manifestHashFile === undefined ? {} : { hashFile: this.#options.manifestHashFile }),
        signal: controller.signal
      });
      throwIfAborted(controller.signal);
      this.#tokenFile = await createTokenFile(
        this.#options.tokenRoot,
        this.#processPort.randomBytes(32).toString('base64url')
      );
      throwIfAborted(controller.signal);

      if (this.#backendPreference !== 'cpu-only') {
        this.#publish(true, 'loading', 'vulkan', null);
        backend = 'vulkan';
        const devices = await this.#probeVulkan(manifest, generation, controller.signal);
        let lastVulkanError: unknown;
        for (const device of devices) {
          try {
            await this.#startBackend(manifest, 'vulkan', generation, controller.signal, device);
            return;
          } catch (error) {
            const code = runtimeCode(error);
            if (
              isAbortError(error)
              || code === 'PORT_CONFLICT'
              || code === 'PROCESS_CLEANUP_FAILED'
            ) {
              throw error;
            }
            lastVulkanError = error;
          }
        }
        if (this.#backendPreference === 'vulkan-only') {
          if (lastVulkanError !== undefined) throw lastVulkanError;
          throw new LocalModelRuntimeError('VULKAN_UNAVAILABLE');
        }
      }

      backend = 'cpu';
      this.#publish(true, 'loading', 'cpu', null);
      try {
        await this.#startBackend(manifest, 'cpu', generation, controller.signal);
      } catch (error) {
        const code = runtimeCode(error);
        if (
          isAbortError(error)
          || code === 'PORT_CONFLICT'
          || code === 'MODEL_LOAD_TIMEOUT'
          || code === 'PROTOCOL_INCOMPATIBLE'
          || code === 'PROCESS_CLEANUP_FAILED'
        ) {
          throw error;
        }
        throw new LocalModelRuntimeError('CPU_START_FAILED');
      }
    } catch (error) {
      const aborted = isAbortError(error) || controller.signal.aborted;
      const stopOwnsStatus = aborted && this.#stopPromise !== undefined;
      if (aborted && !stopOwnsStatus) this.#publish(false, 'stopping', backend, null);
      if (runtimeCode(error) === 'PROCESS_CLEANUP_FAILED') {
        this.#invalidateConnection();
        this.#publish(false, 'faulted', backend, 'PROCESS_CLEANUP_FAILED');
        throw new LocalModelRuntimeError('PROCESS_CLEANUP_FAILED');
      }
      try {
        await this.#cleanupActive();
      } catch {
        this.#invalidateConnection();
        this.#publish(false, 'faulted', backend, 'PROCESS_CLEANUP_FAILED');
        throw new LocalModelRuntimeError('PROCESS_CLEANUP_FAILED');
      }
      this.#invalidateConnection();
      if (aborted) {
        if (!stopOwnsStatus) this.#publish(false, 'disabled', null, null);
        throw createAbortError();
      }
      const code = error instanceof LocalModelManifestError ? error.reasonCode : runtimeCode(error);
      const reasonCode = code ?? 'RUNTIME_INCOMPATIBLE';
      this.#publish(true, 'faulted', backend, reasonCode);
      throw new LocalModelRuntimeError(reasonCode);
    }
  }

  async #probeVulkan(
    manifest: ValidatedLocalModelManifest,
    generation: string,
    signal: AbortSignal
  ): Promise<readonly string[]> {
    let child: LocalModelChildProcess;
    try {
      child = this.#processPort.spawn({
        file: manifest.backends.vulkan.executablePath,
        args: ['--list-devices'],
        cwd: manifest.backends.vulkan.workingDirectory,
        env: safeEnvironment(this.#options.environment ?? process.env),
        shell: false,
        windowsHide: true
      });
    } catch {
      return [];
    }
    const output = new BoundedTail(MAX_OUTPUT_BYTES);
    const active: ActiveProcess = {
      child,
      backend: 'vulkan',
      generation,
      abortController: new AbortController(),
      stdout: output,
      stderr: new BoundedTail(MAX_OUTPUT_BYTES),
      exited: false
    };
    this.#active = active;
    // 只有 close 能证明 probe 已退出；error 仍必须走精确 PID 树清理并等待 close。
    child.once('close', () => { active.exited = true; });
    child.stdout.setEncoding?.('utf8');
    child.stderr.setEncoding?.('utf8');
    const onStdout = (chunk: Buffer | string): void => output.append(String(chunk));
    const onStderr = (chunk: Buffer | string): void => active.stderr.append(String(chunk));
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    try {
      const exitCode = await waitForProcess(child, signal, this.#loadTimeoutMs);
      if (this.#active === active) this.#active = null;
      if (exitCode !== 0) return [];
      return selectVulkanDevices(output.value);
    } catch (error) {
      await this.#terminateActive(active);
      if (isAbortError(error)) throw error;
      return [];
    } finally {
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
    }
  }

  async #startBackend(
    manifest: ValidatedLocalModelManifest,
    backend: LocalModelBackend,
    generation: string,
    signal: AbortSignal,
    vulkanDevice?: string
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      let port: number;
      try {
        port = await this.#processPort.findAvailablePort();
      } catch {
        if (attempt === MAX_PORT_ATTEMPTS - 1) throw new LocalModelRuntimeError('PORT_CONFLICT');
        continue;
      }
      const active = this.#spawnServer(manifest, backend, generation, port, vulkanDevice);
      this.#active = active;
      try {
        await this.#waitUntilHealthy(active, port, signal);
        throwIfAborted(signal);
        this.#connection = Object.freeze({
          generation,
          baseUrl: `http://127.0.0.1:${port}/v1`,
          token: requireTokenFile(this.#tokenFile).token,
          modelId: manifest.modelId
        });
        this.#publish(true, 'ready', backend, null);
        this.#watchReadyCrash(active);
        return;
      } catch (error) {
        await this.#terminateActive(active);
        if (runtimeCode(error) === 'PORT_CONFLICT' && attempt < MAX_PORT_ATTEMPTS - 1) continue;
        throw error;
      }
    }
    throw new LocalModelRuntimeError('PORT_CONFLICT');
  }

  #spawnServer(
    manifest: ValidatedLocalModelManifest,
    backend: LocalModelBackend,
    generation: string,
    port: number,
    vulkanDevice?: string
  ): ActiveProcess {
    const runtime = manifest.backends[backend];
    const tokenFile = requireTokenFile(this.#tokenFile);
    const args = [
      '--model', manifest.modelPath,
      '--alias', manifest.modelId,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--ctx-size', '8192',
      '--parallel', '1',
      '--jinja',
      '--reasoning', 'off',
      '--api-key-file', tokenFile.path,
      '--offline',
      ...(backend === 'vulkan' && this.#options.acceptanceDiagnostics !== undefined
        ? ['--verbose']
        : []),
      '--no-ui',
      '--no-slots',
      '--no-cors-credentials',
      ...(backend === 'cpu'
        ? ['--device', 'none', '--gpu-layers', '0']
        : ['--device', requireVulkanDevice(vulkanDevice), '--gpu-layers', 'all'])
    ];
    let child: LocalModelChildProcess;
    try {
      child = this.#processPort.spawn({
        file: runtime.executablePath,
        args,
        cwd: runtime.workingDirectory,
        env: safeEnvironment(this.#options.environment ?? process.env),
        shell: false,
        windowsHide: true
      });
    } catch {
      throw new LocalModelRuntimeError(backend === 'cpu' ? 'CPU_START_FAILED' : 'PROCESS_CRASHED');
    }
    const active: ActiveProcess = {
      child,
      backend,
      generation,
      abortController: new AbortController(),
      stdout: new BoundedTail(MAX_OUTPUT_BYTES),
      stderr: new BoundedTail(MAX_OUTPUT_BYTES),
      exited: false
    };
    child.stdout.setEncoding?.('utf8');
    child.stderr.setEncoding?.('utf8');
    let vulkanOffloadReported = false;
    const append = (tail: BoundedTail, chunk: Buffer | string): void => {
      tail.append(String(chunk));
      if (
        backend !== 'vulkan'
        || vulkanOffloadReported
        || !hasVulkanOffloadEvidence(`${active.stdout.value}\n${active.stderr.value}`)
      ) {
        return;
      }
      vulkanOffloadReported = true;
      try {
        this.#options.acceptanceDiagnostics?.onVulkanOffloadObserved();
      } catch {
        // 验收观察者不能获得 Runtime 生命周期控制权，也不能使生产进程失败。
      }
    };
    child.stdout.on('data', (chunk: Buffer | string) => append(active.stdout, chunk));
    child.stderr.on('data', (chunk: Buffer | string) => append(active.stderr, chunk));
    child.once('close', () => { active.exited = true; });
    return active;
  }

  #waitUntilHealthy(active: ActiveProcess, port: number, signal: AbortSignal): Promise<void> {
    const controller = active.abortController;
    const onAbort = (): void => controller.abort(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) controller.abort(createAbortError());
    return new Promise<void>((resolveReady, rejectReady) => {
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        active.child.off('close', onClose);
        active.child.off('error', onError);
        controller.signal.removeEventListener('abort', onHealthAbort);
        if (error === undefined) resolveReady();
        else rejectReady(error);
      };
      const processError = (exitCode: number | null): LocalModelRuntimeError => new LocalModelRuntimeError(
        exitCode !== null && exitCode !== 0 && isPortConflict(active.stderr.value)
          ? 'PORT_CONFLICT'
          : 'PROCESS_CRASHED'
      );
      const onClose = (exitCode: number | null): void => finish(processError(exitCode));
      const onError = (): void => finish(new LocalModelRuntimeError('PROCESS_CRASHED'));
      const onHealthAbort = (): void => finish(createAbortError());
      const timeout = setTimeout(() => finish(new LocalModelRuntimeError('MODEL_LOAD_TIMEOUT')), this.#loadTimeoutMs);
      active.child.once('close', onClose);
      active.child.once('error', onError);
      controller.signal.addEventListener('abort', onHealthAbort, { once: true });

      void (async () => {
        while (!settled) {
          try {
            const result = await this.#processPort.getHealth(
              `http://127.0.0.1:${port}/health`,
              controller.signal
            );
            if (result.status === 200) {
              if (isStrictHealthyBody(result.body)) finish();
              else finish(new LocalModelRuntimeError('PROTOCOL_INCOMPATIBLE'));
              return;
            }
            if (result.status !== 503) {
              finish(new LocalModelRuntimeError('PROTOCOL_INCOMPATIBLE'));
              return;
            }
          } catch (error) {
            if (controller.signal.aborted) {
              finish(createAbortError());
              return;
            }
          }
          try {
            await this.#processPort.sleep(this.#healthPollIntervalMs, controller.signal);
          } catch {
            finish(createAbortError());
          }
        }
      })();
    });
  }

  #watchReadyCrash(active: ActiveProcess): void {
    const onCrash = (): void => {
      if (this.#active !== active || this.#status.phase !== 'ready') return;
      this.#invalidateConnection();
      const cleanup = this.#cleanupActive().catch(() => {
        this.#publish(false, 'faulted', active.backend, 'PROCESS_CLEANUP_FAILED');
      });
      const tracked = cleanup.finally(() => {
        if (this.#crashCleanup === tracked) this.#crashCleanup = undefined;
      });
      this.#crashCleanup = tracked;
      this.#publish(true, 'faulted', active.backend, 'PROCESS_CRASHED');
    };
    active.child.once('close', onCrash);
    active.child.once('error', onCrash);
  }

  async #cleanupActive(): Promise<void> {
    const active = this.#active;
    if (active !== null) await this.#terminateActive(active);
    await this.#deleteTokenFile();
  }

  async #terminateActive(active: ActiveProcess): Promise<void> {
    active.abortController.abort(createAbortError());
    const result = await terminateExactPidProcessTree({
      child: active.child,
      processTreePort: this.#processPort,
      cleanupTimeoutMs: this.#cleanupTimeoutMs,
      alreadyExited: active.exited,
      waitForChildExit: true
    });
    if (!result.ok) throw new LocalModelRuntimeError('PROCESS_CLEANUP_FAILED');
    if (this.#active === active) this.#active = null;
  }

  async #deleteTokenFile(): Promise<void> {
    const tokenFile = this.#tokenFile;
    if (tokenFile === null) return;
    try {
      await this.#tokenFilePort.unlink(tokenFile.path);
    } catch (error) {
      if (!isMissingFileError(error)) throw new LocalModelRuntimeError('PROCESS_CLEANUP_FAILED');
    }
    try {
      await this.#tokenFilePort.rmdir(tokenFile.directory);
    } catch (error) {
      if (!isMissingFileError(error)) throw new LocalModelRuntimeError('PROCESS_CLEANUP_FAILED');
    }
    if (this.#tokenFile === tokenFile) this.#tokenFile = null;
  }

  #invalidateConnection(): void {
    this.#connection = null;
    this.#generation += 1;
  }

  #publish(
    enabled: boolean,
    phase: LocalModelPublicStatus['phase'],
    backend: LocalModelPublicStatus['backend'],
    reasonCode: LocalModelPublicStatus['reasonCode']
  ): void {
    this.#status = createStatus(enabled, phase, backend, reasonCode);
    for (const listener of this.#listeners) {
      try {
        listener(this.#status);
      } catch {
        // 状态消费者不能取得 Runtime 生命周期控制权，也不记录可能携带敏感数据的异常。
      }
    }
  }
}

class BoundedTail {
  #value = '';

  constructor(private readonly maxBytes: number) {}

  get value(): string {
    return this.#value;
  }

  append(chunk: string): void {
    const combined = Buffer.from(this.#value + chunk, 'utf8');
    if (combined.byteLength <= this.maxBytes) {
      this.#value += chunk;
      return;
    }
    const tail = combined.subarray(combined.byteLength - this.maxBytes);
    this.#value = tail.toString('utf8').replace(/^\uFFFD/u, '');
  }
}

function createStatus(
  enabled: boolean,
  phase: LocalModelPublicStatus['phase'],
  backend: LocalModelPublicStatus['backend'],
  reasonCode: LocalModelPublicStatus['reasonCode']
): LocalModelPublicStatus {
  return Object.freeze({ enabled, phase, backend, reasonCode });
}

async function createTokenFile(tokenRoot: string, token: string): Promise<TokenFile> {
  await mkdir(tokenRoot, { recursive: true });
  const directory = await mkdtemp(join(tokenRoot, 'session-'));
  const path = join(directory, 'api-key.txt');
  await writeFile(path, token, { encoding: 'utf8', mode: 0o600 });
  return { directory, path, token };
}

function createNodeProcessPort(): LocalModelProcessPort {
  return {
    ...createNodeWindowsProcessTreePort(),
    spawn(input): LocalModelChildProcess {
      return spawn(input.file, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }) as unknown as LocalModelChildProcess;
    },
    findAvailablePort(): Promise<number> {
      return new Promise((resolvePort, reject) => {
        const server = createServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          server.close(error => {
            if (error !== undefined) reject(error);
            else if (address === null || typeof address === 'string') reject(new Error('PORT_UNAVAILABLE'));
            else resolvePort(address.port);
          });
        });
      });
    },
    async getHealth(url, signal): Promise<LocalModelHealthResult> {
      const response = await fetch(url, { method: 'GET', signal });
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > 8 * 1024) {
        return { status: response.status, body: null };
      }
      try {
        return { status: response.status, body: JSON.parse(text) };
      } catch {
        return { status: response.status, body: null };
      }
    },
    sleep(milliseconds, signal): Promise<void> {
      return new Promise((resolveSleep, reject) => {
        const onAbort = (): void => {
          clearTimeout(timeout);
          reject(createAbortError());
        };
        const timeout = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolveSleep();
        }, milliseconds);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    },
    randomBytes(size): Buffer {
      return Buffer.from(crypto.getRandomValues(new Uint8Array(size)));
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

function waitForProcess(
  child: LocalModelChildProcess,
  signal: AbortSignal,
  timeoutMs: number
): Promise<number | null> {
  return new Promise((resolveExit, reject) => {
    const finish = (error: unknown, code?: number | null): void => {
      clearTimeout(timeout);
      child.off('close', onClose);
      child.off('error', onError);
      signal.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error);
      else resolveExit(code ?? null);
    };
    const onClose = (code: number | null): void => finish(undefined, code);
    const onError = (): void => finish(new Error('PROCESS_ERROR'));
    const onAbort = (): void => finish(createAbortError());
    const timeout = setTimeout(() => finish(new LocalModelRuntimeError('VULKAN_UNAVAILABLE')), timeoutMs);
    child.once('close', onClose);
    child.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function isStrictHealthyBody(body: unknown): boolean {
  return typeof body === 'object'
    && body !== null
    && Object.keys(body).length === 1
    && Reflect.get(body, 'status') === 'ok';
}

function isPortConflict(stderr: string): boolean {
  return /address\s+already\s+in\s+use|EADDRINUSE|bind\s+failed/iu.test(stderr);
}

function hasVulkanOffloadEvidence(output: string): boolean {
  const match = /offloaded\s+(\d+)\/(\d+)\s+layers\s+to\s+GPU/iu.exec(output);
  return match !== null && Number(match[1]) > 0;
}

type VulkanDeviceCandidate = Readonly<{
  id: string;
  ordinal: number;
  preference: number;
}>;

const softwareVulkanDevicePattern = /(?:llvmpipe|lavapipe|swiftshader|software\s+renderer|microsoft\s+basic\s+render)/iu;
const discreteVulkanDevicePattern = /(?:\bnvidia\b|\bgeforce\b|\bquadro\b|\btesla\b|\bradeon\s+(?:rx|pro)\b|\bamd\s+instinct\b|\bintel(?:\(r\))?\s+arc\b)/iu;
const integratedVulkanDevicePattern = /(?:\bintel\b|\biris\b|\bradeon(?:\(tm\))?\s+graphics\b|\bvega\b)/iu;

/**
 * `--list-devices` 的序号只表示枚举顺序，不能代表性能。
 * 解析所有唯一硬件设备后优先明确独显；未知硬件仍优先于已知集显，平局按序号稳定选择。
 */
function selectVulkanDevices(output: string): readonly string[] {
  const unique = new Map<string, VulkanDeviceCandidate>();
  for (const line of output.split(/\r?\n/u)) {
    // 保留旧运行时只输出设备 ID 的兼容格式；存在名称时再参与硬件分类。
    const match = /^\s*(Vulkan(\d+))(?:\s*:\s*(\S[\s\S]*?))?\s*$/u.exec(line);
    const id = match?.[1];
    const ordinal = Number(match?.[2]);
    const name = match?.[3] ?? '';
    if (
      id === undefined
      || !Number.isSafeInteger(ordinal)
      || unique.has(id)
      || softwareVulkanDevicePattern.test(name)
    ) {
      continue;
    }
    unique.set(id, {
      id,
      ordinal,
      preference: discreteVulkanDevicePattern.test(name)
        ? 3
        : integratedVulkanDevicePattern.test(name)
          ? 1
          : 2
    });
  }
  return [...unique.values()].sort((left, right) => (
    right.preference - left.preference || left.ordinal - right.ordinal
  )).map(candidate => candidate.id);
}

function runtimeCode(error: unknown): LocalModelReasonCode | undefined {
  return error instanceof LocalModelRuntimeError ? error.code : undefined;
}

function createAbortError(): DOMException {
  return new DOMException('LOCAL_MODEL_START_ABORTED', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'name') === 'AbortError';
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError();
}

function requireTokenFile(tokenFile: TokenFile | null): TokenFile {
  if (tokenFile === null) throw new LocalModelRuntimeError('RUNTIME_INCOMPATIBLE');
  return tokenFile;
}

function requireVulkanDevice(device: string | undefined): string {
  if (device === undefined) throw new LocalModelRuntimeError('VULKAN_UNAVAILABLE');
  return device;
}

function requirePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name}_INVALID`);
  return value;
}
