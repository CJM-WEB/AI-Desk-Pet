import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { chromium, type Browser } from '@playwright/test';
import { materializeCharacterWorkshopFixtures } from './character-workshop-assets';

export interface ElectronLaunchPlanOptions {
  workspaceRoot: string;
  cdpPort: number;
  userDataDirectory: string;
  authorizedRootDirectory: string;
  recycleBinDirectory?: string;
  characterAssetsDirectory?: string;
  safeCharacterPackage?: string;
  maliciousCharacterPackage?: string;
  characterExportDestination?: string;
  parentEnvironment?: NodeJS.ProcessEnv;
  enableSoftwareRasterizer?: boolean;
  localModelFixture?: {
    scriptPath: string;
    readyFile: string;
    pidFile: string;
    token: string;
    stderrCanary: string;
  };
}

export interface ElectronLaunchPlan {
  executablePath: string;
  applicationEntry: string;
  cdpEndpoint: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
}

/** 构造只监听回环地址的项目 Electron 启动参数。 */
export function createElectronLaunchPlan(options: ElectronLaunchPlanOptions): ElectronLaunchPlan {
  const workspaceRoot = resolve(options.workspaceRoot);
  const applicationEntry = resolve(workspaceRoot, 'apps/desktop/out/main/index.js');
  const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
  const executablePath = requireFromDesktop('electron') as string;
  const cdpEndpoint = `http://127.0.0.1:${options.cdpPort}`;

  const environment = { ...options.parentEnvironment };
  // 不继承可能把 Electron 变成 Node 或隐式开启 Main Inspector 的调试环境。
  delete environment['ELECTRON_RUN_AS_NODE'];
  delete environment['NODE_OPTIONS'];

  return {
    executablePath,
    applicationEntry,
    cdpEndpoint,
    args: [
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${options.cdpPort}`,
      // Windows E2E 环境中 GPU 沙盒子进程可能不可用，测试启动时阻止它反复崩溃。
      '--disable-gpu',
      ...(options.enableSoftwareRasterizer ? [] : ['--disable-software-rasterizer']),
      '--no-sandbox',
      applicationEntry
    ],
    environment: {
      ...environment,
      MYSELF_E2E: '1',
      MYSELF_E2E_FAKE_EXPLORER_BRIDGE: '1',
      MYSELF_E2E_USER_DATA: options.userDataDirectory,
      MYSELF_E2E_AUTHORIZED_ROOT: options.authorizedRootDirectory,
      ...(options.recycleBinDirectory
        ? { MYSELF_E2E_RECYCLE_BIN: options.recycleBinDirectory }
        : {}),
      ...(options.characterAssetsDirectory
        ? { MYSELF_E2E_CHARACTER_ASSETS: options.characterAssetsDirectory }
        : {}),
      ...(options.safeCharacterPackage
        ? { MYSELF_E2E_SAFE_CHARACTER_PACKAGE: options.safeCharacterPackage }
        : {}),
      ...(options.maliciousCharacterPackage
        ? { MYSELF_E2E_MALICIOUS_CHARACTER_PACKAGE: options.maliciousCharacterPackage }
        : {}),
      ...(options.characterExportDestination
        ? { MYSELF_E2E_CHARACTER_EXPORT: options.characterExportDestination }
        : {}),
      ...(options.localModelFixture
        ? {
            MYSELF_E2E_LOCAL_MODEL_SCRIPT: options.localModelFixture.scriptPath,
            MYSELF_E2E_LOCAL_MODEL_READY_FILE: options.localModelFixture.readyFile,
            MYSELF_E2E_LOCAL_MODEL_PID_FILE: options.localModelFixture.pidFile,
            MYSELF_E2E_LOCAL_MODEL_TOKEN: options.localModelFixture.token,
            MYSELF_E2E_LOCAL_MODEL_STDERR_CANARY: options.localModelFixture.stderrCanary
          }
        : {})
    }
  };
}

function escapedPattern(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu');
}

/** 捕获诊断日志时删除密钥、认证头和授权根绝对路径。 */
export function redactElectronLog(
  text: string,
  secrets: {
    apiKey: string;
    additionalSecrets?: readonly string[];
    authorizedRootDirectory: string;
    userDataDirectory?: string;
    recycleBinDirectory?: string;
    characterAssetsDirectory?: string;
    safeCharacterPackage?: string;
    maliciousCharacterPackage?: string;
    characterExportDestination?: string;
  }
): string {
  let sanitized = text.replace(/authorization\s*:[^\r\n]*/giu, '[已脱敏]');
  for (const secret of [
    secrets.apiKey,
    ...(secrets.additionalSecrets ?? []),
    secrets.authorizedRootDirectory,
    secrets.userDataDirectory,
    secrets.recycleBinDirectory,
    secrets.characterAssetsDirectory,
    secrets.safeCharacterPackage,
    secrets.maliciousCharacterPackage,
    secrets.characterExportDestination
  ]) {
    if (secret) sanitized = sanitized.replace(escapedPattern(secret), '[已脱敏]');
  }
  return sanitized;
}

export interface WaitForCdpReadyOptions {
  endpoint: string;
  timeoutMs: number;
  intervalMs?: number;
  probe?: (endpoint: string) => Promise<boolean>;
}

async function defaultCdpProbe(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/json/version`, {
      signal: AbortSignal.timeout(500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 轮询 CDP 版本端点；端点与总等待时间都受到显式边界约束。 */
export async function waitForCdpReady(options: WaitForCdpReadyOptions): Promise<void> {
  const url = new URL(options.endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new Error('CDP_ENDPOINT_NOT_LOOPBACK');
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('CDP_READY_TIMEOUT');
  }

  const probe = options.probe ?? defaultCdpProbe;
  const intervalMs = Math.max(1, options.intervalMs ?? 50);
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const ready = await Promise.race([
      probe(options.endpoint).catch(() => false),
      new Promise<false>(resolveTimeout => setTimeout(() => resolveTimeout(false), remainingMs))
    ]);
    if (ready) return;
    const delayMs = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    if (delayMs > 0) {
      await new Promise<void>(resolveDelay => setTimeout(resolveDelay, delayMs));
    }
  }
  throw new Error('CDP_READY_TIMEOUT');
}

export interface ElectronTemporaryDirectories {
  baseDirectory: string;
  userDataDirectory: string;
  authorizedRootDirectory: string;
  recycleBinDirectory?: string;
  characterAssetsDirectory?: string;
  packagesDirectory?: string;
  exportsDirectory?: string;
}

export interface SpawnedElectronProcess extends EventEmitter {
  pid?: number;
  spawnfile: string;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  exitCode: number | null;
  signalCode?: NodeJS.Signals | null;
  kill?(signal?: NodeJS.Signals | number): boolean;
}

export interface ElectronAppDependencies {
  allocateLoopbackPort(): Promise<number>;
  createTemporaryDirectories(): Promise<ElectronTemporaryDirectories>;
  spawnProcess(plan: ElectronLaunchPlan): SpawnedElectronProcess;
  waitForReady(options: { endpoint: string; timeoutMs: number }): Promise<void>;
  connectOverCdp(endpoint: string): Promise<Pick<Browser, 'close'>>;
  terminateProcess(process: SpawnedElectronProcess, executablePath: string): Promise<void>;
  removeTemporaryBase(baseDirectory: string): Promise<void>;
}

export interface ElectronAppFixture {
  readonly browser: Pick<Browser, 'close'>;
  readonly processId: number;
  readonly executablePath: string;
  readonly userDataDirectory: string;
  readonly authorizedRootDirectory: string;
  readonly recycleBinDirectory?: string;
  readonly characterAssetsDirectory?: string;
  readonly safeCharacterPackage?: string;
  readonly maliciousCharacterPackage?: string;
  readonly characterExportDestination?: string;
  readonly logs: readonly string[];
  readonly capturedLogEvidence: Readonly<{
    apiKey: boolean;
    authorizedRoot: boolean;
    authorizationHeader: boolean;
    sentinels: readonly boolean[];
  }>;
  sendExplorerEvent(event: MainE2eExplorerEvent): Promise<void>;
  getMainE2eState(): Promise<MainE2eState>;
  getMainDescendantProcesses(): Promise<ElectronDescendantProcess[]>;
  getPetInteractionProbe(): Promise<{
    passthrough: boolean;
    dragging: boolean;
    mouseMoveHitCount: number;
  }>;
  getCharacterBehaviorProbe(): Promise<{
    revision: number;
    primaryStateId: string;
    modifierStateIds: string[];
    actionId: string | null;
    playbackStatus: 'scheduled' | 'started' | 'completed' | 'interrupted' | 'failed' | null;
  }>;
  getCharacterMotionDeltaProbe(): Promise<{
    moved: boolean;
    horizontal: number;
    vertical: number;
  }>;
  getConversationProbe(): Promise<{
    phase: 'idle' | 'listening' | 'thinking' | 'awaiting_confirmation'
      | 'acting' | 'success' | 'error' | 'cancelled';
    visibleMessageCount: number;
    historyDisclosureVisible: boolean;
    fileConfirmationVisible: boolean;
  }>;
  markLocalModelReady(): Promise<void>;
  getLocalModelFixtureProcessId(): Promise<number>;
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

export interface CapturedLogEvidenceTracker {
  capture(source: 'stdout' | 'stderr', chunk: string | Buffer): void;
  snapshot(): ElectronAppFixture['capturedLogEvidence'];
  resetStreams(): void;
  dispose(): void;
}

/** 仅累计原始日志中的布尔泄漏证据，不保留完整正文。 */
export function createCapturedLogEvidenceTracker(input: Readonly<{
  apiKey: string;
  authorizedRootDirectory: string;
  sentinels: readonly string[];
}>): CapturedLogEvidenceTracker {
  const configuredApiKey = input.apiKey;
  const configuredAuthorizedRoot = input.authorizedRootDirectory;
  const configuredSentinels = [...input.sentinels];
  if (configuredSentinels.some(sentinel => sentinel.length === 0)) {
    throw new Error('EMPTY_LOG_SENTINEL');
  }
  let apiKey = false;
  let authorizedRoot = false;
  let authorizationHeader = false;
  const sentinels = configuredSentinels.map(() => false);
  const tailLength = Math.max(
    64,
    configuredApiKey.length - 1,
    configuredAuthorizedRoot.length - 1,
    ...configuredSentinels.map(value => value.length - 1)
  );
  const tails: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  const decoders: Record<'stdout' | 'stderr', StringDecoder> = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8')
  };
  let disposed = false;

  const resetStreams = (): void => {
    tails.stdout = '';
    tails.stderr = '';
    decoders.stdout = new StringDecoder('utf8');
    decoders.stderr = new StringDecoder('utf8');
  };

  return {
    capture(source, chunk) {
      if (disposed) return;
      const decodedChunk = typeof chunk === 'string'
        ? decoders[source].end() + chunk
        : decoders[source].write(chunk);
      if (typeof chunk === 'string') decoders[source] = new StringDecoder('utf8');
      const text = tails[source] + decodedChunk;
      apiKey ||= Boolean(configuredApiKey && text.includes(configuredApiKey));
      authorizedRoot ||= Boolean(
        configuredAuthorizedRoot
        && text.includes(configuredAuthorizedRoot)
      );
      authorizationHeader ||= /["']?authorization["']?\s*:/iu.test(text);
      configuredSentinels.forEach((sentinel, index) => {
        sentinels[index] ||= Boolean(sentinel && text.includes(sentinel));
      });
      tails[source] = text.slice(-tailLength);
    },
    snapshot() {
      return Object.freeze({
        apiKey,
        authorizedRoot,
        authorizationHeader,
        sentinels: Object.freeze([...sentinels])
      });
    },
    resetStreams() {
      resetStreams();
    },
    dispose() {
      resetStreams();
      disposed = true;
    }
  };
}

export interface CreateElectronAppFixtureOptions {
  workspaceRoot: string;
  apiKey: string;
  additionalSecrets?: readonly string[];
  logSentinels?: readonly string[];
  launchTimeoutMs?: number;
  operationTimeoutMs?: number;
  enableSoftwareRasterizer?: boolean;
  enableLocalModelFixture?: boolean;
  localModelToken?: string;
  localModelStderrCanary?: string;
  prepareUserData?(directories: ElectronTemporaryDirectories): Promise<void>;
  beforeRestart?(directories: ElectronTemporaryDirectories): Promise<void>;
  dependencies?: ElectronAppDependencies;
}

export type MainE2eExplorerEvent =
  | 'layer-error'
  | 'stale-sequence'
  | 'non-explorer'
  | 'ambiguous'
  | 'foreground-explorer'
  | 'minimized'
  | 'blurred'
  | 'crash';

export interface MainE2eState {
  revision: number;
  petWindowVisible: boolean;
  petWindowAlwaysOnTop: boolean;
  processedExplorerEventRevision: number;
  processedExplorerEvent: MainE2eExplorerEvent | null;
  bridge: {
    state: 'idle' | 'ready' | 'failed' | 'closed';
    observing: boolean;
    polling: boolean;
    eventRevision: number;
  };
  layer: {
    status: 'idle' | 'active' | 'failed' | 'closed';
    activationRevision: number;
    errorRevision: number;
  };
  geometry: {
    revision: number;
    scaleTick: number;
    visualBoundsInWindowRatio: { x: number; y: number; width: number; height: number };
    outOfBounds: boolean;
  } | null;
}

const MAIN_E2E_EXPLORER_EVENTS = new Set<MainE2eExplorerEvent>([
  'layer-error',
  'stale-sequence',
  'non-explorer',
  'ambiguous',
  'foreground-explorer',
  'minimized',
  'blurred',
  'crash'
]);

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate);
}

function validNormalizedVisualBounds(candidate: unknown): boolean {
  if (!isObject(candidate) || Object.keys(candidate).length !== 4) return false;
  const x = candidate.x;
  const y = candidate.y;
  const width = candidate.width;
  const height = candidate.height;
  if (
    !Number.isFinite(x) || !Number.isFinite(y)
    || !Number.isFinite(width) || !Number.isFinite(height)
  ) return false;
  const values = { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
  return values.x >= 0
    && values.y >= 0
    && values.width > 0
    && values.height > 0
    && values.x + values.width <= 1.000001
    && values.y + values.height <= 1.000001;
}

/** E2E 状态文件是测试进程唯一入口；几何字段按最小披露契约精确拒绝扩展。 */
export function parseMainE2eState(candidate: unknown): MainE2eState {
  if (!isObject(candidate)) throw new Error('ELECTRON_E2E_MAIN_STATE_INVALID');
  const bridge = candidate.bridge;
  const layer = candidate.layer;
  const geometry = candidate.geometry;
  const validGeometry = geometry === null || Boolean(
    isObject(geometry)
    && Object.keys(geometry).length === 4
    && Number.isSafeInteger(geometry.revision)
    && Number(geometry.revision) > 0
    && Number.isSafeInteger(geometry.scaleTick)
    && Number(geometry.scaleTick) >= 5
    && Number(geometry.scaleTick) <= 20
    && validNormalizedVisualBounds(geometry.visualBoundsInWindowRatio)
    && typeof geometry.outOfBounds === 'boolean'
  );
  if (
    !Number.isSafeInteger(candidate.revision)
    || Number(candidate.revision) <= 0
    || typeof candidate.petWindowVisible !== 'boolean'
    || typeof candidate.petWindowAlwaysOnTop !== 'boolean'
    || !Number.isSafeInteger(candidate.processedExplorerEventRevision)
    || Number(candidate.processedExplorerEventRevision) < 0
    || (candidate.processedExplorerEvent !== null
      && !MAIN_E2E_EXPLORER_EVENTS.has(candidate.processedExplorerEvent as MainE2eExplorerEvent))
    || !isObject(bridge)
    || !new Set(['idle', 'ready', 'failed', 'closed']).has(String(bridge.state))
    || typeof bridge.observing !== 'boolean'
    || typeof bridge.polling !== 'boolean'
    || !Number.isSafeInteger(bridge.eventRevision)
    || Number(bridge.eventRevision) < 0
    || !isObject(layer)
    || !new Set(['idle', 'active', 'failed', 'closed']).has(String(layer.status))
    || !Number.isSafeInteger(layer.activationRevision)
    || Number(layer.activationRevision) < 0
    || !Number.isSafeInteger(layer.errorRevision)
    || Number(layer.errorRevision) < 0
    || !validGeometry
  ) throw new Error('ELECTRON_E2E_MAIN_STATE_INVALID');
  return candidate as unknown as MainE2eState;
}

/** fixture 只追加固定无参数令牌，禁止把路径、HWND 或任意命令写入 Main。 */
export async function writeMainE2eExplorerEvent(
  userDataDirectory: string,
  event: MainE2eExplorerEvent
): Promise<void> {
  if (!MAIN_E2E_EXPLORER_EVENTS.has(event)) {
    throw new Error('E2E_EXPLORER_EVENT_INVALID');
  }
  await appendFile(
    join(userDataDirectory, 'main-e2e-explorer-events'),
    `${event}\n`,
    { encoding: 'utf8' }
  );
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
  });
  return address.port;
}

async function createTemporaryDirectories(): Promise<ElectronTemporaryDirectories> {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'myself-e2e-'));
  const userDataDirectory = join(baseDirectory, 'user-data');
  const authorizedRootDirectory = join(baseDirectory, 'authorized-root');
  const recycleBinDirectory = join(baseDirectory, 'recycle-bin');
  const characterAssetsDirectory = join(baseDirectory, 'character-assets');
  const packagesDirectory = join(baseDirectory, 'packages');
  const exportsDirectory = join(baseDirectory, 'exports');
  await Promise.all([
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(authorizedRootDirectory, { recursive: true }),
    mkdir(recycleBinDirectory, { recursive: true }),
    mkdir(characterAssetsDirectory, { recursive: true }),
    mkdir(packagesDirectory, { recursive: true }),
    mkdir(exportsDirectory, { recursive: true })
  ]);
  return {
    baseDirectory,
    userDataDirectory,
    authorizedRootDirectory,
    recycleBinDirectory,
    characterAssetsDirectory,
    packagesDirectory,
    exportsDirectory
  };
}

