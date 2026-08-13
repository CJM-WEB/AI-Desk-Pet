import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getFixedValidationSignalSequence,
  monitorFixedValidationSignalFailure,
  waitForFixedValidationSignal
} from './fixtures/explorer-window-layer-validation-signal';
import {
  getExplorerLayerSwitchWindowMs,
  classifyHiddenNegativeExplorerSample,
  advanceSearchHiddenDwell,
  advanceQuickSwitchEvidence,
  advanceQuickSwitchAutoCompletion,
  isStrictNegativeExplorerEvidence,
  isSameExplorerValidationTarget,
} from './fixtures/explorer-window-layer-validation-target';
import {
  ExplorerSpaceClient,
  buildExplorerBridgeSpawnSpec
} from '../src/main/explorer/explorer-space-client';

const fixtureDirectory = resolve(import.meta.dirname, 'fixtures');
const shellFixture = resolve(fixtureDirectory, 'explorer-shell-tab-validation.ps1');
const layerFixture = resolve(fixtureDirectory, 'explorer-window-layer-validation.ts');

async function connectFixturePipe(pid: number, token: string): Promise<ReturnType<typeof connect>> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const socket = connect(`\\\\.\\pipe\\ai-pet-task0e-${pid}-${token}`);
    const connected = await new Promise<boolean>(resolveConnected => {
      socket.once('connect', () => resolveConnected(true));
      socket.once('error', () => resolveConnected(false));
    });
    if (connected) {
      socket.write(`${token}\n`);
      const lines = createInterface({ input: socket });
      const accepted = await new Promise<string>(resolveLine => lines.once('line', resolveLine));
      lines.close();
      if (accepted !== 'accepted') throw new Error('VALIDATION_PIPE_AUTH_FAILED');
      return socket;
    }
    socket.destroy();
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('VALIDATION_PIPE_TIMEOUT');
}

