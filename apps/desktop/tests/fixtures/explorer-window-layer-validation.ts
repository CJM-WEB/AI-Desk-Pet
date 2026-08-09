import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { resolve } from 'node:path';

import { app, BrowserWindow } from 'electron';

import {
  ExplorerWindowLayerController
} from '../../src/main/habitat/explorer-window-layer-controller';
import {
  monitorFixedValidationSignalFailure,
  waitForFixedValidationSignal,
  type FixedValidationSignal,
  type FixedValidationSignalProfile
} from './explorer-window-layer-validation-signal';
import {
  getExplorerLayerSwitchWindowMs,
  advanceSearchHiddenDwell,
  advanceQuickSwitchAutoCompletion,
  classifyHiddenNegativeExplorerSample,
  isSameExplorerValidationTarget,
} from './explorer-window-layer-validation-target';

const MODES = new Set([
  'manual', 'smoke', 'lifecycle', 'negative', 'accuracy-core'
] as const);
const MANUAL_SIGNAL_TIMEOUT_MS = 300_000;

interface ValidationPublicResult {
  status: string;
  matchCount: number;
  switchRound: number;
  errorCode: string;
}

/** 固定读取一行，避免验收协议扩展成通用 PowerShell 控制通道。 */
function nextLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolveLine, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => { cleanup(); reject(new Error('VALIDATION_LINE_TIMEOUT')); }, 2_000);
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      cleanup();
      resolveLine(buffer.slice(0, newline).trim());
    };
    const onEnd = (): void => { cleanup(); reject(new Error('VALIDATION_STREAM_ENDED')); };
    const cleanup = (): void => {
      clearTimeout(timeout);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onEnd);
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onEnd);
  });
}

function nativeHandleToDecimal(handle: Buffer): string {
  let value = 0n;
  for (let index = handle.length - 1; index >= 0; index--) {
    value = (value << 8n) | BigInt(handle[index]!);
  }
  if (value <= 0n) throw new Error('VALIDATION_PET_HWND_INVALID');
  return value.toString(10);
}