export interface SpawnedCommandProcess extends EventEmitter {
  exitCode: number | null;
  signalCode?: NodeJS.Signals | null;
  kill?(signal?: NodeJS.Signals | number): boolean;
}

export interface TerminateElectronProcessOptions {
  platform?: NodeJS.Platform;
  gracefulExitTimeoutMs?: number;
  taskkillTimeoutMs?: number;
  helperExitTimeoutMs?: number;
  processExitTimeoutMs?: number;
  probeTimeoutMs?: number;
  probeIntervalMs?: number;
  spawnCommand?(file: string, args: string[]): SpawnedCommandProcess;
  processProbe?(processId: number, signal?: AbortSignal): Promise<ProcessProbeResult>;
  onDiagnostic?(message: string): void;
}

export type ProcessProbeResult =
  | { status: 'absent' }
  | { status: 'running'; executablePath: string };

export interface WindowsProcessProbeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProbeWindowsProcessOptions {
  signal?: AbortSignal;
  runCommand?(
    file: string,
    args: string[],
    signal?: AbortSignal
  ): Promise<WindowsProcessProbeCommandResult>;
}

export interface ElectronDescendantProcess {
  processId: number;
  name: string;
  powershell: boolean;
  explorerBridge: boolean;
}

export interface InspectWindowsElectronDescendantsOptions {
  signal?: AbortSignal;
  runCommand?(
    file: string,
    args: string[],
    signal?: AbortSignal
  ): Promise<WindowsProcessProbeCommandResult>;
}

