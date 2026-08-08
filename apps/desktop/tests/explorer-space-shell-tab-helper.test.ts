import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  'race-path',
  'ending-path-unavailable',
  'ending-path-none',
  'ending-path-invalid',
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
  'invalid-percent-location',
  'valid-percent-location',
  'keyed-fingerprint-same',
  'keyed-fingerprint-different-path',
  'keyed-fingerprint-different-token',
  'production-boundary'
] as const;

type FixedScenario = typeof fixedScenarios[number];
type DecisionStatus = 'ready' | 'ambiguous' | 'none' | 'unavailable';

interface SelfTestResult {
  scenario: FixedScenario;
  status?: DecisionStatus;
  statuses?: DecisionStatus[];
  selectedPathToken?: 'A' | 'B';
  selectedPathTokens?: Array<'A' | 'B'>;
  pathGetterCalls: number;
  titleGetterCalls: number;
  candidateEnumerationCalls: number;
  candidateReleaseCalls: number;
  publicPayload?: Record<string, unknown>;
}

/** 只允许执行计划内的固定场景，绝不向夹具传递源码、COM 标识或真实窗口事实。 */
function runFixedScenario(scenario: FixedScenario): SelfTestResult {
  if (!existsSync(fixtureFile)) {
    throw new Error('SHELL_TAB_SELF_TEST_FIXTURE_MISSING');
  }

  const result = spawnSync(powershell, [
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
  });

  if (result.error) throw result.error;
  expect(result.status, result.stderr.trim() || 'SHELL_TAB_SELF_TEST_FAILED').toBe(0);

  const output = result.stdout.trim();
  expect(output.split(/\r?\n/u)).toHaveLength(1);
  return JSON.parse(output) as SelfTestResult;
}

function expectPrivateFactsHidden(result: SelfTestResult): void {
  expect(result.publicPayload).toBeDefined();
  expect(Object.keys(result.publicPayload ?? {})).not.toContain('tabHwnd');
  expect(Object.keys(result.publicPayload ?? {})).not.toContain('candidateHwnds');
  expect(Object.keys(result.publicPayload ?? {})).not.toContain('title');
  expect(Object.keys(result.publicPayload ?? {})).not.toContain('unmatchedPath');
}

describe('资源管理器活动标签固定 Helper', () => {
  it.each([
    ['active-a', 'A'],
    ['active-b', 'B']
  ] as const)('同一外层窗口只选择活动候选：%s', (scenario, selectedPathToken) => {
    const result = runFixedScenario(scenario);

    expect(result).toMatchObject({
      scenario,
      status: 'ready',
      selectedPathToken,
      pathGetterCalls: 2
    });
    expectPrivateFactsHidden(result);
  });

  it('虚拟目录命名空间返回 none 且不依赖窗口标题', () => {
    const result = runFixedScenario('virtual-directory');

    expect(result.status).toBe('none');
    expect(result.titleGetterCalls).toBe(0);
    expectPrivateFactsHidden(result);
  });

  it.each([
    'keyed-fingerprint-same',
    'keyed-fingerprint-different-path',
    'keyed-fingerprint-different-token'
  ] as const)('%s 使用本次 token 的加钥指纹', (scenario) => {
    expect(runFixedScenario(scenario).status).toBe('ready');
  });

  it('A → B → A 每轮重新决策，不重放旧路径', () => {
    const result = runFixedScenario('switch-a-b-a');

    expect(result.statuses).toEqual(['ready', 'ready', 'ready']);
    expect(result.selectedPathTokens).toEqual(['A', 'B', 'A']);
    expect(result.pathGetterCalls).toBe(6);
    expectPrivateFactsHidden(result);
  });

  it.each([
    'zero-match',
    'multiple-match',
    'duplicate-tab-hwnd'
  ] as const)('%s 在唯一映射前失败关闭且不读取路径', (scenario) => {
    const result = runFixedScenario(scenario);

    expect(result.status).toBe('ambiguous');
    expect(result.pathGetterCalls).toBe(0);
    expectPrivateFactsHidden(result);
  });

  it.each([
    'race-active-tab',
    'race-outer-hwnd',
    'race-process-id',
    'race-process-created-at',
    'race-foreground',
    'mapping-race'
  ] as const)('%s 双采样变化时不返回旧路径', (scenario) => {
    const result = runFixedScenario(scenario);

    expect(result.status).toBe('ambiguous');
    expect(result.pathGetterCalls).toBe(1);
    expectPrivateFactsHidden(result);
  });

  it('race-path 在身份与映射稳定但二次路径变化时不得返回旧 ready', () => {
    const result = runFixedScenario('race-path');

    expect(result.status).toBe('ambiguous');
    expect(result.pathGetterCalls).toBe(2);
    expectPrivateFactsHidden(result);
  });

  it.each([
    ['ending-path-unavailable', 'unavailable'],
    ['ending-path-none', 'none'],
    ['ending-path-invalid', 'ambiguous']
  ] as const)('%s 的第二次路径读取按严格状态失败关闭', (scenario, status) => {
    const result = runFixedScenario(scenario);

    expect(result.status).toBe(status);
    expect(result.pathGetterCalls).toBe(2);
    expectPrivateFactsHidden(result);
  });

  it('窗口矩形读取失败时在路径 getter 前失败关闭', () => {
    const result = runFixedScenario('rect-unavailable');

    expect(result.status).toBe('ambiguous');
    expect(result.pathGetterCalls).toBe(0);
    expectPrivateFactsHidden(result);
  });

  it.each([
    'not-explorer',
    'minimized',
    'search-result'
  ] as const)('%s 返回 none 且从不读取窗口标题', (scenario) => {
    const result = runFixedScenario(scenario);

    expect(result.status).toBe('none');
    expect(result.titleGetterCalls).toBe(0);
    expect(result.candidateEnumerationCalls).toBe(scenario === 'search-result' ? 1 : 0);
    expectPrivateFactsHidden(result);
  });

  it('二次映射变化时释放前后两批候选', () => {
    const result = runFixedScenario('mapping-race');

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
  ] as const)('%s 返回 unavailable', (scenario) => {
    const result = runFixedScenario(scenario);

    expect(result.status).toBe('unavailable');
    expect(result.pathGetterCalls).toBe(0);
    expectPrivateFactsHidden(result);
  });

  it('候选验收条件只对同源精确 profile 判定开放', () => {
    const production = runFixedScenario('candidate-profile-production');
    const result = runFixedScenario('candidate-profile-validation');

    expect(production.status).toBe('ready');
    expect(production.pathGetterCalls).toBe(0);
    expectPrivateFactsHidden(production);
    expect(result.status).toBe('ready');
    expect(result.pathGetterCalls).toBe(0);
    expectPrivateFactsHidden(result);
  });

  it.each([
    ['invalid-percent-location', 'ambiguous'],
    ['valid-percent-location', 'ready']
  ] as const)('%s 直接命中同源 URI 规范化器', (scenario, status) => {
    const result = runFixedScenario(scenario);

    expect(result.status).toBe(status);
    expect(result.pathGetterCalls).toBe(1);
    expectPrivateFactsHidden(result);
  });

  it('生产 Helper 源码仅保留受限能力边界', () => {
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

    const boundary = runFixedScenario('production-boundary');
    expect(boundary.status).toBe('ready');
    expectPrivateFactsHidden(boundary);
  });
});