describe('Task 0E 固定实机验收夹具', () => {
  it('真实生产桥接完成 hello、快照、停止观察与关闭，不产生原始 stderr', async () => {
    const client = new ExplorerSpaceClient({
      spawnSpec: buildExplorerBridgeSpawnSpec({
        windowsDirectory: process.env.WINDIR!,
        resourceRoot: resolve(import.meta.dirname, '../resources'),
        tempDirectory: process.env.TEMP!
      }),
      helloTimeoutMs: 5_000,
      observationTimeoutMs: 1_500,
      closeTimeoutMs: 5_000
    });

    const snapshot = new Promise<unknown>((resolveSnapshot, reject) => {
      const timeout = setTimeout(() => reject(new Error('REAL_BRIDGE_SNAPSHOT_TIMEOUT')), 5_000);
      client.once('snapshot', value => {
        clearTimeout(timeout);
        resolveSnapshot(value);
      });
    });
    await client.start();
    expect(client.snapshot()).toEqual({ state: 'ready' });
    await client.startObserving();
    await expect(snapshot).resolves.toMatchObject({ status: expect.any(String) });
    // 稳定快照会去重；等待超过观察超时，验证真实桥接由独立心跳续期。
    await new Promise(resolveWait => setTimeout(resolveWait, 2_500));
    expect(client.snapshot()).toEqual({ state: 'ready' });
    await client.stopObserving();
    await client.close();
    expect(client.snapshot()).toEqual({ state: 'closed' });
  }, 15_000);

  it('manual 模式在收到固定 stdin 信号前绝不开始采样', async () => {
    const input = new PassThrough();
    let released = false;
    const waiting = waitForFixedValidationSignal(input, 'observe-a', 1_000)
      .then(() => { released = true; });

    await new Promise(resolveWait => setTimeout(resolveWait, 50));
    expect(released).toBe(false);
    input.write('observe-a\n');
    await waiting;
    expect(released).toBe(true);
  });

  it('manual 模式拒绝任何非当前阶段固定信号', async () => {
    const input = new PassThrough();
    const waiting = waitForFixedValidationSignal(input, 'observe-b', 1_000);
    input.write('observe-a\n');
    await expect(waiting).rejects.toThrow('VALIDATION_MANUAL_SIGNAL_INVALID');
  });

  it('manual 模式保留同一 chunk 中属于下一阶段的固定信号', async () => {
    const input = new PassThrough();
    const first = waitForFixedValidationSignal(input, 'observe-a', 1_000);
    input.write('observe-a\nobserve-b\n');

    await first;
    await expect(waitForFixedValidationSignal(input, 'observe-b', 1_000)).resolves.toBeUndefined();
  });

  it('manual 模式不静默丢弃同一 chunk 中的尾随未知行', async () => {
    const input = new PassThrough();
    const first = waitForFixedValidationSignal(input, 'observe-a', 1_000);
    input.write('observe-a\nunknown\n');

    await first;
    await expect(waitForFixedValidationSignal(input, 'observe-b', 1_000))
      .rejects.toThrow('VALIDATION_MANUAL_SIGNAL_INVALID');
  });

  it('manual 完整序列同一 chunk 中出现第四行时产生运行可见错误', async () => {
    const input = new PassThrough();
    const failure = monitorFixedValidationSignalFailure(input);
    input.write('observe-a\nobserve-b\nobserve-a-return\nunknown\n');

    await expect(Promise.race([
      failure,
      new Promise((_, reject) => setTimeout(() => reject(new Error('FAILURE_NOT_OBSERVED')), 100))
    ])).rejects.toThrow('VALIDATION_MANUAL_SIGNAL_INVALID');
  });

  it('manual 第三步成功后异步到达第四行仍产生运行可见错误', async () => {
    const input = new PassThrough();
    const failure = monitorFixedValidationSignalFailure(input);
    input.write('observe-a\nobserve-b\nobserve-a-return\n');
    await waitForFixedValidationSignal(input, 'observe-a', 1_000);
    await waitForFixedValidationSignal(input, 'observe-b', 1_000);
    await waitForFixedValidationSignal(input, 'observe-a-return', 1_000);
    setTimeout(() => input.write('unknown\n'), 10);

    await expect(Promise.race([
      failure,
      new Promise((_, reject) => setTimeout(() => reject(new Error('FAILURE_NOT_OBSERVED')), 100))
    ])).rejects.toThrow('VALIDATION_MANUAL_SIGNAL_INVALID');
  });

  it('生命周期四步信号在同一 chunk 中仍按固定顺序逐步消费', async () => {
    const input = new PassThrough();
    const first = waitForFixedValidationSignal(
      input, 'observe-single', 1_000, 'lifecycle'
    );
    input.write(
      'observe-single\nobserve-minimized\nobserve-restored\nobserve-closed\n'
    );

    await first;
    await expect(waitForFixedValidationSignal(
      input, 'observe-minimized', 1_000, 'lifecycle'
    )).resolves.toBeUndefined();
    await expect(waitForFixedValidationSignal(
      input, 'observe-restored', 1_000, 'lifecycle'
    )).resolves.toBeUndefined();
    await expect(waitForFixedValidationSignal(
      input, 'observe-closed', 1_000, 'lifecycle'
    )).resolves.toBeUndefined();
  });

  it('Shell 夹具实际编译候选分支且公开结果不包含句柄或路径', async () => {
    const powershell = resolve(
      process.env.WINDIR!, 'System32/WindowsPowerShell/v1.0/powershell.exe'
    );
    const token = 'a'.repeat(32);
    const child = spawn(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', shellFixture
    ], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, AI_PET_TASK0E_PIPE_TOKEN: token }
    });
    if (child.pid === undefined) throw new Error('VALIDATION_PROCESS_START_FAILED');
    const pipe = await connectFixturePipe(child.pid, token);
    const publicLines = createInterface({ input: child.stdout });
    const internalLines = createInterface({ input: pipe });
    const publicLine = new Promise<string>(resolveLine => publicLines.once('line', resolveLine));
    const internalLine = new Promise<string>(resolveLine => internalLines.once('line', resolveLine));

    child.stdin.write('observe\n');
    const publicResult = JSON.parse(await publicLine) as Record<string, unknown>;
    const internalResult = JSON.parse(await internalLine) as Record<string, unknown>;
    const childExited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
    child.stdin.end('quit\n');
    pipe.end();
    await childExited;

    expect(Object.keys(publicResult).sort()).toEqual([
      'errorCode', 'matchCount', 'status', 'switchRound'
    ]);
    expect(['ready', 'none', 'ambiguous', 'unavailable']).toContain(publicResult.status);
    expect(Object.keys(internalResult)).toEqual([
      'outerHwnd', 'instanceId'
    ]);
    expect(JSON.stringify(publicResult)).not.toMatch(/hwnd|path|instance|pid/iu);
  }, 15_000);

  it('错误握手抢占连接时失败关闭且不输出原始句柄', async () => {
    const powershell = resolve(
      process.env.WINDIR!, 'System32/WindowsPowerShell/v1.0/powershell.exe'
    );
    const token = 'b'.repeat(32);
    const child = spawn(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', shellFixture
    ], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, AI_PET_TASK0E_PIPE_TOKEN: token }
    });
    if (child.pid === undefined) throw new Error('VALIDATION_PROCESS_START_FAILED');
    let socket: ReturnType<typeof connect> | undefined;
    for (let attempt = 0; attempt < 50 && socket === undefined; attempt++) {
      const candidate = connect(`\\\\.\\pipe\\ai-pet-task0e-${child.pid}-${token}`);
      const connected = await new Promise<boolean>(resolveConnected => {
        candidate.once('connect', () => resolveConnected(true));
        candidate.once('error', () => resolveConnected(false));
      });
      if (connected) socket = candidate;
      else {
        candidate.destroy();
        await new Promise(resolveWait => setTimeout(resolveWait, 100));
      }
    }
    if (socket === undefined) throw new Error('VALIDATION_PIPE_TIMEOUT');
    socket.end(`${'c'.repeat(32)}\n`);
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    await new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));

    expect(stderr).toContain('VALIDATION_PIPE_AUTH_FAILED');
    expect(stdout).toBe('');
    expect(`${stdout}${stderr}`).not.toMatch(/outerHwnd|[1-9][0-9]{4,}/u);
  }, 15_000);

  it('层级夹具只创建独立非 topmost 窗口并复用既有控制器与桥接', () => {
    const source = readFileSync(layerFixture, 'utf8');

    expect(source).toContain('ExplorerWindowLayerController');
    expect(source).not.toContain('ExplorerSpaceClient');
    expect(source).toContain("route !== 'electron'");
    expect(source).toContain('alwaysOnTop: false');
    expect(source).toContain('focusable: false');
    expect(source).toContain('show: false');
    expect(source).toContain('petImmediatelyAboveExplorer');
    expect(source).toContain('controllerHiddenWithin1000');
    expect(source).toContain('VALIDATION_LAYER_EVIDENCE_FAILED');
    expect(source).toContain('VALIDATION_HIDE_EVIDENCE_FAILED');
    expect(source).toContain('conservativeExposureUpperBoundMs');
    expect(source).not.toMatch(/renderer|preload|PetView|setAlwaysOnTop\s*\(/u);
    expect(source).not.toMatch(/process\.argv\[[4-9]\]/u);
    expect(source).not.toContain("'-Command', probe, petHwnd");
    expect(source).toContain('AI_PET_TASK0E_PROBE_TOKEN');
  });

  it('Shell 服务无参数且只接受固定 observe/quit 指令', () => {
    const source = readFileSync(shellFixture, 'utf8');

    expect(source).toContain('#define SHELL_TAB_HELPER_VALIDATION');
    expect(source).toContain("$command -ceq 'quit'");
    expect(source).toContain("$command -cne 'observe'");
    expect(source).not.toMatch(/^param\s*\(/mu);
    expect(source).not.toContain('-ExecutionPolicy');
    expect(source).not.toContain('Bypass');
    expect(source).toContain('PipeSecurity');
    expect(source).toContain('VALIDATION_PIPE_AUTH_FAILED');
  });

  it('前台采样不确定时先脱敏报告并隐藏，再以失败结果结束验收', () => {
    const source = readFileSync(layerFixture, 'utf8');

    expect(source).toContain("type: 'foreground-sample'");
    expect(source).toContain('window.hide();');
    expect(source).not.toContain('.invalidate(');
    expect(source).toContain('unsafeExposureUpperBoundMs');
    expect(source).toContain('VALIDATION_FOREGROUND_UNSAFE_HIDE_FAILED');
    expect(source.indexOf('window.hide();'))
      .toBeLessThan(source.indexOf("throw new Error('VALIDATION_FOREGROUND_SAMPLE_UNSAFE')"));
  });

  it('ready 采样的外层窗口变化时判定为目标漂移', () => {
    expect(isSameExplorerValidationTarget(
      { status: 'ready', matchCount: 1, switchRound: 3, outerHwnd: '22' },
      { switchRound: 3, outerHwnd: '11' }
    )).toBe(false);
  });

  it('ready 采样的切换轮次变化时判定为目标漂移', () => {
    expect(isSameExplorerValidationTarget(
      { status: 'ready', matchCount: 1, switchRound: 4, outerHwnd: '11' },
      { switchRound: 3, outerHwnd: '11' }
    )).toBe(false);
  });

  it('manual 普通应用切换窗口不依赖五秒聊天时延', () => {
    expect(getExplorerLayerSwitchWindowMs('manual')).toBe(300_000);
    expect(getExplorerLayerSwitchWindowMs('smoke')).toBe(5_000);
  });

  it('层级夹具只允许 Electron 路线且不实例化生产桥接客户端', () => {
    const source = readFileSync(layerFixture, 'utf8');
    expect(source).toContain("route !== 'electron'");
    expect(source).not.toContain('routeNeedsExplorerLayerClient');
    expect(source).not.toContain('new ExplorerSpaceClient');
  });

  it('生命周期真实矩阵只接受固定的单标签、最小化、恢复、关闭序列', () => {
    expect(getFixedValidationSignalSequence('lifecycle')).toEqual([
      'observe-single', 'observe-minimized', 'observe-restored', 'observe-closed'
    ]);
  });

  it('生命周期模式不接入测试窗口、Renderer 或生产桥接', () => {
    const source = readFileSync(layerFixture, 'utf8');

    expect(source).toContain("mode === 'lifecycle'");
    expect(source).toContain("'minimize-only-explorer-window'");
    expect(source).toContain("'restore-same-explorer-window'");
    expect(source).toContain("'close-only-explorer-window'");
    expect(source).toContain('VALIDATION_LIFECYCLE_MATRIX_NOT_PROVEN');
  });

  it('搜索与虚拟目录负向矩阵只接受两个固定信号', () => {
    expect(getFixedValidationSignalSequence('negative')).toEqual([
      'observe-negative-baseline', 'observe-negative-restore'
    ]);
  });

  it('普通应用前台产生的 none 不能冒充搜索或虚拟目录证据', () => {
    const none = { status: 'none', matchCount: 0, switchRound: 1, outerHwnd: '0' };

    expect(isStrictNegativeExplorerEvidence(none, true, 1)).toBe(true);
    expect(isStrictNegativeExplorerEvidence(none, false, 1)).toBe(false);
    expect(isStrictNegativeExplorerEvidence({ ...none, switchRound: 2 }, true, 1)).toBe(false);
    expect(isStrictNegativeExplorerEvidence(
      { ...none, status: 'ambiguous' }, true, 1
    )).toBe(false);
  });

  it('ready 后的 ambiguous 先隐藏，随后同轮次严格 none 才通过', () => {
    const target = { outerHwnd: '11', switchRound: 1 };
    const ambiguous = { status: 'ambiguous', matchCount: 0, switchRound: 1, outerHwnd: '0' };
    const none = { ...ambiguous, status: 'none' };

    expect(classifyHiddenNegativeExplorerSample(ambiguous, true, target)).toBe('wait');
    expect(classifyHiddenNegativeExplorerSample(none, true, target)).toBe('pass');
  });

  it('隐藏后只有 ambiguous 到截止仍不能通过', () => {
    const target = { outerHwnd: '11', switchRound: 1 };
    const ambiguous = { status: 'ambiguous', matchCount: 0, switchRound: 1, outerHwnd: '0' };

    expect(classifyHiddenNegativeExplorerSample(ambiguous, true, target)).toBe('wait');
  });

  it('隐藏后的 none 轮次漂移或普通应用前台均立即失败', () => {
    const target = { outerHwnd: '11', switchRound: 1 };
    const none = { status: 'none', matchCount: 0, switchRound: 1, outerHwnd: '0' };

    expect(classifyHiddenNegativeExplorerSample(
      { ...none, switchRound: 2 }, true, target
    )).toBe('fail');
    expect(classifyHiddenNegativeExplorerSample(none, false, target)).toBe('fail');
  });

  it('搜索单个 ambiguous 瞬态不能通过，连续两秒才请求终态探针', () => {
    const target = { outerHwnd: '11', switchRound: 1 };
    const ambiguous = { status: 'ambiguous', matchCount: 0, switchRound: 1, outerHwnd: '0' };
    const first = advanceSearchHiddenDwell(undefined, 0, ambiguous, target, 100, true);
    const middle = advanceSearchHiddenDwell(
      first.startedAt, first.probeCount, ambiguous, target, 1_500, true
    );
    const stable = advanceSearchHiddenDwell(
      middle.startedAt, middle.probeCount, ambiguous, target, 2_100, true
    );

    expect(first).toEqual({ decision: 'wait', startedAt: 100, probeCount: 1 });
    expect(middle).toEqual({ decision: 'wait', startedAt: 100, probeCount: 2 });
    expect(stable).toEqual({ decision: 'probe-stable', startedAt: 100, probeCount: 3 });
  });

  it('搜索隐藏满两秒但不足三次独立探针仍不能通过', () => {
    const target = { outerHwnd: '11', switchRound: 1 };
    const ambiguous = { status: 'ambiguous', matchCount: 0, switchRound: 1, outerHwnd: '0' };

    expect(advanceSearchHiddenDwell(100, 1, ambiguous, target, 2_500, true))
      .toEqual({ decision: 'wait', startedAt: 100, probeCount: 2 });
  });

  it('搜索隐藏期 ready 会重置稳定计时，轮次漂移直接失败', () => {
    const target = { outerHwnd: '11', switchRound: 1 };
    const ready = { status: 'ready', matchCount: 1, switchRound: 1, outerHwnd: '11' };
    const drift = { status: 'ambiguous', matchCount: 0, switchRound: 2, outerHwnd: '0' };

    expect(advanceSearchHiddenDwell(100, 2, ready, target, 2_500, false))
      .toEqual({ decision: 'wait', startedAt: undefined, probeCount: 0 });
    expect(advanceSearchHiddenDwell(100, 2, drift, target, 2_500, true).decision)
      .toBe('fail');
  });

  it('负向矩阵只观察用户导航结果，不提供通用导航命令', () => {
    const source = readFileSync(layerFixture, 'utf8');

    expect(source).toContain("mode === 'negative'");
    expect(source).toContain("'navigate-manually-to-search-results'");
    expect(source).toContain("'navigate-manually-to-apps-folder'");
    expect(source).toContain("'restore-same-explorer-filesystem'");
    expect(source).toContain("phase: 'negative-sample'");
    expect(source).toContain("type: 'negative-summary'");
    expect(source).toContain('lastPublishedSampleKey');
    expect(source).toContain('VALIDATION_NEGATIVE_MATRIX_NOT_PROVEN');
    expect(source).not.toMatch(/navigateTo|LocationURL\s*=|ShellExecute|SendMessage/u);
  });

  it('准确性核心矩阵只接受固定的七步人工序列，快速切换自动验收', () => {
    expect(getFixedValidationSignalSequence('accuracy-core')).toEqual([
      'observe-three-a', 'observe-same-dir-b', 'observe-three-c',
      'observe-three-a-return',
      'observe-window-a', 'observe-window-b', 'observe-window-a-return'
    ]);
  });

  it('准确性核心模式只输出脱敏阶段并使用内部不透明身份', () => {
    const source = readFileSync(layerFixture, 'utf8');

    expect(source).toContain("mode === 'accuracy-core'");
    expect(source).toContain("phase: 'accuracy-core'");
    expect(source).toContain('instanceId');
    expect(source).toContain('VALIDATION_ACCURACY_CORE_NOT_PROVEN');
    expect(source).not.toMatch(/type:\s*'candidate'[^\n]*(outerHwnd|instanceId)/u);
  });

  it('快速切换只接受 ambiguous 或已建立的三标签 ready 身份', () => {
    const target = { outerHwnd: '11', switchRound: 4 };
    const known = new Set(['A', 'B', 'C']);
    const ambiguous = advanceQuickSwitchEvidence(undefined, {
      status: 'ambiguous', matchCount: 0, switchRound: 4,
      outerHwnd: '0', instanceId: ''
    }, target, known);
    const knownReady = advanceQuickSwitchEvidence(ambiguous, {
      status: 'ready', matchCount: 1, switchRound: 5,
      outerHwnd: '11', instanceId: 'B'
    }, target, known);
    const unknownReady = advanceQuickSwitchEvidence(knownReady, {
      status: 'ready', matchCount: 1, switchRound: 6,
      outerHwnd: '11', instanceId: 'unknown'
    }, target, known);

    expect(ambiguous.failed).toBe(false);
    expect(knownReady).toMatchObject({ failed: false, sawIdentityChange: true });
    expect(unknownReady.failed).toBe(true);
  });

  it('快速切换先出现竞态证据，再由 A 连续稳定自动完成', () => {
    const target = { outerHwnd: '11', switchRound: 6 };
    const known = new Set(['A', 'B', 'C']);
    const finalA = { instanceId: 'A' };
    let state = advanceQuickSwitchAutoCompletion(undefined, {
      status: 'ambiguous', matchCount: 0, switchRound: 6,
      outerHwnd: '0', instanceId: ''
    }, target, known, finalA, 0);
    state = advanceQuickSwitchAutoCompletion(state, {
      status: 'ready', matchCount: 1, switchRound: 6,
      outerHwnd: '11', instanceId: 'A'
    }, target, known, finalA, 100);
    state = advanceQuickSwitchAutoCompletion(state, {
      status: 'ready', matchCount: 1, switchRound: 6,
      outerHwnd: '11', instanceId: 'A'
    }, target, known, finalA, 350);
    state = advanceQuickSwitchAutoCompletion(state, {
      status: 'ready', matchCount: 1, switchRound: 6,
      outerHwnd: '11', instanceId: 'A'
    }, target, known, finalA, 600);

    expect(state).toMatchObject({ failed: false, completed: true, stableACount: 3 });
  });

  it('A 稳定采样相邻超过 250ms 时重置连续计数', () => {
    const target = { outerHwnd: '11', switchRound: 6 };
    const known = new Set(['A']);
    const finalA = { instanceId: 'A' };
    let state = advanceQuickSwitchAutoCompletion(undefined, {
      status: 'ambiguous', matchCount: 0, switchRound: 6,
      outerHwnd: '0', instanceId: ''
    }, target, known, finalA, 0);
    state = advanceQuickSwitchAutoCompletion(state, {
      status: 'ready', matchCount: 1, switchRound: 6,
      outerHwnd: '11', instanceId: 'A'
    }, target, known, finalA, 100);
    state = advanceQuickSwitchAutoCompletion(state, {
      status: 'ready', matchCount: 1, switchRound: 6,
      outerHwnd: '11', instanceId: 'A'
    }, target, known, finalA, 400);

    expect(state).toMatchObject({ completed: false, stableACount: 1, stableAStartedAt: 400 });
  });

  it('快速切换没有竞态证据或停在 B/C 时不能自动通过，none 必须失败', () => {
    const target = { outerHwnd: '11', switchRound: 6 };
    const known = new Set(['A', 'B', 'C']);
    const finalA = { instanceId: 'A' };
    const readyA = {
      status: 'ready' as const, matchCount: 1, switchRound: 6,
      outerHwnd: '11', instanceId: 'A'
    };
    let noEvidence = advanceQuickSwitchAutoCompletion(undefined, readyA, target, known, finalA, 0);
    noEvidence = advanceQuickSwitchAutoCompletion(noEvidence, readyA, target, known, finalA, 600);

    let stableB = advanceQuickSwitchAutoCompletion(undefined, {
      status: 'ambiguous', matchCount: 0, switchRound: 6,
      outerHwnd: '0', instanceId: ''
    }, target, known, finalA, 0);
    stableB = advanceQuickSwitchAutoCompletion(stableB, {
      status: 'ready', matchCount: 1, switchRound: 7,
      outerHwnd: '11', instanceId: 'B'
    }, target, known, finalA, 100);
    stableB = advanceQuickSwitchAutoCompletion(stableB, {
      status: 'ready', matchCount: 1, switchRound: 7,
      outerHwnd: '11', instanceId: 'B'
    }, target, known, finalA, 700);
    const none = advanceQuickSwitchAutoCompletion(stableB, {
      status: 'none', matchCount: 0, switchRound: 7,
      outerHwnd: '0', instanceId: ''
    }, target, known, finalA, 800);

    expect(noEvidence.completed).toBe(false);
    expect(stableB.completed).toBe(false);
    expect(none.failed).toBe(true);
  });
});