function hasProcessExited(
  process: SpawnedElectronProcess | SpawnedCommandProcess
): boolean {
  return process.exitCode !== null
    || (process.signalCode !== undefined && process.signalCode !== null);
}

/** 有界等待指定进程自身退出，并用监听前后双检覆盖已错过的 exit 事件。 */
async function waitForProcessExit(
  process: SpawnedElectronProcess | SpawnedCommandProcess,
  timeoutMs: number
): Promise<boolean> {
  if (hasProcessExited(process)) return true;
  return new Promise<boolean>(resolveWait => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      process.removeListener('exit', handleExit);
      resolveWait(exited);
    };
    const handleExit = (): void => {
      finish(true);
    };
    process.once('exit', handleExit);
    if (hasProcessExited(process)) {
      finish(true);
      return;
    }
    timeout = setTimeout(() => finish(hasProcessExited(process)), timeoutMs);
  });
}

type TaskkillWaitResult =
  | { status: 'exited' }
  | { status: 'failed'; error: unknown }
  | { status: 'timed-out' };

/** 有界等待 taskkill 的退出或异步启动错误，并在任一路径收敛时移除全部观察资源。 */
async function waitForTaskkillSettlement(
  process: SpawnedCommandProcess,
  timeoutMs: number
): Promise<TaskkillWaitResult> {
  if (hasProcessExited(process)) return { status: 'exited' };
  return new Promise<TaskkillWaitResult>(resolveWait => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: TaskkillWaitResult): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      process.removeListener('exit', handleExit);
      process.removeListener('error', handleError);
      resolveWait(result);
    };
    const handleExit = (): void => {
      finish({ status: 'exited' });
    };
    const handleError = (error: unknown): void => {
      finish({ status: 'failed', error });
    };
    process.once('exit', handleExit);
    process.once('error', handleError);
    if (hasProcessExited(process)) {
      finish({ status: 'exited' });
      return;
    }
    timeout = setTimeout(
      () => finish(hasProcessExited(process)
        ? { status: 'exited' }
        : { status: 'timed-out' }),
      timeoutMs
    );
  });
}