async function connectInternalPipe(
  child: ChildProcessWithoutNullStreams,
  token: string
): Promise<NodeJS.ReadWriteStream> {
  if (child.pid === undefined) throw new Error('VALIDATION_PROCESS_START_FAILED');
  const pipePath = `\\\\.\\pipe\\ai-pet-task0e-${child.pid}-${token}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error('VALIDATION_PROCESS_EARLY_EXIT');
    const socket = connect(pipePath);
    const connected = await new Promise<boolean>(resolveConnected => {
      socket.once('connect', () => resolveConnected(true));
      socket.once('error', () => resolveConnected(false));
    });
    if (connected) {
      socket.write(`${token}\n`);
      if (await nextLine(socket) !== 'accepted') {
        socket.destroy();
        throw new Error('VALIDATION_PIPE_AUTH_FAILED');
      }
      return socket;
    }
    socket.destroy();
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('VALIDATION_PIPE_TIMEOUT');
}

async function connectManualSignalPipe(): Promise<Socket> {
  const pipePath = process.env.AI_PET_TASK0E_MANUAL_PIPE;
  const token = process.env.AI_PET_TASK0E_MANUAL_TOKEN;
  if (
    token === undefined || !/^[a-f0-9]{32}$/u.test(token)
    || pipePath === undefined
    || !/^\\\\\.\\pipe\\ai-pet-task0e-manual-[1-9][0-9]*-[a-f0-9]{32}$/u.test(pipePath)
  ) throw new Error('VALIDATION_MANUAL_PIPE_INVALID');
  const socket = connect(pipePath);
  const connected = await new Promise<boolean>(resolveConnected => {
    socket.once('connect', () => resolveConnected(true));
    socket.once('error', () => resolveConnected(false));
  });
  if (!connected) throw new Error('VALIDATION_MANUAL_PIPE_UNAVAILABLE');
  socket.write(`${token}\n`);
  if (await nextLine(socket) !== 'accepted') throw new Error('VALIDATION_MANUAL_PIPE_AUTH_FAILED');
  return socket;
}

async function stopValidationChild(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) return;
  child.stdin.end('quit\n');
  const exited = await Promise.race([
    new Promise<boolean>(resolveExit => child.once('exit', () => resolveExit(true))),
    new Promise<boolean>(resolveWait => setTimeout(() => resolveWait(false), 2_000))
  ]);
  if (!exited && child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise<void>(resolveExit => child.once('exit', () => resolveExit())),
      new Promise<void>(resolveWait => setTimeout(resolveWait, 2_000))
    ]);
  }
  if (child.exitCode === null) throw new Error('VALIDATION_PROCESS_EXIT_TIMEOUT');
}

/** 公开状态与内部句柄分流；句柄不会打印、落盘或来自命令行。 */
async function observe(
  child: ChildProcessWithoutNullStreams,
  internalPipe: NodeJS.ReadWriteStream
): Promise<{
  publicResult: ValidationPublicResult;
  outerHwnd: string;
  instanceId: string;
  pathFingerprint: string;
}> {
  child.stdin.write('observe\n');
  const [publicLine, internalLine] = await Promise.all([
    nextLine(child.stdout),
    nextLine(internalPipe)
  ]);
  const publicResult = JSON.parse(publicLine) as ValidationPublicResult;
  const internal = JSON.parse(internalLine) as {
    outerHwnd: string;
    instanceId: string;
    pathFingerprint: string;
  };
  return { publicResult, ...internal };
}

/** 固定只读探针仅返回布尔证据，不返回任何原生句柄。 */
async function probeLayer(petHwnd: string, explorerHwnd: string): Promise<{
  petImmediatelyAboveExplorer: boolean;
  foregroundStillExplorer: boolean;
  petIsForeground: boolean;
  petWsExTopmost: boolean;
  petVisible: boolean;
}> {
  const probe = String.raw`
$value=[Console]::In.ReadLine() | ConvertFrom-Json -ErrorAction Stop
if ($value.token -cne [Environment]::GetEnvironmentVariable('AI_PET_TASK0E_PROBE_TOKEN','Process')) { throw 'VALIDATION_PROBE_AUTH_FAILED' }
$source=@'
using System;
using System.Runtime.InteropServices;
public static class Task0ELayerProbe {
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint command);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr64(IntPtr h, int index);
 [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong32(IntPtr h, int index);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 public static long ExStyle(IntPtr h) { return IntPtr.Size == 8 ? GetWindowLongPtr64(h,-20).ToInt64() : GetWindowLong32(h,-20); }
}
'@
Add-Type -TypeDefinition $source
$pet=[IntPtr]::new([Int64]::Parse([string]$value.pet)); $explorer=[IntPtr]::new([Int64]::Parse([string]$value.explorer))
$foreground=[Task0ELayerProbe]::GetForegroundWindow()
[ordered]@{
 petImmediatelyAboveExplorer=([Task0ELayerProbe]::GetWindow($pet,2) -eq $explorer)
 foregroundStillExplorer=($foreground -eq $explorer)
 petIsForeground=($foreground -eq $pet)
 petWsExTopmost=(([Task0ELayerProbe]::ExStyle($pet) -band 8) -ne 0)
 petVisible=[Task0ELayerProbe]::IsWindowVisible($pet)
} | ConvertTo-Json -Compress`;
  const powershell = resolve(process.env.WINDIR!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const token = randomBytes(16).toString('hex');
  const child = spawn(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', probe
  ], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, AI_PET_TASK0E_PROBE_TOKEN: token }
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdin.end(`${JSON.stringify({ token, pet: petHwnd, explorer: explorerHwnd })}\n`);
  const exited = await Promise.race([
    new Promise<boolean>(resolveExit => child.once('exit', () => resolveExit(true))),
    new Promise<boolean>(resolveWait => setTimeout(() => resolveWait(false), 2_000))
  ]);
  if (!exited) {
    child.kill();
    await Promise.race([
      new Promise<void>(resolveExit => child.once('exit', () => resolveExit())),
      new Promise<void>(resolveWait => setTimeout(resolveWait, 2_000))
    ]);
    if (child.exitCode === null) throw new Error('VALIDATION_PROBE_EXIT_TIMEOUT');
    throw new Error('VALIDATION_PROBE_TIMEOUT');
  }
  if (child.exitCode !== 0 || stderr.trim() !== '') throw new Error('VALIDATION_PROBE_FAILED');
  return JSON.parse(stdout.trim());
}

/** 两条层级路线共用同一个无桌宠数据、非 topmost、不可聚焦的测试窗口。 */
async function createValidationWindow(): Promise<BrowserWindow> {
  const validationWindow = new BrowserWindow({
    width: 160,
    height: 160,
    show: false,
    frame: false,
    transparent: true,
    focusable: false,
    alwaysOnTop: false,
    skipTaskbar: true
  });
  validationWindow.setBackgroundColor('#00000000');
  await validationWindow.loadURL(
    'data:text/html;charset=utf-8,' + encodeURIComponent(
      '<!doctype html><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}' +
      'body{background:rgba(32,220,180,.92);border:4px solid white;box-sizing:border-box;' +
      'border-radius:24px;box-shadow:inset 0 0 0 2px #123}</style>'
    )
  );
  return validationWindow;
}

async function run(): Promise<void> {
  const route = process.argv[2];
  const mode = process.argv[3] as
    'manual' | 'smoke' | 'lifecycle' | 'negative' | 'accuracy-core' | undefined;
  if (route !== 'electron') throw new Error('VALIDATION_ROUTE_INVALID');
  if (mode === undefined || !MODES.has(mode)) throw new Error('VALIDATION_MODE_INVALID');
  const desktopRoot = /[\\/]apps[\\/]desktop$/u.test(process.cwd())
    ? process.cwd()
    : resolve(process.cwd(), 'apps/desktop');
  const fixturePath = resolve(
    desktopRoot, 'tests/fixtures/explorer-shell-tab-validation.ps1'
  );
  const powershell = resolve(process.env.WINDIR!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  let validation: ChildProcessWithoutNullStreams | undefined;
  let internalPipe: NodeJS.ReadWriteStream | undefined;
  let manualSignalInput: Socket | undefined;
  let manualFailure: Promise<never> | undefined;
  let window: BrowserWindow | undefined;
  let controller: ExplorerWindowLayerController | undefined;
  try {
    const signalProfile: FixedValidationSignalProfile = mode === 'lifecycle'
      ? 'lifecycle'
      : mode === 'negative'
        ? 'negative'
        : mode === 'accuracy-core' ? 'accuracy-core' : 'layer';
    if (mode !== 'smoke') {
      manualSignalInput = await connectManualSignalPipe();
      manualFailure = monitorFixedValidationSignalFailure(manualSignalInput, signalProfile);
    }
    const guardManual = <T>(operation: Promise<T>): Promise<T> =>
      manualFailure === undefined ? operation : Promise.race([operation, manualFailure]);
    const pipeToken = randomBytes(16).toString('hex');
    validation = spawn(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixturePath
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, AI_PET_TASK0E_PIPE_TOKEN: pipeToken }
    });
    if (validation.pid === undefined) throw new Error('VALIDATION_PROCESS_START_FAILED');
    validation.stderr.resume();
    internalPipe = await connectInternalPipe(validation, pipeToken);

    const candidateStep = async (
        phase: string,
        action: string,
        signal: FixedValidationSignal
      ): Promise<Awaited<ReturnType<typeof observe>>> => {
        process.stdout.write(`${JSON.stringify({
          type: 'instruction', action, signal, timeoutMs: MANUAL_SIGNAL_TIMEOUT_MS
        })}\n`);
        await guardManual(waitForFixedValidationSignal(
          manualSignalInput!, signal, MANUAL_SIGNAL_TIMEOUT_MS, signalProfile
        ));
        const sampled = await guardManual(observe(validation!, internalPipe!));
        process.stdout.write(`${JSON.stringify({
          type: 'candidate', phase, ...sampled.publicResult
        })}\n`);
        return sampled;
    };

    if (mode === 'lifecycle') {
      const single = await candidateStep(
        'single', 'focus-only-explorer-single-tab', 'observe-single'
      );
      const minimized = await candidateStep(
        'minimized', 'minimize-only-explorer-window', 'observe-minimized'
      );
      const restored = await candidateStep(
        'restored', 'restore-same-explorer-window', 'observe-restored'
      );
      const closed = await candidateStep(
        'closed', 'close-only-explorer-window', 'observe-closed'
      );
      if (
        single.publicResult.status !== 'ready' || single.publicResult.matchCount !== 1
        || single.publicResult.switchRound !== 1 || single.outerHwnd === '0'
        || minimized.publicResult.status !== 'none' || minimized.publicResult.matchCount !== 0
        || minimized.publicResult.switchRound !== 1 || minimized.outerHwnd !== '0'
        || restored.publicResult.status !== 'ready' || restored.publicResult.matchCount !== 1
        || restored.publicResult.switchRound !== 1 || restored.outerHwnd !== single.outerHwnd
        || closed.publicResult.status !== 'none' || closed.publicResult.matchCount !== 0
        || closed.publicResult.switchRound !== 1 || closed.outerHwnd !== '0'
      ) throw new Error('VALIDATION_LIFECYCLE_MATRIX_NOT_PROVEN');
      return;
    }

    if (mode === 'accuracy-core') {
      const a = await candidateStep(
        'accuracy-core', 'focus-three-tabs-a-same-directory', 'observe-three-a'
      );
      const bSame = await candidateStep(
        'accuracy-core', 'focus-three-tabs-b-same-directory', 'observe-same-dir-b'
      );
      const c = await candidateStep(
        'accuracy-core', 'focus-three-tabs-c-different-directory', 'observe-three-c'
      );
      const aReturn = await candidateStep(
        'accuracy-core', 'return-three-tabs-a', 'observe-three-a-return'
      );
      const tabs = [a, bSame, c, aReturn];
      if (tabs.some((sample, index) =>
        sample.publicResult.status !== 'ready' || sample.publicResult.matchCount !== 1
        || sample.publicResult.switchRound !== index + 1 || sample.outerHwnd !== a.outerHwnd
        || sample.instanceId === '' || sample.pathFingerprint === ''
      ) || a.instanceId === bSame.instanceId || bSame.instanceId === c.instanceId
        || a.instanceId !== aReturn.instanceId
        || a.pathFingerprint !== bSame.pathFingerprint
        || a.pathFingerprint === c.pathFingerprint
      ) throw new Error('VALIDATION_ACCURACY_CORE_NOT_PROVEN');

      const windowA = await candidateStep(
        'accuracy-core', 'focus-first-explorer-window', 'observe-window-a'
      );
      const windowB = await candidateStep(
        'accuracy-core', 'focus-second-explorer-window', 'observe-window-b'
      );
      const windowAReturn = await candidateStep(
        'accuracy-core', 'return-first-explorer-window', 'observe-window-a-return'
      );
      if (
        windowA.publicResult.status !== 'ready' || windowA.publicResult.matchCount !== 1
        || windowA.publicResult.switchRound !== 4 || windowA.outerHwnd !== a.outerHwnd
        || windowA.instanceId !== a.instanceId
        || windowA.pathFingerprint !== a.pathFingerprint
        || windowB.publicResult.status !== 'ready' || windowB.publicResult.matchCount !== 1
        || windowB.publicResult.switchRound !== 5 || windowB.outerHwnd === windowA.outerHwnd
        || windowAReturn.publicResult.status !== 'ready'
        || windowAReturn.publicResult.matchCount !== 1
        || windowAReturn.publicResult.switchRound !== 6
        || windowAReturn.outerHwnd !== windowA.outerHwnd
        || windowAReturn.instanceId !== a.instanceId
        || windowAReturn.pathFingerprint !== a.pathFingerprint
      ) throw new Error('VALIDATION_ACCURACY_CORE_NOT_PROVEN');

      process.stdout.write(`${JSON.stringify({
        type: 'instruction', action: 'rapid-switch-known-tabs-on-first-window',
        timeoutMs: MANUAL_SIGNAL_TIMEOUT_MS
      })}\n`);
      const knownInstances = new Map([
        [a.instanceId, a.pathFingerprint],
        [bSame.instanceId, bSame.pathFingerprint],
        [c.instanceId, c.pathFingerprint]
      ]);
      const rapidTarget = { outerHwnd: windowA.outerHwnd, switchRound: 6 };
      let rapidState: ReturnType<typeof advanceQuickSwitchAutoCompletion> | undefined;
      let lastRapidPublicKey: string | undefined;
      const rapidDeadline = performance.now() + MANUAL_SIGNAL_TIMEOUT_MS;
      while (rapidState?.completed !== true) {
        if (performance.now() >= rapidDeadline) {
          throw new Error('VALIDATION_ACCURACY_RAPID_TIMEOUT');
        }
        const sampled = await guardManual(observe(validation, internalPipe));
        rapidState = advanceQuickSwitchAutoCompletion(
          rapidState,
          { ...sampled.publicResult, ...sampled },
          rapidTarget,
          knownInstances,
          { instanceId: a.instanceId, pathFingerprint: a.pathFingerprint },
          performance.now()
        );
        const key = [
          sampled.publicResult.status, sampled.publicResult.matchCount,
          sampled.publicResult.switchRound, sampled.publicResult.errorCode
        ].join(':');
        if (key !== lastRapidPublicKey) {
          lastRapidPublicKey = key;
          process.stdout.write(`${JSON.stringify({
            type: 'candidate', phase: 'accuracy-core', ...sampled.publicResult
          })}\n`);
        }
        if (rapidState.failed) throw new Error('VALIDATION_ACCURACY_CORE_NOT_PROVEN');
        if (!rapidState.completed) {
          await guardManual(new Promise<void>(resolveWait => setTimeout(resolveWait, 75)));
        }
      }
      process.stdout.write(`${JSON.stringify({
        type: 'accuracy-summary', phase: 'accuracy-core',
        sampleCount: rapidState.sampleCount,
        ambiguousCount: rapidState.ambiguousCount,
        roundAdvanced: rapidState.lastRound > 6,
        stableACount: rapidState.stableACount,
        finalReady: true
      })}\n`);
      return;
    }

    if (mode === 'negative') {
      if (route !== 'electron') throw new Error('VALIDATION_NEGATIVE_ROUTE_INVALID');
      const baseline = await candidateStep(
        'negative-baseline',
        'focus-single-explorer-filesystem',
        'observe-negative-baseline'
      );
      if (
        baseline.publicResult.status !== 'ready' || baseline.publicResult.matchCount !== 1
        || baseline.publicResult.switchRound !== 1 || baseline.outerHwnd === '0'
      ) throw new Error('VALIDATION_NEGATIVE_BASELINE_NOT_PROVEN');
      const target = {
        outerHwnd: baseline.outerHwnd,
        switchRound: baseline.publicResult.switchRound
      };
      window = await guardManual(createValidationWindow());
      const petHwnd = nativeHandleToDecimal(window.getNativeWindowHandle());
      controller = new ExplorerWindowLayerController({ window });

      const placeBaselineLayer = async (): Promise<void> => {
        window!.showInactive();
        await guardManual(controller!.activate({ explorerHwnd: target.outerHwnd }));
        const placed = await guardManual(probeLayer(petHwnd, target.outerHwnd));
        process.stdout.write(`${JSON.stringify({
          type: 'layer', phase: 'negative-baseline', route, ...placed
        })}\n`);
        if (
          !placed.petImmediatelyAboveExplorer || !placed.foregroundStillExplorer
          || placed.petIsForeground || placed.petWsExTopmost || !placed.petVisible
        ) throw new Error('VALIDATION_NEGATIVE_LAYER_NOT_PROVEN');
      };

      const waitForNegativeEvidence = async (
        scenario: 'search' | 'virtual',
        action: string
      ): Promise<void> => {
        process.stdout.write(`${JSON.stringify({
          type: 'instruction', action, timeoutMs: MANUAL_SIGNAL_TIMEOUT_MS
        })}\n`);
        const deadline = performance.now() + MANUAL_SIGNAL_TIMEOUT_MS;
        let lastReadyCompletedAt = performance.now();
        let lastPublishedSampleKey: string | undefined;
        let sampleCount = 0;
        const publishSample = (
          phase: 'negative-sample' | 'negative-hidden-sample',
          sampled: Awaited<ReturnType<typeof observe>>
        ): void => {
          sampleCount++;
          const key = [
            sampled.publicResult.status,
            sampled.publicResult.matchCount,
            sampled.publicResult.switchRound,
            sampled.publicResult.errorCode
          ].join(':');
          if (key === lastPublishedSampleKey) return;
          lastPublishedSampleKey = key;
          process.stdout.write(`${JSON.stringify({
            type: 'candidate', phase, scenario, ...sampled.publicResult
          })}\n`);
        };
        const publishSummary = (
          terminal: 'strict-none' | 'stable-hidden-ambiguous',
          dwellMs: number,
          probeCount: number
        ): void => {
          process.stdout.write(`${JSON.stringify({
            type: 'negative-summary', scenario, terminal, sampleCount, dwellMs, probeCount
          })}\n`);
        };
        while (performance.now() < deadline) {
          const sampled = await guardManual(observe(validation!, internalPipe!));
          const sampledAt = performance.now();
          publishSample('negative-sample', sampled);
          if (isSameExplorerValidationTarget(
            { ...sampled.publicResult, outerHwnd: sampled.outerHwnd }, target
          )) {
            lastReadyCompletedAt = sampledAt;
            await guardManual(new Promise(resolveWait => setTimeout(resolveWait, 75)));
            continue;
          }

          window!.hide();
          const hidden = await guardManual(probeLayer(petHwnd, target.outerHwnd));
          const exposureUpperBoundMs = performance.now() - lastReadyCompletedAt;
          const hiddenDecision = classifyHiddenNegativeExplorerSample(
            { ...sampled.publicResult, outerHwnd: sampled.outerHwnd },
            hidden.foregroundStillExplorer,
            target
          );
          process.stdout.write(`${JSON.stringify({
            type: 'negative-hide', scenario,
            status: sampled.publicResult.status,
            matchCount: sampled.publicResult.matchCount,
            switchRound: sampled.publicResult.switchRound,
            errorCode: sampled.publicResult.errorCode,
            foregroundStillExplorer: hidden.foregroundStillExplorer,
            exposureUpperBoundMs,
            controllerHiddenWithin1000: exposureUpperBoundMs <= 1_000 && !hidden.petVisible,
            petWsExTopmost: hidden.petWsExTopmost,
            petIsForeground: hidden.petIsForeground
          })}\n`);
          if (
            hidden.petVisible || hidden.petWsExTopmost || hidden.petIsForeground
            || exposureUpperBoundMs > 1_000 || hiddenDecision === 'fail'
          ) throw new Error('VALIDATION_NEGATIVE_MATRIX_NOT_PROVEN');
          if (hiddenDecision === 'pass') {
            publishSummary('strict-none', 0, 1);
            return;
          }

          let searchDwellStartedAt: number | undefined;
          let searchProbeCount = 0;
          if (scenario === 'search') {
            const dwell = advanceSearchHiddenDwell(
              undefined,
              0,
              { ...sampled.publicResult, outerHwnd: sampled.outerHwnd },
              target,
              sampledAt,
              hidden.foregroundStillExplorer && !hidden.petVisible
                && !hidden.petWsExTopmost && !hidden.petIsForeground
            );
            if (dwell.decision === 'fail') {
              throw new Error('VALIDATION_NEGATIVE_MATRIX_NOT_PROVEN');
            }
            searchDwellStartedAt = dwell.startedAt;
            searchProbeCount = dwell.probeCount;
          }

          // 搜索框输入会产生短暂 ambiguous；窗口保持隐藏，只等待稳定负向 none。
          while (performance.now() < deadline) {
            await guardManual(new Promise(resolveWait => setTimeout(resolveWait, 75)));
            const hiddenSample = await guardManual(observe(validation!, internalPipe!));
            const hiddenSampledAt = performance.now();
            publishSample('negative-hidden-sample', hiddenSample);
            if (
              window!.isVisible() || window!.isAlwaysOnTop() || window!.isFocused()
            ) throw new Error('VALIDATION_NEGATIVE_MATRIX_NOT_PROVEN');
            let foregroundStillExplorer = true;
            let freshProbeSafe = false;
            if (
              hiddenSample.publicResult.status === 'none'
              || (scenario === 'search' && (
                hiddenSample.publicResult.status === 'ambiguous'
                || hiddenSample.publicResult.status === 'unavailable'
              ))
            ) {
              const freshProbe = await guardManual(probeLayer(petHwnd, target.outerHwnd));
              foregroundStillExplorer = freshProbe.foregroundStillExplorer;
              freshProbeSafe = foregroundStillExplorer && !freshProbe.petVisible
                && !freshProbe.petWsExTopmost && !freshProbe.petIsForeground;
              if (
                !freshProbeSafe
              ) throw new Error('VALIDATION_NEGATIVE_MATRIX_NOT_PROVEN');
            }
            const decision = classifyHiddenNegativeExplorerSample(
              { ...hiddenSample.publicResult, outerHwnd: hiddenSample.outerHwnd },
              foregroundStillExplorer,
              target
            );
            if (decision === 'pass') {
              publishSummary(
                'strict-none', 0, scenario === 'search' ? searchProbeCount + 1 : 1
              );
              return;
            }
            if (decision === 'fail') throw new Error('VALIDATION_NEGATIVE_MATRIX_NOT_PROVEN');
            if (scenario === 'search') {
              const dwell = advanceSearchHiddenDwell(
                searchDwellStartedAt,
                searchProbeCount,
                { ...hiddenSample.publicResult, outerHwnd: hiddenSample.outerHwnd },
                target,
                hiddenSampledAt,
                freshProbeSafe
              );
              if (dwell.decision === 'fail') {
                throw new Error('VALIDATION_NEGATIVE_MATRIX_NOT_PROVEN');
              }
              searchDwellStartedAt = dwell.startedAt;
              searchProbeCount = dwell.probeCount;
              if (dwell.decision === 'probe-stable') {
                publishSummary(
                  'stable-hidden-ambiguous',
                  hiddenSampledAt - (searchDwellStartedAt ?? hiddenSampledAt),
                  searchProbeCount
                );
                return;
              }
            }
          }
          throw new Error('VALIDATION_NEGATIVE_MATRIX_TIMEOUT');
        }
        throw new Error('VALIDATION_NEGATIVE_MATRIX_TIMEOUT');
      };

      await placeBaselineLayer();
      await waitForNegativeEvidence('search', 'navigate-manually-to-search-results');
      const restored = await candidateStep(
        'negative-restored',
        'restore-same-explorer-filesystem',
        'observe-negative-restore'
      );
      if (!isSameExplorerValidationTarget(
        { ...restored.publicResult, outerHwnd: restored.outerHwnd }, target
      )) throw new Error('VALIDATION_NEGATIVE_RESTORE_NOT_PROVEN');
      await placeBaselineLayer();
      await waitForNegativeEvidence('virtual', 'navigate-manually-to-apps-folder');
      return;
    }

    if (mode === 'manual') {
      process.stdout.write(`${JSON.stringify({
        type: 'instruction', action: 'focus-explorer-tab-a', signal: 'observe-a',
        timeoutMs: MANUAL_SIGNAL_TIMEOUT_MS
      })}\n`);
      await guardManual(waitForFixedValidationSignal(
        manualSignalInput!, 'observe-a', MANUAL_SIGNAL_TIMEOUT_MS
      ));
    }
    const first = await guardManual(observe(validation, internalPipe));
    process.stdout.write(`${JSON.stringify({ type: 'candidate', ...first.publicResult })}\n`);
    if (
      first.publicResult.status !== 'ready' || first.publicResult.matchCount !== 1
      || first.publicResult.switchRound !== 1 || first.outerHwnd === '0'
    ) throw new Error('VALIDATION_EXPLORER_NOT_READY');
    if (mode === 'smoke') throw new Error('VALIDATION_SMOKE_EXPECTED_NON_EXPLORER');
    process.stdout.write(`${JSON.stringify({
      type: 'instruction', action: 'switch-to-explorer-tab-b', signal: 'observe-b',
      timeoutMs: MANUAL_SIGNAL_TIMEOUT_MS
    })}\n`);
    await guardManual(waitForFixedValidationSignal(
      manualSignalInput!, 'observe-b', MANUAL_SIGNAL_TIMEOUT_MS
    ));
    const second = await guardManual(observe(validation, internalPipe));
    process.stdout.write(`${JSON.stringify({ type: 'candidate', ...second.publicResult })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'instruction', action: 'switch-back-to-explorer-tab-a', signal: 'observe-a-return',
      timeoutMs: MANUAL_SIGNAL_TIMEOUT_MS
    })}\n`);
    await guardManual(waitForFixedValidationSignal(
      manualSignalInput!, 'observe-a-return', MANUAL_SIGNAL_TIMEOUT_MS
    ));
    const third = await guardManual(observe(validation, internalPipe));
    process.stdout.write(`${JSON.stringify({ type: 'candidate', ...third.publicResult })}\n`);
    const observations = [first, second, third];
    if (observations.some((entry, index) =>
      entry.publicResult.status !== 'ready'
      || entry.publicResult.matchCount !== 1
      || entry.publicResult.switchRound !== index + 1
      || entry.outerHwnd === '0'
      || entry.outerHwnd !== first.outerHwnd
    )) throw new Error('VALIDATION_A_B_A_NOT_PROVEN');

    window = await guardManual(createValidationWindow());
    const petHwnd = nativeHandleToDecimal(window.getNativeWindowHandle());
    // 生产桥接启动后先在测试窗口仍隐藏时重新建立 ready 基线；不确定状态绝不当作 none。
    const prePlacementDeadline = performance.now() + 1_000;
    let prePlacement: Awaited<ReturnType<typeof observe>> | undefined;
    const validationTarget = {
      outerHwnd: third.outerHwnd,
      switchRound: third.publicResult.switchRound
    };
    do {
      const sampled = await guardManual(observe(validation, internalPipe));
      process.stdout.write(`${JSON.stringify({
        type: 'foreground-sample', phase: 'pre-placement', ...sampled.publicResult
      })}\n`);
      if (isSameExplorerValidationTarget(
        { ...sampled.publicResult, outerHwnd: sampled.outerHwnd }, validationTarget
      )) {
        prePlacement = sampled;
        break;
      }
      if (sampled.publicResult.status === 'none') {
        throw new Error('VALIDATION_EXPLORER_LEFT_BEFORE_PLACEMENT');
      }
      await guardManual(new Promise(resolveWait => setTimeout(resolveWait, 75)));
    } while (performance.now() < prePlacementDeadline);
    if (prePlacement === undefined) throw new Error('VALIDATION_PREPLACEMENT_SAMPLE_UNSAFE');
    let lastReadyCompletedAt = performance.now();

    window.showInactive();
    controller = new ExplorerWindowLayerController({ window });
    await guardManual(controller.activate({ explorerHwnd: third.outerHwnd }));
    const placed = await guardManual(probeLayer(petHwnd, third.outerHwnd));
    process.stdout.write(`${JSON.stringify({ type: 'layer', route, ...placed })}\n`);
    if (
      !placed.petImmediatelyAboveExplorer || !placed.foregroundStillExplorer
      || placed.petIsForeground || placed.petWsExTopmost || !placed.petVisible
    ) throw new Error('VALIDATION_LAYER_EVIDENCE_FAILED');

    const switchWindowMs = getExplorerLayerSwitchWindowMs(mode);
    process.stdout.write(`${JSON.stringify({
      type: 'instruction', action: 'switch-to-normal-app', timeoutMs: switchWindowMs
    })}\n`);
    const switchDeadline = performance.now() + switchWindowMs;
    let blurred: Awaited<ReturnType<typeof observe>> | undefined;
    let firstForegroundPoll = true;
    while (performance.now() < switchDeadline) {
      const pollStartedAt = performance.now();
      if (!firstForegroundPoll && pollStartedAt - lastReadyCompletedAt > 100) {
        throw new Error('VALIDATION_FOREGROUND_POLL_INTERVAL_EXCEEDED');
      }
      const sampled = await guardManual(observe(validation, internalPipe));
      const sampledAt = performance.now();
      process.stdout.write(`${JSON.stringify({
        type: 'foreground-sample', phase: 'switch-window', ...sampled.publicResult
      })}\n`);
      if (sampled.publicResult.status === 'none') {
        blurred = sampled;
        break;
      }
      if (!isSameExplorerValidationTarget(
        { ...sampled.publicResult, outerHwnd: sampled.outerHwnd }, validationTarget
      )) {
        // 任意不确定状态由验收窗口自身隐藏；之后仅等待真实 none，验收仍失败关闭。
        window.hide();
        const unsafeHidden = await guardManual(probeLayer(petHwnd, third.outerHwnd));
        const unsafeExposureUpperBoundMs = performance.now() - lastReadyCompletedAt;
        process.stdout.write(`${JSON.stringify({
          type: 'hide', route, manualSwitchObserved: false,
          unsafeStatus: sampled.publicResult.status,
          unsafeMatchCount: sampled.publicResult.matchCount,
          unsafeErrorCode: sampled.publicResult.errorCode,
          unsafeExposureUpperBoundMs,
          controllerHiddenWithin1000:
            unsafeExposureUpperBoundMs <= 1_000 && !unsafeHidden.petVisible,
          petWsExTopmost: unsafeHidden.petWsExTopmost,
          petIsForeground: unsafeHidden.petIsForeground
        })}\n`);
        if (
          unsafeHidden.petVisible || unsafeHidden.petWsExTopmost || unsafeHidden.petIsForeground
          || unsafeExposureUpperBoundMs > 1_000
        ) throw new Error('VALIDATION_FOREGROUND_UNSAFE_HIDE_FAILED');
        while (performance.now() < switchDeadline) {
          await guardManual(new Promise(resolveWait => setTimeout(resolveWait, 75)));
          const afterHide = await guardManual(observe(validation, internalPipe));
          process.stdout.write(`${JSON.stringify({
            type: 'foreground-sample', phase: 'after-unsafe-hide', ...afterHide.publicResult
          })}\n`);
          if (afterHide.publicResult.status === 'none') break;
        }
        throw new Error('VALIDATION_FOREGROUND_SAMPLE_UNSAFE');
      }
      lastReadyCompletedAt = sampledAt;
      firstForegroundPoll = false;
      await guardManual(new Promise(resolveWait => setTimeout(resolveWait, 75)));
    }
    if (blurred === undefined) throw new Error('VALIDATION_NORMAL_APP_SWITCH_NOT_OBSERVED');
    window.hide();
    const hidden = await guardManual(probeLayer(petHwnd, third.outerHwnd));
    const conservativeExposureUpperBoundMs = performance.now() - lastReadyCompletedAt;
    process.stdout.write(`${JSON.stringify({
      type: 'hide',
      route,
      manualSwitchObserved: true,
      conservativeExposureUpperBoundMs,
      controllerHiddenWithin1000: conservativeExposureUpperBoundMs <= 1_000 && !hidden.petVisible,
      petWsExTopmost: hidden.petWsExTopmost,
      petIsForeground: hidden.petIsForeground
    })}\n`);
    if (
      blurred.publicResult.status !== 'none' || hidden.petVisible || hidden.petWsExTopmost
      || hidden.petIsForeground || conservativeExposureUpperBoundMs > 1_000
    ) throw new Error('VALIDATION_HIDE_EVIDENCE_FAILED');
  } finally {
    await controller?.dispose().catch(() => undefined);
    manualSignalInput?.destroy();
    internalPipe?.end();
    await stopValidationChild(validation);
    if (window !== undefined && !window.isDestroyed()) window.destroy();
  }
}

void app.whenReady().then(async () => {
  try {
    await run();
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'VALIDATION_FAILED'}\n`);
    app.exit(1);
  }
});
