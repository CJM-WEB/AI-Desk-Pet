import { existsSync, realpathSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExplorerSnapshot } from './explorer/explorer-space-protocol';
import type { LocalModelRuntimeOptions } from './local-model/local-model-runtime';

type ExplorerSnapshotFacts<T> = T extends ExplorerSnapshot
  ? Omit<T, 'version' | 'type' | 'nonce' | 'sequence'>
  : never;

export interface MainE2eBoundary {
  userDataDirectory: string;
  authorizedRootDirectory: string;
  explorerEventFile: string;
  mainStateFile: string;
  recycleBinDirectory: string;
  characterAssetsDirectory: string;
  safeCharacterPackage: string;
  maliciousCharacterPackage: string;
  characterExportDestination: string;
  localModelFixture?: {
    modulePath: string;
    configPath: string;
  };
}

/** 动态测试装配只返回正式 Runtime 构造参数；fixture 源码不会进入 Main 静态依赖图。 */
export async function loadMainE2eLocalModelRuntimeOptions(
  fixture: NonNullable<MainE2eBoundary['localModelFixture']>
): Promise<LocalModelRuntimeOptions> {
  const loaded = await import(pathToFileURL(fixture.modulePath).href) as Record<string, unknown>;
  const factory = loaded['createLocalModelRuntimeOptions'];
  if (typeof factory !== 'function') throw new Error('LOCAL_MODEL_E2E_FACTORY_INVALID');
  const options = await factory(fixture.configPath) as unknown;
  if (
    typeof options !== 'object'
    || options === null
    || typeof Reflect.get(options, 'root') !== 'string'
    || typeof Reflect.get(options, 'applicationVersion') !== 'string'
    || typeof Reflect.get(options, 'cachePath') !== 'string'
    || typeof Reflect.get(options, 'tokenRoot') !== 'string'
    || typeof Reflect.get(options, 'processPort') !== 'object'
  ) {
    throw new Error('LOCAL_MODEL_E2E_OPTIONS_INVALID');
  }
  return options as LocalModelRuntimeOptions;
}

export interface MainE2eBoundaryOptions {
  appIsPackaged: boolean;
  env: NodeJS.ProcessEnv;
  temporaryDirectory?: string;
}

/**
 * 周期性 E2E 观测只保留一个在途发布和一个最新待发布信号，
 * 慢磁盘不会把读写任务按定时器频率无界排队。
 */
export function createCoalescedAsyncPublisher(operation: () => Promise<void>): {
  publish(): Promise<void>;
  close(): Promise<void>;
} {
  let active: Promise<void> | null = null;
  let pending = false;
  let closing = false;

  const publish = (): Promise<void> => {
    if (closing) return active ?? Promise.resolve();
    if (active) {
      pending = true;
      return active;
    }
    const drain = async (): Promise<void> => {
      do {
        pending = false;
        try {
          await operation();
        } catch {
          // E2E 状态是轮询观测而非业务事实；临时写盘失败由后续信号重试，不能阻断关闭。
        }
      } while (pending);
    };
    active = drain().finally(() => {
      active = null;
    });
    return active;
  };

  return {
    publish,
    async close() {
      closing = true;
      await active;
    }
  };
}

/**
 * E2E 仅在 Main 内替代固定桥接进程，不提供 Renderer 控制面，也不产生真实 Explorer 事件。
 */