/** 有界等待异步辅助操作完成或失败，用于取消后确认其回调已经收敛。 */
async function waitForPromiseSettlement(
  operation: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true, () => true),
      new Promise<boolean>(resolveWait => {
        timeout = setTimeout(() => resolveWait(false), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sameExecutablePath(
  actualPath: string,
  expectedPath: string,
  platform: NodeJS.Platform
): boolean {
  const actual = resolve(actualPath);
  const expected = resolve(expectedPath);
  return platform === 'win32'
    ? actual.toLocaleLowerCase('en-US') === expected.toLocaleLowerCase('en-US')
    : actual === expected;
}

function sanitizeProcessProbeDiagnostic(text: string): string {
  return text
    .replace(/authorization\s*:[^\r\n]*/giu, '[已脱敏]')
    .replace(/myself-e2e-[0-9a-f]{48}/giu, '[已脱敏]')
    .replace(/[A-Z]:\\[^\r\n]*?myself-e2e-[^\\\r\n]+\\authorized-root/giu, '[已脱敏]')
    .replace(/\/[^\r\n]*?myself-e2e-[^/\r\n]+\/authorized-root/giu, '[已脱敏]')
    .slice(0, 800);
}

const WINDOWS_PROCESS_PATH_TEMPORARILY_UNAVAILABLE =
  'WINDOWS_PROCESS_PATH_TEMPORARILY_UNAVAILABLE';

function isTemporarilyUnavailableProcessProbeError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes(WINDOWS_PROCESS_PATH_TEMPORARILY_UNAVAILABLE);
}

function taskkillFailureDiagnostic(error: unknown): string {
  const message = sanitizeProcessProbeDiagnostic(
    error instanceof Error ? error.message : String(error)
  );
  return `TASKKILL_FAILED:${message || 'UNKNOWN'}`;
}

async function runWindowsProbeCommand(
  file: string,
  args: string[],
  signal?: AbortSignal
): Promise<WindowsProcessProbeCommandResult> {
  return new Promise<WindowsProcessProbeCommandResult>(resolveCommand => {
    execFile(
      file,
      args,
      { encoding: 'utf8', windowsHide: true, signal },
      (error, stdout, stderr) => {
        const rawCode = error && 'code' in error ? error.code : 0;
        resolveCommand({
          exitCode: typeof rawCode === 'number' ? rawCode : (error ? -1 : 0),
          stdout,
          stderr: stderr || (error?.message ?? '')
        });
      }
    );
  });
}

/** Windows 权威探针：只返回 PID 是否存在及其规范化绝对可执行路径。 */
export async function probeWindowsProcess(
  processId: number,
  options: ProbeWindowsProcessOptions = {}
): Promise<ProcessProbeResult> {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error('WINDOWS_PROCESS_PROBE_PID_INVALID');
  }
  const script = [
    `$targetProcess = Get-Process -Id ${String(processId)} -ErrorAction SilentlyContinue`,
    "if ($null -eq $targetProcess) { [Console]::Out.Write('ABSENT'); exit 0 }",
    'try { $targetPath = $targetProcess.Path } catch { exit 3 }',
    'if ([string]::IsNullOrWhiteSpace($targetPath)) { exit 4 }',
    '[Console]::Out.Write($targetPath)'
  ].join('; ');
  const result = await (options.runCommand ?? runWindowsProbeCommand)(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    options.signal
  );
  if (result.exitCode === 4) {
    throw new Error(WINDOWS_PROCESS_PATH_TEMPORARILY_UNAVAILABLE);
  }
  if (result.exitCode !== 0) {
    const diagnostic = sanitizeProcessProbeDiagnostic(result.stderr);
    throw new Error(
      `WINDOWS_PROCESS_PROBE_COMMAND_FAILED:exit=${String(result.exitCode)}`
      + (diagnostic ? `\nstderr:${diagnostic}` : '')
    );
  }
  const output = result.stdout.trim();
  if (output === 'ABSENT') return { status: 'absent' };
  if (!output || !isAbsolute(output)) {
    throw new Error('WINDOWS_PROCESS_PATH_UNVERIFIED');
  }
  return { status: 'running', executablePath: resolve(output) };
}

interface WindowsProcessTreeRow {
  processId: number;
  parentProcessId: number;
  name: string;
  commandLine: string;
}

function parseWindowsProcessTree(stdout: string): WindowsProcessTreeRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error('WINDOWS_PROCESS_TREE_OUTPUT_INVALID');
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length > 4_096) throw new Error('WINDOWS_PROCESS_TREE_OUTPUT_INVALID');
  return rows.map(row => {
    if (!row || typeof row !== 'object') {
      throw new Error('WINDOWS_PROCESS_TREE_OUTPUT_INVALID');
    }
    const candidate = row as Record<string, unknown>;
    const processId = candidate['ProcessId'];
    const parentProcessId = candidate['ParentProcessId'];
    const name = candidate['Name'];
    const commandLine = candidate['CommandLine'];
    if (
      typeof processId !== 'number'
      || !Number.isSafeInteger(processId)
      || processId < 0
      || typeof parentProcessId !== 'number'
      || !Number.isSafeInteger(parentProcessId)
      || parentProcessId < 0
      || typeof name !== 'string'
      || name.length < 1
      || name.length > 260
      || (commandLine !== null && typeof commandLine !== 'string')
      || (typeof commandLine === 'string' && commandLine.length > 32_768)
    ) throw new Error('WINDOWS_PROCESS_TREE_OUTPUT_INVALID');
    return {
      processId,
      parentProcessId,
      name,
      commandLine: commandLine ?? ''
    };
  });
}

