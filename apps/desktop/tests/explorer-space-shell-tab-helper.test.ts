import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const fixtureFile = resolve(
  import.meta.dirname,
  'fixtures/explorer-space-shell-tab-self-test.ps1'
);
const helperSourceFile = resolve(
  import.meta.dirname,
  '../resources/windows/explorer-space-shell-tab-helper.cs'
);
const powershell = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'System32/WindowsPowerShell/v1.0/powershell.exe'
);

const fixedScenarios = [
  'active-a',
  'active-b',
  'switch-a-b-a',
  'zero-match',
  'multiple-match',
  'duplicate-tab-hwnd',
  'race-active-tab',
  'race-outer-hwnd',
  'race-process-id',
  'race-process-created-at',
  'race-foreground',
  'race-rect',
  'race-minimized',
  'mapping-race',
  'rect-unavailable',
  'not-explorer',
  'minimized',
  'search-result',
  'virtual-directory',
  'com-initialization-error',
  'query-service-error',
  'get-window-error',
  'fixed-helper-file-error',
  'unknown-os-major',
  'unknown-os-minor',
  'unknown-os-build',
  'unknown-product-version',
  'unknown-explorer-file-version',
  'unknown-file-major',
  'unknown-file-minor',
  'unknown-file-build',
  'unknown-mapping-version',
  'candidate-profile-production',
  'candidate-profile-validation',
  'production-boundary'
] as const;

type FixedScenario = typeof fixedScenarios[number];
type DecisionStatus = 'ready' | 'ambiguous' | 'none' | 'unavailable';

interface SelfTestResult {
  scenario: FixedScenario;
  status?: DecisionStatus;
  statuses?: DecisionStatus[];
  titleGetterCalls: number;
  candidateEnumerationCalls: number;
  candidateReleaseCalls: number;
  publicPayload?: Record<string, unknown>;
}

/** 只允许执行计划内的固定场景，绝不向夹具传递源码、COM 标识或真实窗口事实。 */
function runFixedScenario(scenario: FixedScenario): Promise<SelfTestResult> {
  if (!existsSync(fixtureFile)) {
    throw new Error('SHELL_TAB_SELF_TEST_FIXTURE_MISSING');
  }

  return new Promise<SelfTestResult>((resolveScenario, rejectScenario) => {
    execFile(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      fixtureFile,
      '-Scenario',
      scenario
    ], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        rejectScenario(error);
        return;
      }

      try {
        expect(error?.code ?? 0, stderr.trim() || 'SHELL_TAB_SELF_TEST_FAILED').toBe(0);
        expect(stderr.trim()).toBe('');

        const output = stdout.trim();
        expect(output.split(/\r?\n/u)).toHaveLength(1);
        resolveScenario(JSON.parse(output) as SelfTestResult);
      } catch (scenarioError) {
        rejectScenario(scenarioError);
      }
    });
  });
}

function expectPrivateFactsHidden(result: SelfTestResult): void {
  expect(result.publicPayload).toBeDefined();
  expect(Object.keys(result.publicPayload ?? {})).not.toContain('tabHwnd');
  expect(Object.keys(result.publicPayload ?? {})).not.toContain('candidateHwnds');
  expect(Object.keys(result.publicPayload ?? {})).not.toContain('title');
  expect(Object.keys(result.publicPayload ?? {})).not.toContain('unmatchedPath');
}