export function createMainE2eExplorerBridge(options: {
  eventFile: string;
  pollIntervalMs?: number;
}) {
  class MainE2eExplorerBridge extends EventEmitter {
    private state: 'idle' | 'ready' | 'failed' | 'closed' = 'idle';
    private errorCode: string | undefined;
    private observing = false;
    private consumedBytes = 0;
    private pendingText = '';
    private sequence = 0;
    private injectedSnapshot: ExplorerSnapshotFacts<ExplorerSnapshot> | undefined;
    private lastSnapshotAt = 0;
    private pollTimer: ReturnType<typeof setInterval> | undefined;
    private reading = false;
    private eventRevision = 0;
    private activeEvent: { revision: number; event: string } | undefined;
    private readonly eventProgress = new Map<number, {
      event: string;
      emitted: number;
      completed: number;
    }>();
    private readonly observationEvents = new WeakMap<object, number>();

    snapshot() {
      return this.errorCode === undefined
        ? { state: this.state }
        : { state: this.state, errorCode: this.errorCode };
    }

    /** Main-only 资源账本只供隔离 fixture 读取，不进入任何应用公开边界。 */
    inspection() {
      return {
        state: this.state,
        observing: this.observing,
        polling: this.pollTimer !== undefined,
        eventRevision: this.eventRevision
      };
    }

    completeObservation(observation: object): { revision: number; event: string } | undefined {
      const revision = this.observationEvents.get(observation);
      if (revision === undefined) return undefined;
      const progress = this.eventProgress.get(revision);
      if (!progress) return undefined;
      progress.completed += 1;
      return progress.completed === progress.emitted
        ? { revision, event: progress.event }
        : undefined;
    }

    async start(): Promise<void> {
      if (this.state === 'closed') throw new Error('E2E_BRIDGE_CLOSED');
      if (this.state === 'ready') return;
      try {
        this.consumedBytes = (await stat(options.eventFile)).size;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw new Error('E2E_BRIDGE_SCRIPT_FAILED');
        }
        this.consumedBytes = 0;
      }
      this.state = 'ready';
      this.errorCode = undefined;
    }

    async startObserving(): Promise<{ ok: true }> {
      if (this.state !== 'ready') throw new Error('E2E_BRIDGE_NOT_READY');
      this.observing = true;
      this.startPolling();
      return { ok: true };
    }

    async stopObserving(): Promise<{ ok: true }> {
      this.observing = false;
      this.stopPolling();
      return { ok: true };
    }

    async close(): Promise<void> {
      this.observing = false;
      this.stopPolling();
      this.state = 'closed';
    }

    /** 文件队列只接收固定图层令牌；路径、句柄和序列均由 Main 内部生成。 */
    private async consumeEvents(): Promise<void> {
      if (this.reading || !this.observing || this.state !== 'ready') return;
      this.reading = true;
      try {
        let content: Buffer;
        try {
          content = await readFile(options.eventFile);
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
          this.fail('E2E_BRIDGE_SCRIPT_FAILED');
          return;
        }
        if (content.byteLength < this.consumedBytes) {
          this.consumedBytes = content.byteLength;
          this.pendingText = '';
          return;
        }
        const appended = content.subarray(this.consumedBytes);
        this.consumedBytes = content.byteLength;
        if (appended.byteLength > 4_096) {
          this.fail('E2E_BRIDGE_SCRIPT_TOO_LARGE');
          return;
        }
        this.pendingText += appended.toString('utf8');
        let newline = this.pendingText.indexOf('\n');
        while (newline >= 0 && this.state === 'ready') {
          const event = this.pendingText.slice(0, newline).replace(/\r$/u, '');
          this.pendingText = this.pendingText.slice(newline + 1);
          this.consumeEvent(event);
          newline = this.pendingText.indexOf('\n');
        }
        if (this.pendingText.length > 64) this.fail('E2E_BRIDGE_EVENT_INVALID');
        this.emitHeartbeat();
      } finally {
        this.reading = false;
      }
    }

    private consumeEvent(event: string): void {
      this.eventRevision += 1;
      this.activeEvent = { revision: this.eventRevision, event };
      this.eventProgress.set(this.eventRevision, { event, emitted: 0, completed: 0 });
      try {
        this.dispatchEvent(event);
      } finally {
        this.activeEvent = undefined;
      }
    }

    private dispatchEvent(event: string): void {
      if (event === 'stale-sequence') {
        const facts: ExplorerSnapshotFacts<ExplorerSnapshot> = {
          status: 'ready',
          windowType: 'explorer',
          instanceId: 'e2e-explorer-exact',
          hwnd: '9003',
          rect: { x: 80, y: 80, width: 900, height: 700 },
          foreground: true,
          minimized: false
        };
        this.emitSnapshot(facts);
        this.emitSnapshot({
          status: 'ready',
          windowType: 'explorer',
          instanceId: 'e2e-explorer-exact',
          hwnd: '9002',
          rect: { x: 80, y: 80, width: 900, height: 700 },
          foreground: true,
          minimized: false
        }, this.sequence);
        return;
      }
      if (event === 'crash') {
        this.fail('E2E_BRIDGE_CRASHED');
        return;
      }
      if (event === 'ambiguous') {
        this.injectSnapshot({ status: 'ambiguous' });
        return;
      }
      if (event === 'non-explorer' || event === 'minimized' || event === 'blurred') {
        this.injectSnapshot({ status: 'none' });
        return;
      }
      if (event === 'layer-error' || event === 'foreground-explorer') {
        const validLayer = event === 'foreground-explorer';
        this.injectSnapshot({
          status: 'ready',
          windowType: 'explorer',
          instanceId: validLayer ? 'e2e-explorer-foreground' : 'e2e-explorer-layer-error',
          hwnd: validLayer ? '9002' : '9001',
          rect: { x: 80, y: 80, width: 900, height: 700 },
          foreground: true,
          minimized: false
        });
        return;
      }
      this.fail('E2E_BRIDGE_EVENT_INVALID');
    }

    private injectSnapshot(facts: ExplorerSnapshotFacts<ExplorerSnapshot>): void {
      this.injectedSnapshot = facts;
      this.emitSnapshot(facts);
    }

    /** 当前注入状态持续产生新序号，模拟生产桥的定期观察并驱动真实 watchdog。 */
    private emitHeartbeat(): void {
      if (
        this.injectedSnapshot === undefined
        || Date.now() - this.lastSnapshotAt < 250
      ) return;
      this.emitSnapshot(this.injectedSnapshot);
    }

    private emitSnapshot(
      facts: ExplorerSnapshotFacts<ExplorerSnapshot>,
      forcedSequence?: number
    ): void {
      if (!this.observing || this.state !== 'ready') return;
      if (forcedSequence === undefined) this.sequence += 1;
      this.lastSnapshotAt = Date.now();
      const snapshot = {
        version: 1,
        type: 'explorer-snapshot',
        nonce: 'e'.repeat(32),
        sequence: forcedSequence ?? this.sequence,
        ...facts
      } satisfies ExplorerSnapshot;
      if (this.activeEvent) {
        this.observationEvents.set(snapshot, this.activeEvent.revision);
        const progress = this.eventProgress.get(this.activeEvent.revision);
        if (progress) progress.emitted += 1;
      }
      this.emit('snapshot', snapshot);
    }

    private startPolling(): void {
      if (this.pollTimer !== undefined) return;
      this.pollTimer = setInterval(() => {
        void this.consumeEvents();
      }, options.pollIntervalMs ?? 20);
      this.pollTimer.unref?.();
      void this.consumeEvents();
    }

    private stopPolling(): void {
      if (this.pollTimer === undefined) return;
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    private fail(code: string): void {
      if (this.state === 'failed' || this.state === 'closed') return;
      this.state = 'failed';
      this.errorCode = code;
      this.observing = false;
      this.stopPolling();
      if (this.listenerCount('error') > 0) {
        const error = new Error(code);
        if (this.activeEvent) {
          this.observationEvents.set(error, this.activeEvent.revision);
          const progress = this.eventProgress.get(this.activeEvent.revision);
          if (progress) progress.emitted += 1;
        }
        this.emit('error', error);
      }
    }
  }

  return new MainE2eExplorerBridge();
}