/** fixture-only 只读证据：从一次 Windows 进程快照筛出 Electron Main 的全部后代。 */
export async function inspectWindowsElectronDescendants(
  processId: number,
  options: InspectWindowsElectronDescendantsOptions = {}
): Promise<ElectronDescendantProcess[]> {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error('WINDOWS_PROCESS_TREE_PID_INVALID');
  }
  const script = [
    'Get-CimInstance Win32_Process',
    '| Select-Object ProcessId,ParentProcessId,Name,CommandLine',
    '| ConvertTo-Json -Compress'
  ].join(' ');
  const result = await (options.runCommand ?? runWindowsProbeCommand)(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    options.signal ?? AbortSignal.timeout(5_000)
  );
  if (result.exitCode !== 0) {
    const diagnostic = sanitizeProcessProbeDiagnostic(result.stderr);
    throw new Error(
      `WINDOWS_PROCESS_TREE_COMMAND_FAILED:exit=${String(result.exitCode)}`
      + (diagnostic ? `\nstderr:${diagnostic}` : '')
    );
  }

  const children = new Map<number, WindowsProcessTreeRow[]>();
  for (const row of parseWindowsProcessTree(result.stdout)) {
    const siblings = children.get(row.parentProcessId) ?? [];
    siblings.push(row);
    children.set(row.parentProcessId, siblings);
  }
  const descendants: ElectronDescendantProcess[] = [];
  const pending = [processId];
  const visited = new Set(pending);
  while (pending.length > 0) {
    const parentProcessId = pending.shift()!;
    for (const child of children.get(parentProcessId) ?? []) {
      if (visited.has(child.processId)) continue;
      visited.add(child.processId);
      pending.push(child.processId);
      const normalizedName = child.name.toLocaleLowerCase('en-US');
      const powershell = normalizedName === 'powershell.exe' || normalizedName === 'pwsh.exe';
      descendants.push({
        processId: child.processId,
        name: child.name,
        powershell,
        explorerBridge: powershell
          && child.commandLine.toLocaleLowerCase('en-US').includes('explorer-space-bridge.ps1')
      });
    }
  }
  return descendants;
}

/** 只终止已验证路径与 PID 的原始 child，并以其真实退出作为成功条件。 */
export async function terminateElectronProcess(
  process: SpawnedElectronProcess,
  executablePath: string,
  options: TerminateElectronProcessOptions = {}
): Promise<void> {
  const processId = process.pid;
  if (!Number.isSafeInteger(processId) || !processId || processId <= 0) {
    throw new Error('ELECTRON_PROCESS_PID_INVALID');
  }
  const platform = options.platform ?? globalThis.process.platform;
  if (!sameExecutablePath(process.spawnfile, executablePath, platform)) {
    throw new Error('ELECTRON_PROCESS_PATH_MISMATCH');
  }
  if (hasProcessExited(process)) return;

  const processExitTimeoutMs = options.processExitTimeoutMs ?? 2_000;
  let terminationDiagnostic = '';
  if (platform === 'win32') {
    // browser.close() 会先请求 Electron 自然退出；宽限期结束后才进入强制清理链路。
    if (await waitForProcessExit(process, options.gracefulExitTimeoutMs ?? 3_000)) return;
    const processProbe = options.processProbe
      ?? ((targetProcessId: number, signal?: AbortSignal) => probeWindowsProcess(
        targetProcessId,
        { signal }
      ));
    const probe = async (): Promise<ProcessProbeResult> => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let probeTimedOut = false;
      const abortController = new AbortController();
      const probeOperation = Promise.resolve().then(
        () => processProbe(processId, abortController.signal)
      );
      try {
        const result = await Promise.race([
          probeOperation,
          new Promise<never>((_resolveProbe, rejectProbe) => {
            timeout = setTimeout(
              () => {
                probeTimedOut = true;
                rejectProbe(new Error('PROCESS_PROBE_TIMEOUT'));
              },
              options.probeTimeoutMs ?? 5_000
            );
          })
        ]);
        if (result.status === 'absent') return result;
        if (result.status !== 'running' || !result.executablePath) {
          throw new Error('PROCESS_PROBE_PATH_UNVERIFIED');
        }
        return result;
      } catch (error) {
        let probeError = error;
        if (probeTimedOut) {
          abortController.abort();
          const settled = await waitForPromiseSettlement(
            probeOperation,
            options.helperExitTimeoutMs ?? 1_000
          );
          if (!settled) probeError = new Error('PROCESS_PROBE_CONTRACT_VIOLATION');
        }
        const diagnostic = sanitizeProcessProbeDiagnostic(
          probeError instanceof Error ? probeError.message : String(probeError)
        );
        throw new Error(
          `ELECTRON_PROCESS_PROBE_FAILED:${String(processId)}`
          + (diagnostic ? `\n${diagnostic}` : '')
        );
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    const inspectOriginalProcess = async (): Promise<'exited' | 'owned'> => {
      const deadline = Date.now() + processExitTimeoutMs;
      while (true) {
        if (hasProcessExited(process)) return 'exited';
        try {
          const result = await probe();
          if (hasProcessExited(process)) return 'exited';
          if (result.status === 'absent') return 'exited';
          if (!sameExecutablePath(result.executablePath, executablePath, platform)) {
            options.onDiagnostic?.(`ELECTRON_PROCESS_PID_REUSED:${String(processId)}`);
            return 'exited';
          }
          return 'owned';
        } catch (error) {
          if (!isTemporarilyUnavailableProcessProbeError(error)) throw error;
          if (hasProcessExited(process)) return 'exited';
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) throw error;
          // 退出中的 Windows 进程可能仍保留 PID，却暂时不再暴露可执行路径。
          await new Promise<void>(resolveDelay => setTimeout(
            resolveDelay,
            Math.min(options.probeIntervalMs ?? 50, remainingMs)
          ));
        }
      }
    };

    // 任一破坏性操作前先以 OS 级 PID 与完整路径确认仍属于原项目进程。
    if (await inspectOriginalProcess() === 'exited') return;
    const spawnCommand = options.spawnCommand ?? ((file: string, args: string[]) => spawn(file, args, {
      stdio: 'ignore',
      windowsHide: true
    }));
    let taskkillHelperStillRunning = false;
    try {
      const taskkill = spawnCommand(
        'taskkill.exe',
        ['/PID', String(processId), '/T', '/F']
      );
      const taskkillResult = await waitForTaskkillSettlement(
        taskkill,
        options.taskkillTimeoutMs ?? 1_500
      );
      if (taskkillResult.status === 'timed-out') {
        taskkill.kill?.('SIGKILL');
        terminationDiagnostic = 'TASKKILL_TIMEOUT';
        const helperResult = await waitForTaskkillSettlement(
          taskkill,
          options.helperExitTimeoutMs ?? 1_000
        );
        if (helperResult.status === 'failed') {
          terminationDiagnostic = taskkillFailureDiagnostic(helperResult.error);
        }
        taskkillHelperStillRunning = helperResult.status === 'timed-out';
      } else if (taskkillResult.status === 'failed') {
        terminationDiagnostic = taskkillFailureDiagnostic(taskkillResult.error);
      } else if (taskkill.exitCode !== 0) {
        terminationDiagnostic = `TASKKILL_EXIT_${String(taskkill.exitCode)}`;
      } else {
        terminationDiagnostic = 'TASKKILL_EXIT_0';
      }
    } catch (error) {
      terminationDiagnostic = taskkillFailureDiagnostic(error);
    }
    if (taskkillHelperStillRunning) {
      throw new Error(`TASKKILL_HELPER_STILL_RUNNING:${String(processId)}`);
    }

    if (await inspectOriginalProcess() === 'exited') return;
    process.kill?.('SIGKILL');
    const deadline = Date.now() + processExitTimeoutMs;
    while (Date.now() < deadline) {
      if (await inspectOriginalProcess() === 'exited') return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await new Promise<void>(resolveDelay => setTimeout(
        resolveDelay,
        Math.min(options.probeIntervalMs ?? 50, remainingMs)
      ));
    }
    throw new Error(
      `ELECTRON_PROCESS_STILL_RUNNING:${String(processId)}:${terminationDiagnostic || 'UNKNOWN'}`
    );
  } else {
    process.kill?.('SIGTERM');
    if (await waitForProcessExit(process, processExitTimeoutMs)) return;
    terminationDiagnostic = 'SIGTERM_CHILD_STILL_RUNNING';
  }

  if (hasProcessExited(process)) return;
  process.kill?.('SIGKILL');
  if (await waitForProcessExit(process, processExitTimeoutMs)) return;
  throw new Error(
    `ELECTRON_PROCESS_STILL_RUNNING:${String(processId)}:${terminationDiagnostic || 'UNKNOWN'}`
  );
}