describe('资源管理器活动标签固定 Helper', () => {
  it('固定场景等待期间让 Vitest worker 获得事件循环轮转', async () => {
    let scenarioSettled = false;
    const scenarioFinished = runFixedScenario('active-a');
    void scenarioFinished.then(() => {
      scenarioSettled = true;
    }, () => {
      scenarioSettled = true;
    });

    for (let turn = 0; turn < 2; turn += 1) {
      await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
      expect(scenarioSettled).toBe(false);
    }

    await expect(scenarioFinished).resolves.toMatchObject({
      scenario: 'active-a',
      status: 'ready'
    });
  });

  it.each([
    'active-a',
    'active-b'
  ] as const)('同一外层窗口只选择活动候选：%s', async scenario => {
    const result = await runFixedScenario(scenario);

    expect(result).toMatchObject({
      scenario,
      status: 'ready'
    });
    expectPrivateFactsHidden(result);
  });

  it('A → B → A 每轮重新决策，不重放旧候选', async () => {
    const result = await runFixedScenario('switch-a-b-a');

    expect(result.statuses).toEqual(['ready', 'ready', 'ready']);
    expectPrivateFactsHidden(result);
  });

  it.each([
    'zero-match',
    'multiple-match',
    'duplicate-tab-hwnd'
  ] as const)('%s 在唯一映射前失败关闭', async (scenario) => {
    const result = await runFixedScenario(scenario);

    expect(result.status).toBe('ambiguous');
    expectPrivateFactsHidden(result);
  });

  it.each([
    'race-active-tab',
    'race-outer-hwnd',
    'race-process-id',
    'race-process-created-at',
    'race-foreground',
    'race-rect',
    'race-minimized',
    'mapping-race'
  ] as const)('%s 双采样变化时不返回旧窗口', async (scenario) => {
    const result = await runFixedScenario(scenario);

    expect(result.status).toBe('ambiguous');
    expectPrivateFactsHidden(result);
  });

  it('窗口矩形读取失败时在候选枚举前失败关闭', async () => {
    const result = await runFixedScenario('rect-unavailable');

    expect(result.status).toBe('ambiguous');
    expect(result.candidateEnumerationCalls).toBe(0);
    expectPrivateFactsHidden(result);
  });

  it.each([
    'not-explorer',
    'minimized'
  ] as const)('%s 返回 none 且从不读取窗口标题', async (scenario) => {
    const result = await runFixedScenario(scenario);

    expect(result.status).toBe('none');
    expect(result.titleGetterCalls).toBe(0);
    expect(result.candidateEnumerationCalls).toBe(0);
    expectPrivateFactsHidden(result);
  });

  it.each(['search-result', 'virtual-directory'] as const)(
    '%s 按普通 Explorer 参与唯一活动标签映射',
    async scenario => {
    const result = await runFixedScenario(scenario);

    expect(result.status).toBe('ready');
    expect(result.candidateEnumerationCalls).toBe(2);
    expectPrivateFactsHidden(result);
    }
  );

  it('二次映射变化时释放前后两批候选', async () => {
    const result = await runFixedScenario('mapping-race');

    expect(result.candidateEnumerationCalls).toBe(2);
    expect(result.candidateReleaseCalls).toBe(3);
  });

  it.each([
    'com-initialization-error',
    'query-service-error',
    'get-window-error',
    'fixed-helper-file-error',
    'unknown-os-major',
    'unknown-os-minor',
    'unknown-os-build',
    'unknown-product-version',
    'unknown-explorer-file-version',
    'unknown-file-major',
    'unknown-file-minor',
    'unknown-file-build',
    'unknown-mapping-version'
  ] as const)('%s 返回 unavailable', async (scenario) => {
    const result = await runFixedScenario(scenario);

    expect(result.status).toBe('unavailable');
    expectPrivateFactsHidden(result);
  });

  it('候选验收条件只对同源精确 profile 判定开放', async () => {
    const production = await runFixedScenario('candidate-profile-production');
    const result = await runFixedScenario('candidate-profile-validation');

    expect(production.status).toBe('ready');
    expectPrivateFactsHidden(production);
    expect(result.status).toBe('ready');
    expectPrivateFactsHidden(result);
  });

  it('生产 Helper 源码仅保留受限能力边界', async () => {
    if (!existsSync(helperSourceFile)) {
      throw new Error('SHELL_TAB_HELPER_SOURCE_MISSING');
    }

    const source = readFileSync(helperSourceFile, 'utf8');
    for (const forbidden of [
      'System.Windows.Automation',
      'UIAutomation',
      'FlaUI',
      'SendMessage',
      'PostMessage',
      'mouse_event',
      'keybd_event',
      'GetWindowText',
      'Capture',
      'Screenshot',
      'setAlwaysOnTop(true)',
      'HWND_TOPMOST',
      '-ExecutionPolicy',
      'Bypass'
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).not.toMatch(/WindowsExplorerSystemAdapter\s*\(\s*bool/u);
    expect(source).not.toMatch(/new\s+WindowsExplorerSystemAdapter\s*\(\s*true\s*\)/u);
    expect(source).toMatch(/ProductionVerified\s*=\s*true/u);
    expect(source).not.toContain('CandidateValidationEnabled');
    expect(source).toMatch(/versionInfo\.ProductVersion/u);
    expect(source).not.toMatch(/GetVersionInfo\([^)]*\)\.FileVersion/u);
    for (const forbidden of [
      'LocationURL', 'ReadPath', 'PathReadResult', 'ExplorerPathNormalizer', 'HMACSHA256'
    ]) expect(source).not.toContain(forbidden);

    const boundary = await runFixedScenario('production-boundary');
    expect(boundary.status).toBe('ready');
    expectPrivateFactsHidden(boundary);
  });
});