/** E2E 图层替身只公开去标识化状态，禁止把 HWND 或路径写入测试状态文件。 */
export function createMainE2eExplorerLayer() {
  let status: 'idle' | 'active' | 'failed' | 'closed' = 'idle';
  let activationRevision = 0;
  let errorRevision = 0;
  return {
    async activate({ explorerHwnd }: { explorerHwnd: string }): Promise<void> {
      if (explorerHwnd !== '9002') {
        status = 'failed';
        errorRevision += 1;
        throw new Error('E2E_EXPLORER_LAYER_UNSAFE');
      }
      status = 'active';
      activationRevision += 1;
    },
    async dispose(): Promise<void> {
      status = 'closed';
    },
    inspection() {
      return { status, activationRevision, errorRevision };
    }
  };
}

/**
 * Main 侧唯一的 E2E 环境入口。任一条件不满足时完整回退到正式逻辑。
 */
export function resolveMainE2eBoundary(
  options: MainE2eBoundaryOptions
): MainE2eBoundary | null {
  if (
    options.appIsPackaged
    || options.env['MYSELF_E2E'] !== '1'
    || options.env['MYSELF_E2E_FAKE_EXPLORER_BRIDGE'] !== '1'
  ) return null;

  const rawUserData = options.env['MYSELF_E2E_USER_DATA'];
  const rawAuthorizedRoot = options.env['MYSELF_E2E_AUTHORIZED_ROOT'];
  const rawRecycleBin = options.env['MYSELF_E2E_RECYCLE_BIN'];
  const rawCharacterAssets = options.env['MYSELF_E2E_CHARACTER_ASSETS'];
  const rawSafePackage = options.env['MYSELF_E2E_SAFE_CHARACTER_PACKAGE'];
  const rawMaliciousPackage = options.env['MYSELF_E2E_MALICIOUS_CHARACTER_PACKAGE'];
  const rawExportDestination = options.env['MYSELF_E2E_CHARACTER_EXPORT'];
  const rawLocalModelOptionsModule = options.env['MYSELF_E2E_LOCAL_MODEL_OPTIONS_MODULE'];
  const rawLocalModelConfig = options.env['MYSELF_E2E_LOCAL_MODEL_CONFIG'];
  if (
    !rawUserData
    || !rawAuthorizedRoot
    || !rawRecycleBin
    || !rawCharacterAssets
    || !rawSafePackage
    || !rawMaliciousPackage
    || !rawExportDestination
  ) return null;

  /** 只对真实存在目录的规范路径做包含关系判断，阻断链接逃逸与名称前缀碰撞。 */
  const canonicalDirectory = (candidate: string): string | null => {
    if (!isAbsolute(candidate)) return null;
    try {
      if (!statSync(candidate).isDirectory()) return null;
      return realpathSync.native(candidate);
    } catch {
      return null;
    }
  };

  const temporaryDirectory = canonicalDirectory(options.temporaryDirectory ?? tmpdir());
  if (!temporaryDirectory) return null;
  const resolveTemporaryChild = (candidate: string): string | null => {
    const canonicalCandidate = canonicalDirectory(candidate);
    if (!canonicalCandidate) return null;
    const relativePath = relative(temporaryDirectory, canonicalCandidate);
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return null;
    return canonicalCandidate;
  };
  const resolveTemporaryFile = (candidate: string): string | null => {
    if (!isAbsolute(candidate)) return null;
    try {
      if (!statSync(candidate).isFile()) return null;
      const canonicalCandidate = realpathSync.native(candidate);
      const relativePath = relative(temporaryDirectory, canonicalCandidate);
      if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        return null;
      }
      return canonicalCandidate;
    } catch {
      return null;
    }
  };
  const resolveNewTemporaryFile = (candidate: string): string | null => {
    if (!isAbsolute(candidate) || existsSync(candidate)) return null;
    const canonicalParent = resolveTemporaryChild(dirname(candidate));
    if (!canonicalParent) return null;
    const target = resolve(canonicalParent, relative(dirname(candidate), candidate));
    const relativePath = relative(temporaryDirectory, target);
    return relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)
      ? target
      : null;
  };
  const userDataDirectory = resolveTemporaryChild(rawUserData);
  const authorizedRootDirectory = resolveTemporaryChild(rawAuthorizedRoot);
  const recycleBinDirectory = resolveTemporaryChild(rawRecycleBin);
  const characterAssetsDirectory = resolveTemporaryChild(rawCharacterAssets);
  const safeCharacterPackage = resolveTemporaryFile(rawSafePackage);
  const maliciousCharacterPackage = resolveTemporaryFile(rawMaliciousPackage);
  const characterExportDestination = resolveNewTemporaryFile(rawExportDestination);
  if (
    !userDataDirectory
    || !authorizedRootDirectory
    || !recycleBinDirectory
    || !characterAssetsDirectory
    || !safeCharacterPackage
    || !maliciousCharacterPackage
    || !characterExportDestination
  ) return null;
  if (new Set([
    userDataDirectory,
    authorizedRootDirectory,
    recycleBinDirectory,
    characterAssetsDirectory
  ]).size !== 4) return null;
  const hasAnyLocalModelFixtureValue = Boolean(
    rawLocalModelOptionsModule
    || rawLocalModelConfig
  );
  let localModelFixture: MainE2eBoundary['localModelFixture'];
  if (hasAnyLocalModelFixtureValue) {
    if (!rawLocalModelOptionsModule || !rawLocalModelConfig) return null;
    const modulePath = resolveTemporaryFile(rawLocalModelOptionsModule);
    const configPath = resolveTemporaryFile(rawLocalModelConfig);
    if (!modulePath || !configPath) return null;
    localModelFixture = { modulePath, configPath };
  }

  return {
    userDataDirectory,
    authorizedRootDirectory,
    explorerEventFile: resolve(userDataDirectory, 'main-e2e-explorer-events'),
    mainStateFile: resolve(userDataDirectory, 'main-e2e-state.json'),
    recycleBinDirectory,
    characterAssetsDirectory,
    safeCharacterPackage,
    maliciousCharacterPackage,
    characterExportDestination,
    ...(localModelFixture ? { localModelFixture } : {})
  };
}