function spawnElectronProcess(plan: ElectronLaunchPlan): SpawnedElectronProcess {
  return spawn(plan.executablePath, plan.args, {
    cwd: resolve(plan.applicationEntry, '..'),
    env: plan.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

const defaultDependencies: ElectronAppDependencies = {
  allocateLoopbackPort,
  createTemporaryDirectories,
  spawnProcess: spawnElectronProcess,
  waitForReady: options => waitForCdpReady(options),
  connectOverCdp: endpoint => chromium.connectOverCDP(endpoint),
  terminateProcess: terminateElectronProcess,
  removeTemporaryBase: baseDirectory => rm(baseDirectory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100
  })
};

/**
 * 启动构建后的项目 Electron 并连接 Renderer CDP；任一失败路径都执行同一清理流程。
 */
export async function createElectronAppFixture(
  options: CreateElectronAppFixtureOptions
): Promise<ElectronAppFixture> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const directories = await dependencies.createTemporaryDirectories();
  const characterFixtures = options.dependencies
    ? {
        characterAssetsDirectory: directories.characterAssetsDirectory,
        safeCharacterPackage: directories.packagesDirectory
          ? join(directories.packagesDirectory, 'safe-character.zip')
          : undefined,
        maliciousCharacterPackage: directories.packagesDirectory
          ? join(directories.packagesDirectory, 'malicious-character.zip')
          : undefined,
        characterExportDestination: directories.exportsDirectory
          ? join(directories.exportsDirectory, 'exported-character.zip')
          : undefined
      }
    : await materializeCharacterWorkshopFixtures(
        options.workspaceRoot,
        directories.baseDirectory,
        directories.characterAssetsDirectory!,
        directories.packagesDirectory!,
        directories.exportsDirectory!
      );
  const localModelFixture = options.enableLocalModelFixture
    ? {
        scriptPath: join(directories.baseDirectory, 'fake-local-model-process.mjs'),
        readyFile: join(directories.baseDirectory, 'local-model-ready'),
        pidFile: join(directories.baseDirectory, 'local-model-pid'),
        token: options.localModelToken ?? '',
        stderrCanary: options.localModelStderrCanary ?? ''
      }
    : undefined;
  if (localModelFixture) {
    if (!localModelFixture.token || !localModelFixture.stderrCanary) {
      throw new Error('LOCAL_MODEL_E2E_FIXTURE_OPTIONS_INVALID');
    }
    await copyFile(
      resolve(options.workspaceRoot, 'tests/fixtures/fake-local-model-process.mjs'),
      localModelFixture.scriptPath
    );
  }
  await options.prepareUserData?.(directories);
  const capturedChunks: string[] = [];
  const capturedLogEvidenceTracker = createCapturedLogEvidenceTracker({
    apiKey: options.apiKey,
    authorizedRootDirectory: directories.authorizedRootDirectory,
    sentinels: options.logSentinels ?? []
  });
  let child: SpawnedElectronProcess | null = null;
  let browser: Pick<Browser, 'close'> | null = null;
  let plan: ElectronLaunchPlan | null = null;
  let disposed = false;
  let disposeStarted = false;
  let logStreamEpoch = 0;
  const operationTimeoutMs = options.operationTimeoutMs ?? 5_000;
  const diagnosticRedactionValues = [
    ...(options.additionalSecrets ?? []),
    ...(options.logSentinels ?? [])
  ];

  const capture = (source: 'stdout' | 'stderr', chunk: string | Buffer): void => {
    capturedLogEvidenceTracker.capture(source, chunk);
    capturedChunks.push(String(chunk).slice(0, 4_000));
    if (capturedChunks.length > 100) capturedChunks.shift();
  };

  /** 对完整聚合文本脱敏后再切段，避免跨 chunk 秘密绕过单段替换。 */
  const sanitizedLogs = (): string[] => {
    const sanitized = redactElectronLog(capturedChunks.join(''), {
      apiKey: options.apiKey,
      additionalSecrets: diagnosticRedactionValues,
      authorizedRootDirectory: directories.authorizedRootDirectory,
      userDataDirectory: directories.userDataDirectory,
      characterAssetsDirectory: directories.characterAssetsDirectory,
      safeCharacterPackage: characterFixtures.safeCharacterPackage,
      maliciousCharacterPackage: characterFixtures.maliciousCharacterPackage,
      characterExportDestination: characterFixtures.characterExportDestination
    });
    const segments: string[] = [];
    for (let offset = 0; offset < sanitized.length; offset += 4_000) {
      segments.push(sanitized.slice(offset, offset + 4_000));
    }
    return segments.slice(-100);
  };

  const diagnosticError = (
    kind: 'ELECTRON_STAGE_TIMEOUT' | 'ELECTRON_STAGE_FAILED',
    stage: string,
    cause?: unknown
  ): Error => {
    const rawCause = cause instanceof Error ? cause.message : String(cause ?? '');
    const sanitizedCause = redactElectronLog(rawCause, {
      apiKey: options.apiKey,
      additionalSecrets: diagnosticRedactionValues,
      authorizedRootDirectory: directories.authorizedRootDirectory,
      userDataDirectory: directories.userDataDirectory,
      characterAssetsDirectory: directories.characterAssetsDirectory,
      safeCharacterPackage: characterFixtures.safeCharacterPackage,
      maliciousCharacterPackage: characterFixtures.maliciousCharacterPackage,
      characterExportDestination: characterFixtures.characterExportDestination
    });
    const diagnostics = sanitizedLogs().join('').slice(-4_000) || '无捕获日志';
    return new Error(
      `${kind}:${stage}\n原因:${sanitizedCause || '阶段超时'}\n脱敏诊断:${diagnostics}`
    );
  };

  const runStage = async <T>(
    stage: string,
    operation: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation().catch(error => {
          throw diagnosticError('ELECTRON_STAGE_FAILED', stage, error);
        }),
        new Promise<never>((_resolveTimeout, rejectTimeout) => {
          timeout = setTimeout(() => {
            rejectTimeout(diagnosticError('ELECTRON_STAGE_TIMEOUT', stage));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const aggregatePrimaryWithCleanup = (
    primary: unknown,
    cleanup: unknown
  ): AggregateError => {
    const primaryError = primary instanceof Error
      ? primary
      : diagnosticError('ELECTRON_STAGE_FAILED', 'primary_error', primary);
    const cleanupErrors = cleanup instanceof AggregateError
      ? cleanup.errors.map(error => error instanceof Error
        ? error
        : diagnosticError('ELECTRON_STAGE_FAILED', 'cleanup_error', error))
      : [cleanup instanceof Error
        ? cleanup
        : diagnosticError('ELECTRON_STAGE_FAILED', 'cleanup_error', cleanup)];
    return new AggregateError(
      [primaryError, ...cleanupErrors],
      `${primaryError.message}\n附加清理错误:${cleanupErrors.map(error => error.message).join(' | ')}`,
      { cause: primaryError }
    );
  };

  const cleanupCurrentProcess = async (): Promise<void> => {
    const cleanupErrors: Error[] = [];
    const currentBrowser = browser;
    const currentChild = child;
    const currentPlan = plan;
    if (currentBrowser) {
      try {
        await runStage(
          'cleanup_browser_close',
          () => currentBrowser.close(),
          operationTimeoutMs
        );
        if (browser === currentBrowser) browser = null;
      } catch (error) {
        cleanupErrors.push(error as Error);
      }
    }
    if (currentChild && currentPlan) {
      try {
        // 进程终止器独占 graceful/taskkill/probe/exit 超时，禁止再叠加通用阶段超时。
        await dependencies.terminateProcess(currentChild, currentPlan.executablePath);
        if (child === currentChild) {
          child = null;
          plan = null;
        }
      } catch (error) {
        cleanupErrors.push(error as Error);
      }
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'ELECTRON_CLEANUP_FAILED', {
        cause: cleanupErrors[0]
      });
    }
  };

  const launch = async (): Promise<void> => {
    const currentLogStreamEpoch = ++logStreamEpoch;
    capturedLogEvidenceTracker.resetStreams();
    const cdpPort = await dependencies.allocateLoopbackPort();
    if (disposeStarted || disposed) throw new Error('ELECTRON_FIXTURE_DISPOSED');
    const nextPlan = createElectronLaunchPlan({
      workspaceRoot: options.workspaceRoot,
      cdpPort,
      userDataDirectory: directories.userDataDirectory,
      authorizedRootDirectory: directories.authorizedRootDirectory,
      recycleBinDirectory: directories.recycleBinDirectory,
      ...characterFixtures,
      parentEnvironment: globalThis.process.env,
      enableSoftwareRasterizer: options.enableSoftwareRasterizer,
      localModelFixture
    });
    const nextChild = dependencies.spawnProcess(nextPlan);
    plan = nextPlan;
    child = nextChild;
    nextChild.stdout?.on('data', chunk => {
      if (currentLogStreamEpoch === logStreamEpoch) capture('stdout', chunk);
    });
    nextChild.stderr?.on('data', chunk => {
      if (currentLogStreamEpoch === logStreamEpoch) capture('stderr', chunk);
    });
    try {
      const processFailure = new Promise<never>((_resolveFailure, rejectFailure) => {
        nextChild.once('error', rejectFailure);
        nextChild.once('exit', (code, signal) => {
          rejectFailure(new Error(
            `ELECTRON_EXITED_BEFORE_CDP:${String(code)}:${String(signal)}`
          ));
        });
      });
      const launchTimeoutMs = options.launchTimeoutMs ?? 15_000;
      await runStage('wait_cdp_ready', () => Promise.race([
        dependencies.waitForReady({ endpoint: nextPlan.cdpEndpoint, timeoutMs: launchTimeoutMs }),
        processFailure
      ]), launchTimeoutMs);
      browser = await runStage(
        'connect_over_cdp',
        () => dependencies.connectOverCdp(nextPlan.cdpEndpoint),
        operationTimeoutMs
      );
      const processId = nextChild.pid;
      if (!Number.isSafeInteger(processId) || !processId || processId <= 0) {
        throw new Error('ELECTRON_PROCESS_PID_INVALID');
      }
    } catch (error) {
      throw error;
    }
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposeStarted = true;
    try {
      const cleanupErrors: Error[] = [];
      try {
        await cleanupCurrentProcess();
      } catch (error) {
        if (error instanceof AggregateError) {
          cleanupErrors.push(...error.errors.map(item => item instanceof Error
            ? item
            : new Error(String(item))));
        } else {
          cleanupErrors.push(error as Error);
        }
      }
      // 原 child 尚存活时不得移除其正在使用的目录；browser 关闭失败不阻止已退出进程的目录回收。
      if (!child) {
        try {
          await runStage(
            'cleanup_temporary_directory',
            () => dependencies.removeTemporaryBase(directories.baseDirectory),
            operationTimeoutMs
          );
        } catch (error) {
          cleanupErrors.push(error as Error);
        }
      }
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, 'ELECTRON_DISPOSE_FAILED', {
          cause: cleanupErrors[0]
        });
      }
      disposed = true;
    } finally {
      // 首次释放即封闭证据流；资源清理失败仍可由后续 dispose 重试。
      capturedLogEvidenceTracker.dispose();
    }
  };

  try {
    await launch();
    return {
      get browser() {
        if (!browser) throw new Error('ELECTRON_BROWSER_NOT_CONNECTED');
        return browser;
      },
      get processId() {
        const processId = child?.pid;
        if (!Number.isSafeInteger(processId) || !processId || processId <= 0) {
          throw new Error('ELECTRON_PROCESS_PID_INVALID');
        }
        return processId;
      },
      get executablePath() {
        if (!plan) throw new Error('ELECTRON_LAUNCH_PLAN_UNAVAILABLE');
        return plan.executablePath;
      },
      userDataDirectory: directories.userDataDirectory,
      authorizedRootDirectory: directories.authorizedRootDirectory,
      recycleBinDirectory: directories.recycleBinDirectory,
      characterAssetsDirectory: directories.characterAssetsDirectory,
      safeCharacterPackage: characterFixtures.safeCharacterPackage,
      maliciousCharacterPackage: characterFixtures.maliciousCharacterPackage,
      characterExportDestination: characterFixtures.characterExportDestination,
      get logs() {
        return sanitizedLogs();
      },
      get capturedLogEvidence() {
        return capturedLogEvidenceTracker.snapshot();
      },
      sendExplorerEvent: event => writeMainE2eExplorerEvent(
        directories.userDataDirectory,
        event
      ),
      async getMainE2eState() {
        return parseMainE2eState(JSON.parse(await readFile(
          join(directories.userDataDirectory, 'main-e2e-state.json'),
          'utf8'
        )));
      },
      getMainDescendantProcesses() {
        const processId = child?.pid;
        if (!Number.isSafeInteger(processId) || !processId || processId <= 0) {
          throw new Error('ELECTRON_PROCESS_PID_INVALID');
        }
        return inspectWindowsElectronDescendants(processId);
      },
      async getPetInteractionProbe() {
        if (!browser || !('contexts' in browser) || typeof browser.contexts !== 'function') {
          throw new Error('ELECTRON_E2E_PROBE_BROWSER_UNAVAILABLE');
        }
        const petPage = browser.contexts()
          .flatMap(context => context.pages())
          .find(page => {
            try {
              return new URL(page.url()).searchParams.get('view') === 'pet';
            } catch {
              return false;
            }
          });
        if (!petPage) throw new Error('ELECTRON_E2E_PROBE_PET_PAGE_UNAVAILABLE');
        const probe = await petPage.evaluate(async () => (
          window.myself.getPetInteractionProbe?.()
        ));
        if (
          !probe
          || typeof probe.passthrough !== 'boolean'
          || typeof probe.dragging !== 'boolean'
          || ![
            probe.mouseMoveHitCount
          ].every(value => Number.isSafeInteger(value) && value >= 0)
          || Object.keys(probe).length !== 3
        ) {
          throw new Error('ELECTRON_E2E_PROBE_RESULT_INVALID');
        }
        return probe;
      },
      async getCharacterBehaviorProbe() {
        if (!browser || !('contexts' in browser) || typeof browser.contexts !== 'function') {
          throw new Error('ELECTRON_E2E_PROBE_BROWSER_UNAVAILABLE');
        }
        const petPage = browser.contexts()
          .flatMap(context => context.pages())
          .find(page => {
            try {
              return new URL(page.url()).searchParams.get('view') === 'pet';
            } catch {
              return false;
            }
          });
        if (!petPage) throw new Error('ELECTRON_E2E_PROBE_PET_PAGE_UNAVAILABLE');
        const probe = await petPage.evaluate(async () => (
          window.myself.getCharacterBehaviorProbe?.()
        ));
        const statuses = new Set([
          null, 'scheduled', 'started', 'completed', 'interrupted', 'failed'
        ]);
        if (
          !probe
          || !Number.isInteger(probe.revision)
          || probe.revision < 0
          || typeof probe.primaryStateId !== 'string'
          || !Array.isArray(probe.modifierStateIds)
          || !probe.modifierStateIds.every(value => typeof value === 'string')
          || (probe.actionId !== null && typeof probe.actionId !== 'string')
          || !statuses.has(probe.playbackStatus)
          || Object.keys(probe).length !== 5
        ) {
          throw new Error('ELECTRON_E2E_BEHAVIOR_PROBE_RESULT_INVALID');
        }
        return probe;
      },
      async getCharacterMotionDeltaProbe() {
        if (!browser || !('contexts' in browser) || typeof browser.contexts !== 'function') {
          throw new Error('ELECTRON_E2E_PROBE_BROWSER_UNAVAILABLE');
        }
        const petPage = browser.contexts()
          .flatMap(context => context.pages())
          .find(page => {
            try {
              return new URL(page.url()).searchParams.get('view') === 'pet';
            } catch {
              return false;
            }
          });
        if (!petPage) throw new Error('ELECTRON_E2E_PROBE_PET_PAGE_UNAVAILABLE');
        const probe = await petPage.evaluate(async () => (
          window.myself.getCharacterMotionDeltaProbe?.()
        ));
        if (
          !probe
          || typeof probe.moved !== 'boolean'
          || !Number.isFinite(probe.horizontal)
          || !Number.isFinite(probe.vertical)
          || Object.keys(probe).length !== 3
        ) {
          throw new Error('ELECTRON_E2E_MOTION_DELTA_PROBE_RESULT_INVALID');
        }
        return probe;
      },
      async getConversationProbe() {
        if (!browser || !('contexts' in browser) || typeof browser.contexts !== 'function') {
          throw new Error('ELECTRON_E2E_PROBE_BROWSER_UNAVAILABLE');
        }
        const chatPage = browser.contexts()
          .flatMap(context => context.pages())
          .find(page => {
            try {
              return new URL(page.url()).searchParams.get('view') === 'chat';
            } catch {
              return false;
            }
          });
        if (!chatPage) throw new Error('ELECTRON_E2E_PROBE_CHAT_PAGE_UNAVAILABLE');
        // 只从可见 DOM 提取去标识化状态，禁止返回消息正文、Provider 或能力标识。
        const probe = await chatPage.evaluate(() => {
          const phaseElement = document.querySelector('.phase-pill');
          const phaseClass = phaseElement
            ? [...phaseElement.classList].find(name => (
                name !== 'phase-pill' && name.startsWith('phase-')
              ))
            : undefined;
          return {
            phase: phaseClass?.slice('phase-'.length) ?? '',
            visibleMessageCount: document.querySelectorAll('.messages article.message').length,
            historyDisclosureVisible: document.querySelector('#history-disclosure-title') !== null,
            fileConfirmationVisible: document.querySelector('#confirmation-title') !== null
          };
        });
        const phases = new Set([
          'idle', 'listening', 'thinking', 'awaiting_confirmation',
          'acting', 'success', 'error', 'cancelled'
        ]);
        if (
          !phases.has(probe.phase)
          || !Number.isSafeInteger(probe.visibleMessageCount)
          || probe.visibleMessageCount < 0
          || typeof probe.historyDisclosureVisible !== 'boolean'
          || typeof probe.fileConfirmationVisible !== 'boolean'
          || Object.keys(probe).length !== 4
        ) {
          throw new Error('ELECTRON_E2E_CONVERSATION_PROBE_RESULT_INVALID');
        }
        return probe as Awaited<ReturnType<ElectronAppFixture['getConversationProbe']>>;
      },
      async markLocalModelReady() {
        if (!localModelFixture) throw new Error('LOCAL_MODEL_E2E_FIXTURE_UNAVAILABLE');
        await writeFile(localModelFixture.readyFile, 'ready\n', 'utf8');
      },
      async getLocalModelFixtureProcessId() {
        if (!localModelFixture) throw new Error('LOCAL_MODEL_E2E_FIXTURE_UNAVAILABLE');
        const processId = Number((await readFile(localModelFixture.pidFile, 'utf8')).trim());
        if (!Number.isSafeInteger(processId) || processId <= 0) {
          throw new Error('LOCAL_MODEL_E2E_PROCESS_PID_INVALID');
        }
        return processId;
      },
      async restart() {
        if (disposeStarted) throw new Error('ELECTRON_FIXTURE_DISPOSED');
        await cleanupCurrentProcess();
        await options.beforeRestart?.(directories);
        // restart 跨越异步清理与钩子后，必须重新确认释放尚未开始。
        if (disposeStarted) throw new Error('ELECTRON_FIXTURE_DISPOSED');
        try {
          await launch();
        } catch (primaryError) {
          try {
            await cleanupCurrentProcess();
          } catch (cleanupError) {
            throw aggregatePrimaryWithCleanup(primaryError, cleanupError);
          }
          throw primaryError;
        }
      },
      dispose
    };
  } catch (primaryError) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw aggregatePrimaryWithCleanup(primaryError, cleanupError);
    }
    throw primaryError;
  }
}
