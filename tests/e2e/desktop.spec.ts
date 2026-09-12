import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import type { TaskEvent } from '@myself/shared-types';
import { characterBehaviorRoles, type CharacterBehaviorBindings } from '../../apps/desktop/src/main/characters/character-behavior-bindings';
import { CharacterStore } from '../../apps/desktop/src/main/characters/character-store';
import { SettingsStore } from '../../apps/desktop/src/main/storage/settings-store';
import {
  codingResponse,
  createProviderResponseGate,
  startProviderServer,
  type ProviderStep
} from '../fixtures/provider-server';
import { snapshotCharacterPersistence } from '../fixtures/character-storage-snapshot';
import { readWindowsCursor, setWindowsCursor, setWindowsLeftButton, readWindowsPointerTarget,
  readWindowsProcessWindowRect, raiseWindowsProcessWindow, type WindowsCursorSnapshot, type WindowsPointerTarget,
  type WindowsWindowRect } from '../fixtures/windows-pointer';

const execFileAsync = promisify(execFile);
type CharacterBehaviorProbe = {
  revision: number;
  stateId: string;
  actionId: string | null;
  playbackStatus: 'scheduled' | 'started' | 'completed' | 'interrupted' | 'failed' | null;
};

type CharacterMotionDeltaProbe = {
  moved: boolean;
  horizontal: number;
  vertical: number;
};

type ConversationE2eProbe = {
  phase: 'idle' | 'listening' | 'thinking' | 'awaiting_confirmation'
    | 'acting' | 'success' | 'error' | 'cancelled';
  visibleMessageCount: number;
  historyDisclosureVisible: boolean;
  fileConfirmationVisible: boolean;
};

type ElectronFixtureModule = {
  writeMainE2eExplorerEvent(
    userDataDirectory: string,
    event: 'layer-error' | 'stale-sequence' | 'non-explorer'
      | 'ambiguous' | 'foreground-explorer' | 'minimized' | 'blurred' | 'crash'
  ): Promise<void>;
  createElectronLaunchPlan(options: {
    workspaceRoot: string;
    cdpPort: number;
    userDataDirectory: string;
    authorizedRootDirectory: string;
    recycleBinDirectory?: string;
    characterAssetsDirectory?: string;
    parentEnvironment?: NodeJS.ProcessEnv;
    enableSoftwareRasterizer?: boolean;
  }): {
    executablePath: string;
    applicationEntry: string;
    cdpEndpoint: string;
    args: string[];
    environment: NodeJS.ProcessEnv;
  };
  redactElectronLog(
    text: string,
    secrets: {
      apiKey: string;
      additionalSecrets?: readonly string[];
      authorizedRootDirectory: string;
      recycleBinDirectory?: string;
      userDataDirectory?: string;
      characterAssetsDirectory?: string;
      safeCharacterPackage?: string;
      maliciousCharacterPackage?: string;
      characterExportDestination?: string;
    }
  ): string;
  waitForCdpReady(options: {
    endpoint: string;
    timeoutMs: number;
    intervalMs?: number;
    probe?: (endpoint: string) => Promise<boolean>;
  }): Promise<void>;
  observeElectronProcessStreamsClosed(process: EventEmitter): Promise<void>;
  createCapturedLogEvidenceTracker(input: Readonly<{
    apiKey: string;
    authorizedRootDirectory: string;
    sentinels: readonly string[];
  }>): {
    capture(source: 'stdout' | 'stderr', chunk: string | Buffer): void;
    snapshot(): Readonly<{
      apiKey: boolean;
      authorizedRoot: boolean;
      authorizationHeader: boolean;
      sentinels: readonly boolean[];
    }>;
    resetStreams(): void;
    dispose(): void;
  };
  createCompleteLogCanaryTracker(maxBytes: number): {
    capture(source: 'stdout' | 'stderr', chunk: string | Buffer): void;
    inspect(canaries: readonly string[]): readonly boolean[];
  };
  inspectPrivateArtifactCanaries(
    artifacts: readonly unknown[],
    canaries: readonly string[]
  ): readonly boolean[];
  probeWindowsProcess(
    processId: number,
    options?: {
      signal?: AbortSignal;
      runCommand?(file: string, args: string[], signal?: AbortSignal): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>;
    }
  ): Promise<
    | { status: 'absent' }
    | { status: 'running'; executablePath: string }
  >;
  inspectWindowsElectronDescendants(
    processId: number,
    options?: {
      runCommand?(file: string, args: string[], signal?: AbortSignal): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>;
    }
  ): Promise<Array<{
    processId: number;
    name: string;
    powershell: boolean;
    explorerBridge: boolean;
  }>>;
  terminateElectronProcess(
    process: FakeElectronProcess,
    executablePath: string,
    options?: {
      platform?: NodeJS.Platform;
      gracefulExitTimeoutMs?: number;
      taskkillTimeoutMs?: number;
      helperExitTimeoutMs?: number;
      processExitTimeoutMs?: number;
      probeTimeoutMs?: number;
      probeIntervalMs?: number;
      spawnCommand?(file: string, args: string[]): FakeCommandProcess;
      processProbe?(processId: number, signal?: AbortSignal): Promise<
        | { status: 'absent' }
        | { status: 'running'; executablePath: string }
      >;
      onDiagnostic?(message: string): void;
    }
  ): Promise<void>;
  createElectronAppFixture(options: {
    workspaceRoot: string;
    apiKey: string;
    additionalSecrets?: readonly string[];
    logSentinels?: readonly string[];
    enableLocalModelFixture?: boolean;
    localModelStderrCanary?: string;
    launchTimeoutMs?: number;
    operationTimeoutMs?: number;
    prepareUserData?(directories: {
      baseDirectory: string;
      userDataDirectory: string;
      authorizedRootDirectory: string;
      characterAssetsDirectory?: string;
      packagesDirectory?: string;
      exportsDirectory?: string;
    }): Promise<void>;
    beforeRestart?(directories: {
      baseDirectory: string;
      userDataDirectory: string;
      authorizedRootDirectory: string;
    }): Promise<void>;
    dependencies?: {
      allocateLoopbackPort(): Promise<number>;
      createTemporaryDirectories(): Promise<{
        baseDirectory: string;
        userDataDirectory: string;
        authorizedRootDirectory: string;
      }>;
      spawnProcess(plan: ElectronLaunchPlan): FakeElectronProcess;
      waitForReady(options: { endpoint: string; timeoutMs: number }): Promise<void>;
      connectOverCdp(endpoint: string): Promise<{ close(): Promise<void> }>;
      terminateProcess(process: FakeElectronProcess, executablePath: string): Promise<void>;
      removeTemporaryBase(baseDirectory: string): Promise<void>;
    };
  }): Promise<{
    browser: {
      contexts(): Array<{ pages(): Page[] }>;
      close(): Promise<void>;
    };
    processId: number;
    executablePath: string;
    userDataDirectory: string;
    authorizedRootDirectory: string;
    recycleBinDirectory?: string;
    safeCharacterPackage?: string;
    maliciousCharacterPackage?: string;
    characterExportDestination?: string;
    logs: readonly string[];
    capturedLogEvidence: Readonly<{
      apiKey: boolean;
      authorizedRoot: boolean;
      authorizationHeader: boolean;
      sentinels: readonly boolean[];
    }>;
    sendExplorerEvent(
      event: 'layer-error' | 'stale-sequence' | 'non-explorer'
        | 'ambiguous' | 'foreground-explorer' | 'minimized' | 'blurred'
        | 'crash'
    ): Promise<void>;
    getMainE2eState(): Promise<{
      revision: number;
      buildIdentity: {
        commitShortHash: string;
        buildRootCategory: 'primary_checkout' | 'linked_worktree' | 'source_archive';
      };
      petWindowVisible: boolean;
      petWindowAlwaysOnTop: boolean;
      petWindowBoundsDip: { x: number; y: number; width: number; height: number };
      petNativeDragging: boolean;
      processedExplorerEventRevision: number;
      processedExplorerEvent: string | null;
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
    }>;
    getMainDescendantProcesses(): Promise<Array<{
      processId: number;
      name: string;
      powershell: boolean;
      explorerBridge: boolean;
    }>>;
    getPetInteractionProbe(): Promise<{
      passthrough: boolean;
      dragging: boolean;
      mouseMoveHitCount: number;
    }>;
    getCharacterBehaviorProbe(): Promise<CharacterBehaviorProbe>;
    getCharacterMotionDeltaProbe(): Promise<CharacterMotionDeltaProbe>;
    getConversationProbe(): Promise<ConversationE2eProbe>;
    markLocalModelValidationReady(): Promise<void>;
    markLocalModelReady(): Promise<void>;
    getLocalModelFixturePrivatePaths(): readonly string[];
    getLocalModelFixtureEvidence(): Promise<{
      processId: number;
      port: number;
      token: string;
      fixtureScriptPath: string;
      modelPath: string;
      requestedRuntimePath: string;
      actualRuntimePath: string;
      resourceRoot: string;
      tokenFilePath: string;
      stderrCanary: string;
      requestedSpawnOptions: { shell: false; windowsHide: true };
      actualSpawnOptions: { shell: false; windowsHide: true };
    }>;
    inspectCapturedLogCanaries(canaries: readonly string[]): readonly boolean[];
    restart(): Promise<void>;
    closeApplicationForInspection(): Promise<void>;
    dispose(): Promise<void>;
  }>;
};

type ElectronLaunchPlan = ReturnType<ElectronFixtureModule['createElectronLaunchPlan']>;

type FakeElectronProcess = EventEmitter & {
  pid: number;
  spawnfile: string;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill?: (signal?: NodeJS.Signals | number) => boolean;
};

type FakeCommandProcess = EventEmitter & {
  exitCode: number | null;
  signalCode?: NodeJS.Signals | null;
  kill?: (signal?: NodeJS.Signals | number) => boolean;
};

function fakeElectronProcess(pid: number, spawnfile: string): FakeElectronProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    spawnfile,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null
  });
}

function emitFakeExit(process: FakeElectronProcess | FakeCommandProcess, code: number): void {
  process.exitCode = code;
  process.emit('exit', code, null);
}

function runtimeDiagnosticKey(): string {
  return `myself-e2e-${randomBytes(24).toString('hex')}`;
}

async function pathExistsForAssertion(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw new Error('文件系统存在性检查失败');
  }
}

async function readTextForAssertion(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new Error('文件系统文本读取失败');
  }
}

function sanitizeCapturedDiagnostic(
  text: string,
  ...sensitiveValues: Array<string | undefined>
): string {
  return sensitiveValues
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.length - left.length)
    .reduce(
      (sanitized, value) => sanitized.replaceAll(value, '[已脱敏]'),
      text.replace(/authorization\s*:[^\r\n]*/giu, '[已脱敏]')
    );
}

/** 捕获边界只保留脱敏后的新错误，禁止原始 message、stack 或 cause 继续传播。 */
function sanitizedCapturedError(
  error: unknown,
  sanitize: (text: string) => string
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = new Error(sanitize(message));
  if (error instanceof Error) sanitized.name = error.name;
  return sanitized;
}

async function submitChatMessage(page: Page, text: string): Promise<void> {
  await page.getByLabel('和我说点什么').fill(text);
  const send = page.getByRole('button', { name: '发送给 AI Pet' });
  await expect(send).toBeEnabled();
  await send.click();
}

const noExpression = { kind: 'none', choice: null, mode: 'keep', target: null, distance: null } as const;
type CharacterWire = {
  kind: 'none' | 'reaction' | 'state' | 'action' | 'background' | 'movement';
  choice: { stateId: string; actionId: string } | null;
  mode: 'keep' | 'still' | 'continuous' | 'intermittent' | 'once';
  target: 'random_work_area' | 'left' | 'right' | 'top' | 'bottom' | 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right' | null;
  distance: 'near' | 'medium' | 'far' | null;
};

/** 角色或模型生命周期先解释用途，逐轮与终态不再请求旧活动协议。 */
function behaviorBindingsStep(bindings: Partial<CharacterBehaviorBindings> = {}, inspect?: ProviderStep['inspect']): ProviderStep {
  return { response: { type: 'structured', structured_output: Object.fromEntries(characterBehaviorRoles.map(role => [role, bindings[role] ?? null])) },
    inspect: request => {
      expect(request.tools).toEqual([]); expect(request.toolChoice).toBe('none'); expect(request.responseFormatWasJsonObject).toBe(true);
      const author = JSON.parse(request.messages.find(message => message.role === 'user')!.content);
      expect(Array.isArray(author.authorStates)).toBe(true); expect(Object.keys(author.scenes).sort()).toEqual([...characterBehaviorRoles].sort());
      inspect?.(request);
    } };
}

/** 主正文与表现使用独立 Provider 请求，范围卡继续由 Main 裁决。 */
function characterChatSteps(
  text: string,
  selection: Readonly<Partial<CharacterWire>> = {},
  main: Omit<ProviderStep, 'response'> = {},
  inspectExpression?: ProviderStep['inspect']
): ProviderStep[] {
  // 同轮两个请求允许到达顺序变化；Symbol 保证绝不跨轮借用响应。
  const group = Symbol('character-chat-turn');
  return [
    { response: { type: 'text', text }, ...main,
      concurrent: { group, match: request => request.tools.length === 1
        && request.tools[0]?.function.name === 'request_task_authorization'
        && !request.responseFormatWasJsonObject } },
    { response: { type: 'structured', structured_output: {
      ...noExpression, ...selection
    } }, concurrent: { group, match: request => request.tools.length === 0
      && request.responseFormatWasJsonObject
      && request.messages.some(message => message.role === 'system'
        && message.content.startsWith('Main公开情境与候选：')
        && JSON.parse(message.content.slice('Main公开情境与候选：'.length)).trigger === 'chat') }, inspect: request => {
      expect(request.tools).toEqual([]);
      expect(request.toolChoice).toBe('none');
      expect(request.responseFormatWasJsonObject).toBe(true);
      inspectExpression?.(request);
    } }
  ];
}

function taskAuthorizationSteps(selection: Readonly<Partial<CharacterWire>> = {}): ProviderStep[] {
  const [main, expression] = characterChatSteps('', selection, { inspect: expectCharacterChatRequest });
  return [{ ...main!, response: { type: 'tool_request', request: {
    requestId: 'request-scope', toolName: 'request_task_authorization', arguments: {}
  } } }, expression!];
}

function coreRequestCount(provider: Awaited<ReturnType<typeof startProviderServer>>): number {
  return provider.requests.filter(request => request.toolCount > 1).length;
}

test('新默认角色实际首帧先于慢正文，持续休息三十秒不插入待机且明确开心后恢复', async () => {
  test.setTimeout(120_000);
  const mainGate = createProviderResponseGate();
  let seenCandidates: unknown;
  const provider = await startProviderServer([
      behaviorBindingsStep(),
    ...characterChatSteps('好，我会继续休息。', {
      kind: 'background', choice: { stateId: 'state-2', actionId: 'state-2-action' }
    }, { gate: mainGate }, request => {
      const encoded = request.messages.find(message => message.role === 'system' && message.content.startsWith('Main公开情境与候选：'))?.content;
      seenCandidates = request.messages.filter(message => message.role === 'system').map(message => message.content.slice(0, 24));
      const context = JSON.parse(encoded!.slice('Main公开情境与候选：'.length));
      seenCandidates = context.character.states.map((state: { stateId: string; actions: { actionId: string }[] }) => ({ stateId: state.stateId, actions: state.actions.map(action => action.actionId) }));
      expect(context.character.states).toContainEqual(expect.objectContaining({ stateId: 'state-2',
        actions: expect.arrayContaining([expect.objectContaining({ actionId: 'state-2-action' })]) }));
    }),
    ...characterChatSteps('开心一下，然后继续休息。', {
      kind: 'action', choice: { stateId: 'state-8', actionId: 'state-8-action' }
    })
  ]);
  const fixtureModule = await loadElectronFixtureModule();
  const fixture = await fixtureModule.createElectronAppFixture({ workspaceRoot: resolve(process.cwd()),
    apiKey: provider.apiKey, launchTimeoutMs: 30_000, enableSoftwareRasterizer: true,
    prepareUserData: async ({ userDataDirectory }) => {
      const settings = new SettingsStore(join(userDataDirectory, 'settings.json'));
      await settings.saveMovementMode(0);
    } });
  try {
    const pet = await waitForRendererPage(fixture, 'pet', 30_000);
    const chat = await waitForRendererPage(fixture, 'chat');
    await pet.evaluate(async ({ baseUrl, apiKey }) => {
      await window.myself.saveProviderProfile({ profile: { id: 'continuity', displayName: '连续表现验证', mode: 'custom',
        protocol: 'openai-compatible', baseUrl, modelId: 'continuity', additionalParameters: {}, capabilities: ['chat', 'tools'] },
        secret: apiKey, persistSecret: true });
      await window.myself.saveModelRoute({ primaryProfileId: 'continuity', chatProfileId: 'continuity', agentProfileId: 'continuity',
        visionProfileId: null, fallbackProfileIds: [], allowCrossProviderFallback: false });
      await window.myself.savePrivacySettings({ dataCategories: { memory: false }, longTermMemory: false, proactivityMode: 'passive' });
      await window.myself.openChat();
    }, { baseUrl: provider.baseUrl, apiKey: provider.apiKey });
    await submitChatMessage(chat, '进入休息状态并一直保持');
    await expect.poll(() => fixture.getCharacterBehaviorProbe(), { timeout: 15_000 }).toMatchObject({
      stateId: 'state-2', actionId: 'state-2-action', playbackStatus: 'started'
    });
    expect(mainGate.isWaiting()).toBe(true);
    await expect(chat.getByText('好，我会继续休息。')).toHaveCount(0);
    mainGate.release();
    await expect(chat.getByText('好，我会继续休息。')).toBeVisible();
    await pet.evaluate(() => {
      const scope = globalThis as typeof globalThis & { __continuityStates?: string[] };
      scope.__continuityStates = [];
      window.myself.subscribeCharacterMotion(event => {
        if (event.type === 'behavior-action') scope.__continuityStates?.push(event.stateId);
      });
    });
    // 实际经过多个动画循环；断言事件流，而非只看开始与结束两个快照。
    await new Promise(resolveWait => setTimeout(resolveWait, 31_000));
    const states = await pet.evaluate(() => (globalThis as typeof globalThis & { __continuityStates?: string[] }).__continuityStates ?? []);
    expect(states.length).toBeGreaterThan(1);
    expect(states.every(state => state === 'state-2')).toBe(true);
    await submitChatMessage(chat, '播放一次开心动作');
    await expect.poll(() => fixture.getCharacterBehaviorProbe()).toMatchObject({ actionId: 'state-8-action', playbackStatus: 'started' });
    await expect.poll(() => fixture.getCharacterBehaviorProbe(), { timeout: 15_000 }).toMatchObject({ actionId: 'state-2-action', playbackStatus: 'started' });
    provider.assertComplete();
    expect(provider.inspectionErrors).toEqual([]);
  } catch (error) {
    console.log('连续表现诊断', JSON.stringify({ candidates: seenCandidates, requests: provider.requests, inspections: provider.inspectionErrors, logs: fixture.logs }));
    throw error;
  } finally {
    mainGate.release();
    await fixture.dispose();
    await provider.close();
  }
});

function expectCharacterChatRequest(
  request: Parameters<NonNullable<ProviderStep['inspect']>>[0]
): void {
  expect(request.tools.map(tool => tool.function.name)).toEqual(['request_task_authorization']);
  expect(request.toolChoice).toBe('auto');
  expect(request.responseFormatWasJsonObject).toBe(false);
}

async function loadElectronFixtureModule(): Promise<ElectronFixtureModule> {
  const moduleUrl = pathToFileURL(
    resolve(process.cwd(), 'tests/fixtures/electron-app.ts')
  ).href;
  return await import(moduleUrl) as ElectronFixtureModule;
}

type AppFixture = Awaited<ReturnType<ElectronFixtureModule['createElectronAppFixture']>>;

/** 只通过正式设置 IPC 配置隔离模型与授权根，后续任务必须由可见聊天 UI 发起。 */
async function configureCodingApp(fixture: AppFixture, provider: Awaited<ReturnType<typeof startProviderServer>>) {
  const pet = await waitForRendererPage(fixture, 'pet');
  const chat = await waitForRendererPage(fixture, 'chat');
  await pet.evaluate(async input => {
    await window.myself.saveProviderProfile({ profile: { id: 'coding-e2e', displayName: '正式任务 E2E', mode: 'custom', protocol: 'openai-compatible', baseUrl: input.baseUrl, modelId: 'coding-e2e-model', additionalParameters: {}, capabilities: ['chat', 'tools'] }, secret: input.apiKey, persistSecret: false });
    await window.myself.saveModelRoute({ primaryProfileId: 'coding-e2e', chatProfileId: 'coding-e2e', agentProfileId: 'coding-e2e', visionProfileId: null, fallbackProfileIds: [], allowCrossProviderFallback: false });
    await window.myself.savePrivacySettings({ dataCategories: { memory: false }, longTermMemory: false, proactivityMode: 'passive' });
    await window.myself.chooseAuthorizedRoot();
    await window.myself.openChat();
  }, { baseUrl: provider.baseUrl, apiKey: provider.apiKey });
  await expect.poll(() => chat.evaluate(() => document.visibilityState)).toBe('visible');
  return { pet, chat };
}

async function approveCodingScope(chat: Page) {
  const scope = chat.getByRole('article', { name: '本地任务授权' });
  await expect(scope).toBeVisible();
  await scope.getByRole('button', { name: '授权并开始任务' }).click();
}

async function recordCodingEvents(page: Page) {
  await page.evaluate(() => {
    const state = globalThis as typeof globalThis & { __task4bEvents?: TaskEvent[] };
    state.__task4bEvents = [];
    window.myself.onTaskEvent(event => state.__task4bEvents?.push(event));
  });
}

async function readCodingEvents(page: Page): Promise<TaskEvent[]> {
  return page.evaluate(() => (globalThis as typeof globalThis & { __task4bEvents?: TaskEvent[] }).__task4bEvents ?? []);
}

test.describe('正式 Core 任务 UI', () => {
  test('单一发送读取随机正文，范围前只有申请与零工具表现且普通发送仍聊天', async () => {
    test.setTimeout(120000);
    const nonce = `明确入口正文-${randomBytes(16).toString('hex')}`;
    const provider = await startProviderServer([
      behaviorBindingsStep(),
      ...taskAuthorizationSteps(),
      { response: codingResponse([{ name: 'read', args: { path: 'note.txt' }, id: 'explicit-read' }]) },
      { response: request => { const messages = request.messages as Array<{ tool_call_id?: string; content: string }>; expect(messages.find(message => message.tool_call_id === 'explicit-read')?.content).toContain(nonce); return codingResponse(nonce); } },
      ...characterChatSteps('普通聊天仍然可用', {}, {inspect: expectCharacterChatRequest})
    ]);
    let fixture: AppFixture | undefined;
    try {
      fixture = await (await loadElectronFixtureModule()).createElectronAppFixture({ workspaceRoot: resolve(process.cwd()), apiKey: provider.apiKey, logSentinels: [nonce] });
      await writeFile(join(fixture.authorizedRootDirectory, 'note.txt'), nonce);
      const { chat } = await configureCodingApp(fixture, provider);
      await chat.getByRole('textbox', { name: '和我说点什么' }).fill('note.txt 里面写了什么？');
      await chat.getByRole('button', { name: '发送给 AI Pet' }).click();
      const scope = chat.getByRole('article', { name: '本地任务授权' });
      await expect(scope).toContainText('coding-e2e-model');
      await expect(scope).toContainText(await realpath(fixture.authorizedRootDirectory));
      expect(coreRequestCount(provider)).toBe(0);
      await approveCodingScope(chat);
      await expect(chat.getByText(nonce, { exact: true })).toBeVisible();
      await expect(chat.locator('.phase-pill')).toHaveClass(/phase-success/u);
      await expect.poll(() => provider.remainingSteps()).toBe(2);
      await submitChatMessage(chat, '你好');
      await expect(chat.getByText('普通聊天仍然可用', { exact: true })).toBeVisible();
      await expect(scope).toHaveCount(0);
      provider.assertComplete();
      expect(provider.inspectionErrors).toEqual([]);
      expect(fixture.capturedLogEvidence).toEqual({ apiKey: false, authorizedRoot: false, authorizationHeader: false, sentinels: [false] });
    } finally { try { await fixture?.dispose(); } finally { await provider.close(); } }
  });

  test('重复操作卡仅继续一次并结束任务，随后普通拒绝仍只拒绝本次操作', async () => {
    test.setTimeout(120000);
    const nonce = `循环正文-${randomBytes(16).toString('hex')}`;
    const provider = await startProviderServer([
      behaviorBindingsStep(),
      ...taskAuthorizationSteps(),
      ...Array.from({ length: 4 }, (_, index) => ({ response: codingResponse([{ name: 'read', args: { path: 'note.txt' }, id: `ui-loop-${index}` }]) })),
      ...taskAuthorizationSteps(),
      { response: codingResponse([{ name: 'write', args: { path: 'note.txt', content: '禁止覆盖' }, id: 'ui-rejected' }]) },
      { response: codingResponse([{ name: 'read', args: { path: 'note.txt' }, id: 'ui-after-reject' }]), inspectRaw: request => { expect(JSON.stringify(request.messages)).toContain('rejected'); } },
      { response: request => { expect(JSON.stringify(request.messages)).toContain(nonce); return codingResponse('普通拒绝后继续读取成功'); } }
    ]);
    let fixture: AppFixture | undefined;
    try {
      fixture = await (await loadElectronFixtureModule()).createElectronAppFixture({ workspaceRoot: resolve(process.cwd()), apiKey: provider.apiKey, logSentinels: [nonce] });
      await writeFile(join(fixture.authorizedRootDirectory, 'note.txt'), nonce);
      const { chat } = await configureCodingApp(fixture, provider);
      await recordCodingEvents(chat);
      await submitChatMessage(chat, '读取 note.txt 文件');
      await expect(chat.getByRole('article', { name: '本地任务授权' })).toBeVisible();
      expect(coreRequestCount(provider)).toBe(0);
      await approveCodingScope(chat);
      const permission = chat.getByRole('region', { name: '具体操作许可' });
      await expect(permission).toContainText('重复操作保护');
      await expect(permission).toContainText('连续 3 次');
      await expect(permission).toContainText('read');
      expect(coreRequestCount(provider)).toBe(3);
      const third = (await readCodingEvents(chat)).find(event => event.type === 'task_permission_required');
      if (third?.type !== 'task_permission_required') throw new Error('缺少循环许可');
      expect(third.request).toEqual({ action: 'doom_loop', tool: 'read', repeatCount: 3 });
      await permission.getByRole('button', { name: '仅继续这一次' }).click();
      await expect(permission).toContainText('连续 4 次');
      expect(coreRequestCount(provider)).toBe(4);
      await expect(chat.evaluate(id => window.myself.confirmAction(id), third.actionId)).rejects.toThrow();
      await permission.getByRole('button', { name: '结束当前任务' }).click();
      await expect(chat.locator('.phase-pill')).toHaveClass(/phase-cancelled/u);
      await expect(permission).toHaveCount(0);
      await expect.poll(() => provider.requests.length).toBe(7);
      expect(await readFile(join(fixture.authorizedRootDirectory, 'note.txt'), 'utf8')).toBe(nonce);
      await submitChatMessage(chat, '修改 note.txt 文件');
      await approveCodingScope(chat);
      await expect(permission.getByRole('button', { name: '确认覆盖文件' })).toBeEnabled();
      await permission.getByRole('button', { name: '拒绝本次操作' }).click();
      await expect(chat.getByText('普通拒绝后继续读取成功', { exact: true })).toBeVisible();
      await expect(chat.locator('.phase-pill')).toHaveClass(/phase-success/u);
      expect(await readFile(join(fixture.authorizedRootDirectory, 'note.txt'), 'utf8')).toBe(nonce);
      await expect.poll(() => provider.remainingSteps()).toBe(0);
      provider.assertComplete();
      expect(provider.inspectionErrors).toEqual([]);
      expect(fixture.capturedLogEvidence).toEqual({ apiKey: false, authorizedRoot: false, authorizationHeader: false, sentinels: [false] });
    } finally { try { await fixture?.dispose(); } finally { await provider.close(); } }
  });
  test('自然读取随机正文经真实工具回注显示在聊天并结束', async () => {
    test.setTimeout(120000);
    const nonce = `读取正文-${randomBytes(16).toString('hex')}`;
    const coreGate = createProviderResponseGate();
    const provider = await startProviderServer([
      behaviorBindingsStep({ taskRunning: { stateId: 'state-6', actionId: 'state-6-action' }, success: { stateId: 'state-8', actionId: 'state-8-action' } }),
      ...taskAuthorizationSteps(),
      { response: codingResponse([{ name: 'read', args: { path: 'note.txt' }, id: 'ui-read' }]), gate: coreGate },
      { response: request => { const messages = request.messages as Array<{ role: string; tool_call_id?: string; content: string }>; const result = messages.find(message => message.tool_call_id === 'ui-read'); expect(result?.content).toContain(nonce); return codingResponse(nonce); } }
    ]);
    let fixture: AppFixture | undefined;
    try {
      fixture = await (await loadElectronFixtureModule()).createElectronAppFixture({ workspaceRoot: resolve(process.cwd()), apiKey: provider.apiKey, logSentinels: [nonce],
        enableSoftwareRasterizer: true, prepareUserData: async ({ userDataDirectory }) => {
          await new SettingsStore(join(userDataDirectory, 'settings.json')).saveMovementMode(0);
        } });
      await writeFile(join(fixture.authorizedRootDirectory, 'note.txt'), nonce);
      const { chat } = await configureCodingApp(fixture, provider);
      await submitChatMessage(chat, '请读取 note.txt 并告诉我里面的内容');
      const scope = chat.getByRole('article', { name: '本地任务授权' });
      await expect(scope).toContainText('coding-e2e-model');
      await expect(scope).toContainText(await realpath(fixture.authorizedRootDirectory));
      await expect.poll(() => provider.requests.length).toBe(3);
      expect(provider.requests.map(request => request.toolCount).sort()).toEqual([0, 0, 1]);
      expect(coreRequestCount(provider)).toBe(0);
      await approveCodingScope(chat);
      await expect.poll(() => coreGate.isWaiting()).toBe(true);
      await expect.poll(() => fixture!.getCharacterBehaviorProbe(), { timeout: 15_000 }).toMatchObject({
        stateId: 'state-6', actionId: 'state-6-action', playbackStatus: 'started'
      });
      await expect(chat.getByText(nonce, { exact: true })).toHaveCount(0);
      coreGate.release();
      await expect(chat.getByText(nonce, { exact: true })).toBeVisible();
      await expect(chat.locator('.phase-pill')).toHaveClass(/phase-success/u);
      await expect.poll(() => fixture!.getCharacterBehaviorProbe(), { timeout: 15_000 }).toMatchObject({
        stateId: 'state-8', actionId: 'state-8-action', playbackStatus: 'started'
      });
      await expect.poll(() => provider.remainingSteps()).toBe(0);
      provider.assertComplete();
      expect(provider.inspectionErrors).toEqual([]);
      expect(fixture.capturedLogEvidence).toEqual({ apiKey: false, authorizedRoot: false, authorizationHeader: false, sentinels: [false] });
    } finally { coreGate.release(); try { await fixture?.dispose(); } finally { await provider.close(); } }
  });

  test('scope 后具体删除许可可点击并经真实回收站与工具回注结束', async () => {
    test.setTimeout(120000);
    const nonce = `回收站正文-${randomBytes(16).toString('hex')}`;
    const finalText = `删除完成-${randomBytes(16).toString('hex')}`;
    const provider = await startProviderServer([
      behaviorBindingsStep(),
      ...taskAuthorizationSteps(),
      { response: codingResponse([{ name: 'apply_patch', args: { patchText: '*** Begin Patch\n*** Delete File: target.txt\n*** End Patch' }, id: 'ui-delete' }]) },
      { response: request => { const messages = request.messages as Array<{ tool_call_id?: string; content: string }>; expect(messages.find(message => message.tool_call_id === 'ui-delete')?.content).toContain('target.txt'); return codingResponse(finalText); } }
    ]);
    let fixture: AppFixture | undefined;
    try {
      fixture = await (await loadElectronFixtureModule()).createElectronAppFixture({ workspaceRoot: resolve(process.cwd()), apiKey: provider.apiKey, logSentinels: [nonce, finalText],
        prepareUserData: async ({ userDataDirectory }) => {
          // 删除验收隔离自主移动调度，终态由 Main 事件表达，不再发起 Provider 请求。
          await new SettingsStore(join(userDataDirectory, 'settings.json')).saveMovementMode(0);
        } });
      const target = join(fixture.authorizedRootDirectory, 'target.txt');
      await writeFile(target, nonce);
      const { chat, pet } = await configureCodingApp(fixture, provider);
      const settings = await waitForRendererPage(fixture, 'settings');
      await pet.evaluate(() => window.myself.openCharacterWorkshop());
      const characters = await waitForRendererPage(fixture, 'characters');
      await pet.evaluate(() => window.myself.openChat());
      for (const page of [pet, chat, settings, characters]) await recordCodingEvents(page);
      await submitChatMessage(chat, '删除 target.txt 文件');
      await expect(chat.getByRole('article', { name: '本地任务授权' })).toBeVisible();
      expect(coreRequestCount(provider)).toBe(0);
      expect(await pathExistsForAssertion(target)).toBe(true);
      await approveCodingScope(chat);
      const permission = chat.getByRole('region', { name: '具体操作许可' });
      await expect(permission).toContainText('target.txt');
      const confirm = permission.getByRole('button', { name: '确认移入回收站' });
      await expect(confirm).toBeEnabled();
      expect(await pathExistsForAssertion(target)).toBe(true);
      const event = (await readCodingEvents(chat)).find(event => event.type === 'task_permission_required');
      if (event?.type !== 'task_permission_required') throw new Error('未收到具体许可');
      const id = event.actionId;
      expect(Object.keys(event).sort()).toEqual(['actionId', 'request', 'summary', 'type']);
      for (const page of [pet, settings, characters]) await expect(page.evaluate(id => window.myself.confirmAction(id), id)).rejects.toThrow(/AGENT_IPC_SENDER_INVALID/u);
      await confirm.click();
      await expect(chat.getByText(finalText, { exact: true })).toBeVisible();
      await expect(chat.locator('.phase-pill')).toHaveClass(/phase-success/u);
      expect(await pathExistsForAssertion(target)).toBe(false);
      expect((await readdir(fixture.recycleBinDirectory!)).filter(name => name.startsWith('.attempt-'))).toEqual(['.attempt-1']);
      const petEvents = await readCodingEvents(pet);
      expect(petEvents.length).toBeGreaterThan(0);
      for (const event of petEvents) expect(Object.keys(event).sort()).toEqual(['phase', 'type']);
      expect(await readCodingEvents(settings)).toEqual([]);
      expect(await readCodingEvents(characters)).toEqual([]);
      await expect.poll(() => provider.remainingSteps()).toBe(0);
      provider.assertComplete();
      expect(provider.inspectionErrors).toEqual([]);
      expect(fixture.capturedLogEvidence).toEqual({ apiKey: false, authorizedRoot: false, authorizationHeader: false, sentinels: [false, false] });
    } finally { try { await fixture?.dispose(); } finally { await provider.close(); } }
  });
  for (const mode of ['新对话', '配置变更'] as const) {
    test(`具体许可等待中${mode}使旧 ID 失效且保留文件`, async () => {
      test.setTimeout(120000);
      const provider = await startProviderServer([
      behaviorBindingsStep(),
      ...taskAuthorizationSteps(),
        { response: codingResponse([{ name: 'write', args: { path: 'existing.txt', content: '不应覆盖' } }]) },
        behaviorBindingsStep(),
        ...characterChatSteps('新的普通聊天正常', {}, {inspect: expectCharacterChatRequest})
      ]);
      let fixture: AppFixture | undefined;
      try {
        fixture = await (await loadElectronFixtureModule()).createElectronAppFixture({ workspaceRoot: resolve(process.cwd()), apiKey: provider.apiKey });
        await writeFile(join(fixture.authorizedRootDirectory, 'existing.txt'), '原文件正文');
        const { chat, pet } = await configureCodingApp(fixture, provider);
        await chat.evaluate(() => { const state = globalThis as typeof globalThis & { __permissionId?: string }; window.myself.onTaskEvent(event => { if (event.type === 'task_permission_required') state.__permissionId = event.actionId; }); });
        await submitChatMessage(chat, '修改 existing.txt 文件');
        await approveCodingScope(chat);
        await expect(chat.getByRole('button', { name: '确认覆盖文件' })).toBeEnabled();
        const id = await chat.evaluate(() => (globalThis as typeof globalThis & { __permissionId?: string }).__permissionId!);
        if (mode === '配置变更') await pet.evaluate(() => window.myself.saveModelRoute({ primaryProfileId: 'coding-e2e', chatProfileId: 'coding-e2e', agentProfileId: 'coding-e2e', visionProfileId: null, fallbackProfileIds: [], allowCrossProviderFallback: false }));
        else await chat.getByRole('button', { name: mode, exact: true }).click();
        await expect(chat.getByRole('region', { name: '具体操作许可' })).toHaveCount(0);
        await expect(chat.evaluate(id => window.myself.confirmAction(id), id)).rejects.toThrow();
        expect(await readFile(join(fixture.authorizedRootDirectory, 'existing.txt'), 'utf8')).toBe('原文件正文');
        await submitChatMessage(chat, '现在聊聊天');
        await expect(chat.getByText('新的普通聊天正常', { exact: true })).toBeVisible();
        provider.assertComplete();
        expect(provider.inspectionErrors).toEqual([]);
      } finally { try { await fixture?.dispose(); } finally { await provider.close(); } }
    });
  }
  test('停止运行中的 SSE 任务清理旧请求，迟到正文不进入新聊天', async () => {
    test.setTimeout(120000);
    const gate = createProviderResponseGate();
    const provider = await startProviderServer([
      behaviorBindingsStep(),
      ...taskAuthorizationSteps(),
      { response: codingResponse([{ name: 'read', args: { path: 'note.txt' } }]) },
      { response: codingResponse('迟到正文不应显示'), gate },
      ...characterChatSteps('取消后普通聊天正常', {}, {inspect: expectCharacterChatRequest})
    ]);
    let fixture: AppFixture | undefined;
    try {
      fixture = await (await loadElectronFixtureModule()).createElectronAppFixture({ workspaceRoot: resolve(process.cwd()), apiKey: provider.apiKey });
      await writeFile(join(fixture.authorizedRootDirectory, 'note.txt'), '取消任务正文');
      const { chat } = await configureCodingApp(fixture, provider);
      await submitChatMessage(chat, '读取 note.txt');
      await approveCodingScope(chat);
      await expect.poll(() => gate.isWaiting()).toBe(true);
      await chat.getByRole('button', { name: '停止当前任务' }).click();
      await expect(chat.locator('.phase-pill')).toHaveClass(/phase-cancelled/u);
      await expect.poll(() => gate.isWaiting()).toBe(false);
      await expect.poll(() => provider.requests.length).toBe(5);
      await submitChatMessage(chat, '现在聊聊天');
      await expect(chat.getByText('取消后普通聊天正常', { exact: true })).toBeVisible();
      await expect(chat.getByText('迟到正文不应显示', { exact: true })).toHaveCount(0);
      provider.assertComplete();
      expect(provider.inspectionErrors).toEqual([]);
    } finally { gate.release(); try { await fixture?.dispose(); } finally { await provider.close(); } }
  });
});

type PetPlacementForE2e = Readonly<{
  characterId: string;
  scale: number;
  footAnchorDip: Readonly<{ x: number; y: number }>;
  displayId: string;
}>;

/** 在 Renderer 内组合真实窗口、Canvas 与当前动作，只向测试进程返回脚底一致布尔值。 */
async function renderedFootMatchesPlacement(
  page: Page,
  placement: PetPlacementForE2e,
  expectedActionId?: string
): Promise<boolean> {
  return page.evaluate(async input => {
    const [runtime, motion, behavior] = await Promise.all([
      window.myself.getCharacterRuntimeSnapshot(),
      window.myself.getCharacterMotionSnapshot(),
      window.myself.getCharacterBehaviorProbe?.()
    ]);
    const actionId = input.expectedActionId ?? behavior?.actionId;
    // 正式运行视图已解析当前皮肤表现，不再从旧 V2 状态内读取动作。
    const action = runtime?.manifest.presentations
      .find(candidate => candidate.actionId === actionId)?.presentation;
    const canvas = document.querySelector<HTMLCanvasElement>(
      '.character-player-host canvas'
    );
    if (!action || !canvas || action.frames.length === 0) return false;

    const canvasBounds = canvas.getBoundingClientRect();
    const sourceWidth = Math.max(1, ...action.frames.map(frame => frame.width));
    const sourceHeight = Math.max(1, ...action.frames.map(frame => frame.height));
    const fitScale = Math.min(
      canvasBounds.width / sourceWidth,
      canvasBounds.height / sourceHeight
    );
    const fittedWidth = sourceWidth * fitScale;
    const fittedHeight = sourceHeight * fitScale;
    const ground = motion.direction === 'left'
      ? { x: 1 - action.anchors.ground.x, y: action.anchors.ground.y }
      : action.anchors.ground;
    const clamp = (value: number, minimum: number, maximum: number): number => (
      Math.min(maximum, Math.max(minimum, value))
    );
    const groundInCanvas = {
      x: clamp(
        canvasBounds.width / 2,
        fittedWidth * ground.x,
        canvasBounds.width - fittedWidth * (1 - ground.x)
      ),
      y: clamp(
        canvasBounds.height,
        fittedHeight * ground.y,
        canvasBounds.height - fittedHeight * (1 - ground.y)
      )
    };
    const toleranceDip = 1.1;
    return Math.abs(
      window.screenX + canvasBounds.left + groundInCanvas.x - input.footAnchorDip.x
    ) <= toleranceDip && Math.abs(
      window.screenY + canvasBounds.top + groundInCanvas.y - input.footAnchorDip.y
    ) <= toleranceDip;
  }, {
    footAnchorDip: placement.footAnchorDip,
    expectedActionId
  });
}

/** 统一从当前 Electron 生命周期中查找 Renderer，避免旧窗口被重启后的场景复用。 */
function rendererPages(fixture: AppFixture): Page[] {
  return fixture.browser.contexts().flatMap(context => context.pages());
}

function rendererPage(fixture: AppFixture, view: string): Page | undefined {
  return rendererPages(fixture).find(page => {
    if (page.isClosed()) return false;
    try {
      return new URL(page.url()).searchParams.get('view') === view;
    } catch {
      return false;
    }
  });
}

async function waitForRendererPage(
  fixture: AppFixture,
  view: string,
  timeout?: number
): Promise<Page> {
  await expect.poll(
    () => Boolean(rendererPage(fixture, view)),
    timeout === undefined ? undefined : { timeout }
  ).toBe(true);
  const page = rendererPage(fixture, view);
  if (!page) throw new Error(`缺少 ${view} Renderer`);
  return page;
}

test.describe('直接启动 Electron 的 CDP 夹具边界', () => {
  test('实际启动的 Main 回报当前提交与非路径构建根类别', async () => {
    test.setTimeout(60_000);
    const workspaceRoot = resolve(process.cwd());
    const [{ stdout: commitOutput }, { stdout: gitDirectoryOutput }, {
      stdout: commonDirectoryOutput
    }] = await Promise.all([
      execFileAsync('git', ['-C', workspaceRoot, 'rev-parse', '--short=12', 'HEAD'], {
        windowsHide: true, encoding: 'utf8'
      }),
      execFileAsync('git', ['-C', workspaceRoot, 'rev-parse', '--path-format=absolute', '--git-dir'], {
        windowsHide: true, encoding: 'utf8'
      }),
      execFileAsync('git', [
        '-C', workspaceRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'
      ], { windowsHide: true, encoding: 'utf8' })
    ]);
    const expected = {
      commitShortHash: commitOutput.trim(),
      buildRootCategory: gitDirectoryOutput.trim() === commonDirectoryOutput.trim()
        ? 'primary_checkout' as const
        : 'linked_worktree' as const
    };
    const fixtureModule = await loadElectronFixtureModule();
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey: runtimeDiagnosticKey(),
      launchTimeoutMs: 15_000
    });
    try {
      await waitForRendererPage(fixture, 'pet', 15_000);
      await expect.poll(async () => (await fixture.getMainE2eState()).buildIdentity)
        .toEqual(expected);
      expect(JSON.stringify(await fixture.getMainE2eState())).not.toContain(workspaceRoot);
    } finally {
      await fixture.dispose();
    }
  });

  test('使用项目精确 Electron 路径、构建入口、随机回环 CDP 参数和隔离环境', async () => {
    const fixture = await loadElectronFixtureModule();

    const workspaceRoot = resolve(process.cwd());
    const userDataDirectory = resolve('C:\\Temp\\myself-user-data');
    const authorizedRootDirectory = resolve('C:\\Temp\\myself-authorized-root');
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const plan = fixture.createElectronLaunchPlan({
      workspaceRoot,
      cdpPort: 43123,
      userDataDirectory,
      authorizedRootDirectory,
      parentEnvironment: { PATH: process.env['PATH'] }
    });

    expect(plan.executablePath).toBe(expectedExecutable);
    expect(plan.applicationEntry).toBe(resolve(workspaceRoot, 'apps/desktop/out/main/index.js'));
    expect(plan.cdpEndpoint).toBe('http://127.0.0.1:43123');
    expect(plan.args).toEqual([
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=43123',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-sandbox',
      plan.applicationEntry
    ]);
    expect(plan.args.join(' ')).not.toMatch(/--inspect(?:-brk)?(?:=|\s|$)/u);
    expect(plan.environment).toMatchObject({
      MYSELF_E2E: '1',
      MYSELF_E2E_USER_DATA: userDataDirectory,
      MYSELF_E2E_AUTHORIZED_ROOT: authorizedRootDirectory
    });
    expect(Object.keys(plan.environment)).not.toContain('MYSELF_E2E_EXPLORER_SCRIPT');

    const visualPlan = fixture.createElectronLaunchPlan({
      workspaceRoot,
      cdpPort: 43124,
      userDataDirectory,
      authorizedRootDirectory,
      parentEnvironment: { PATH: process.env['PATH'] },
      enableSoftwareRasterizer: true
    });
    expect(visualPlan.args).not.toContain('--disable-software-rasterizer');
  });

  test('拒绝非回环 CDP 端点且等待使用有界超时', async () => {
    const fixture = await loadElectronFixtureModule();

    await expect(fixture.waitForCdpReady({
      endpoint: 'http://0.0.0.0:9222',
      timeoutMs: 20,
      probe: async () => true
    })).rejects.toThrow('CDP_ENDPOINT_NOT_LOOPBACK');

    const startedAt = Date.now();
    await expect(fixture.waitForCdpReady({
      endpoint: 'http://127.0.0.1:43123',
      timeoutMs: 20,
      intervalMs: 1,
      probe: async () => false
    })).rejects.toThrow('CDP_READY_TIMEOUT');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test('应用退出检查在 exit 后继续等待 stdio close', async () => {
    const fixture = await loadElectronFixtureModule();
    const process = new EventEmitter();
    let closed = false;
    const observed = fixture.observeElectronProcessStreamsClosed(process)
      .then(() => { closed = true; });

    process.emit('exit', 0, null);
    await Promise.resolve();
    expect(closed).toBe(false);

    process.emit('close', 0, null);
    await observed;
    expect(closed).toBe(true);
  });

  test('捕获日志时清除 API Key、Authorization Header 和授权根绝对路径', async () => {
    const fixture = await loadElectronFixtureModule();

    const apiKey = runtimeDiagnosticKey();
    const authorizedRootDirectory = 'C:\\Temp\\myself-authorized-root';
    const userDataDirectory = 'C:\\Temp\\ai-pet-user-data';
    const characterAssetsDirectory = 'C:\\Temp\\ai-pet-assets';
    const safeCharacterPackage = 'C:\\Temp\\safe-character.zip';
    const maliciousCharacterPackage = 'C:\\Temp\\malicious-character.zip';
    const characterExportDestination = 'C:\\Temp\\exported-character.zip';
    const sanitized = fixture.redactElectronLog(
      [
        `Authorization: Bearer ${apiKey}`,
        `root=${authorizedRootDirectory}`,
        `key=${apiKey}`,
        userDataDirectory,
        characterAssetsDirectory,
        safeCharacterPackage,
        maliciousCharacterPackage,
        characterExportDestination
      ].join('\n'),
      {
        apiKey,
        authorizedRootDirectory,
        userDataDirectory,
        characterAssetsDirectory,
        safeCharacterPackage,
        maliciousCharacterPackage,
        characterExportDestination
      }
    );

    const leakFlags = [
      apiKey,
      authorizedRootDirectory,
      userDataDirectory,
      characterAssetsDirectory,
      safeCharacterPackage,
      maliciousCharacterPackage,
      characterExportDestination
    ].map(value => sanitized.includes(value));
    expect(leakFlags).toEqual([false, false, false, false, false, false, false]);
    expect(/Authorization\s*:/iu.test(sanitized)).toBe(false);
    expect(sanitized).toContain('[已脱敏]');
  });

  test('跨 chunk 拆分的动态 key、Authorization Header 与授权根在所有可观察诊断中仍脱敏', async () => {
    const fixtureModule = await loadElectronFixtureModule();

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const fakeProcess = fakeElectronProcess(6050, expectedExecutable);
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-split-secret');
    const authorizedRootDirectory = resolve(baseDirectory, 'authorized-root-secret');
    const apiKey = runtimeDiagnosticKey();
    let closeCalls = 0;
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey,
      operationTimeoutMs: 20,
      dependencies: {
        allocateLoopbackPort: async () => 43133,
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory: resolve(baseDirectory, 'user-data'),
          authorizedRootDirectory
        }),
        spawnProcess: () => {
          queueMicrotask(() => {
            fakeProcess.stdout.write('Authori');
            fakeProcess.stderr.write(`zation: Bearer ${apiKey.slice(0, 11)}`);
            fakeProcess.stdout.write(`${apiKey.slice(11, 35)}`);
            fakeProcess.stderr.write(`${apiKey.slice(35)}\nroot=${authorizedRootDirectory.slice(0, 17)}`);
            fakeProcess.stdout.write(authorizedRootDirectory.slice(17));
          });
          return fakeProcess;
        },
        waitForReady: async () => undefined,
        connectOverCdp: async () => ({
          close: () => {
            closeCalls += 1;
            return closeCalls === 1
              ? new Promise<void>(() => undefined)
              : Promise.resolve();
          }
        }),
        terminateProcess: async child => emitFakeExit(child, 0),
        removeTemporaryBase: async () => undefined
      }
    });

    let caught: unknown;
    try {
      await fixture.dispose();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);

    const observableText = [
      fixture.logs.join(''),
      String(caught),
      caught instanceof Error ? caught.message : '',
      caught instanceof Error ? caught.stack ?? '' : ''
    ].join('\n');
    expect([
      observableText.includes(apiKey),
      observableText.includes(authorizedRootDirectory),
      /Authorization\s*:/iu.test(observableText)
    ]).toEqual([false, false, false]);
    expect(observableText).toContain('[已脱敏]');

    await fixture.dispose();
  });

  test('原始日志证据仅在同一流跨块匹配，并识别普通与 JSON Authorization', async () => {
    const fixture = await loadElectronFixtureModule();

    const apiKey = 'tracker-api-key';
    const authorizedRootDirectory = resolve('C:\\Temp\\tracker-authorized-root');
    const sameStreamSentinel = 'same-stream-sentinel';
    const crossStreamSentinel = 'cross-stream-sentinel';
    const sameStream = fixture.createCapturedLogEvidenceTracker({
      apiKey,
      authorizedRootDirectory,
      sentinels: [sameStreamSentinel]
    });
    sameStream.capture('stdout', sameStreamSentinel.slice(0, 8));
    sameStream.capture('stdout', sameStreamSentinel.slice(8));

    const crossStream = fixture.createCapturedLogEvidenceTracker({
      apiKey,
      authorizedRootDirectory,
      sentinels: [crossStreamSentinel]
    });
    crossStream.capture('stdout', crossStreamSentinel.slice(0, 9));
    crossStream.capture('stderr', crossStreamSentinel.slice(9));

    const textHeader = fixture.createCapturedLogEvidenceTracker({
      apiKey,
      authorizedRootDirectory,
      sentinels: []
    });
    textHeader.capture('stdout', `Authorization: Bearer ${apiKey}`);
    const jsonHeader = fixture.createCapturedLogEvidenceTracker({
      apiKey,
      authorizedRootDirectory,
      sentinels: []
    });
    jsonHeader.capture('stderr', `{"authorization":"Bearer ${apiKey}"}`);

    expect([
      sameStream.snapshot().sentinels[0],
      crossStream.snapshot().sentinels[0],
      textHeader.snapshot().authorizationHeader,
      jsonHeader.snapshot().authorizationHeader
    ]).toEqual([true, false, true, true]);
  });

  test('六个任务正文 sentinel 的模拟 console 泄漏都会使原始证据断言变红', async () => {
    const fixture = await loadElectronFixtureModule();

    const sentinels = [
      'task6-user-body-sentinel',
      'task6-model-body-sentinel',
      'task6-file-body-sentinel',
      "Write-Output task6-stdout-sentinel; [Console]::Error.Write('task6-stderr-sentinel')",
      'task6-stdout-sentinel',
      'task6-stderr-sentinel'
    ];
    const tracker = fixture.createCapturedLogEvidenceTracker({
      apiKey: 'task6-sensitivity-key',
      authorizedRootDirectory: resolve('C:\\Temp\\task6-sensitivity-root'),
      sentinels
    });

    for (const sentinel of sentinels) tracker.capture('stdout', sentinel);

    expect(tracker.snapshot().sentinels).toEqual(sentinels.map(() => true));
  });

  test('原始日志证据在 UTF-8 多字节中间拆分 Buffer 时仍命中', async () => {
    const fixture = await loadElectronFixtureModule();

    const apiKey = '密钥-api';
    const authorizedRootDirectory = 'C:\\授权根';
    const sentinel = '中文哨兵';
    const tracker = fixture.createCapturedLogEvidenceTracker({
      apiKey,
      authorizedRootDirectory,
      sentinels: [sentinel]
    });
    const apiKeyBytes = Buffer.from(apiKey);
    tracker.capture('stdout', apiKeyBytes.subarray(0, 1));
    tracker.capture('stdout', apiKeyBytes.subarray(1));
    const authorizedRootBytes = Buffer.from(authorizedRootDirectory);
    tracker.capture('stdout', authorizedRootBytes.subarray(0, 4));
    tracker.capture('stdout', authorizedRootBytes.subarray(4));
    const sentinelBytes = Buffer.from(sentinel);
    tracker.capture('stdout', sentinelBytes.subarray(0, 1));
    tracker.capture('stdout', sentinelBytes.subarray(1));

    const resetSentinel = '跨期哨兵';
    const resetTracker = fixture.createCapturedLogEvidenceTracker({
      apiKey,
      authorizedRootDirectory,
      sentinels: [resetSentinel]
    });
    const resetSentinelBytes = Buffer.from(resetSentinel);
    resetTracker.capture('stdout', resetSentinelBytes.subarray(0, 1));
    resetTracker.resetStreams();
    resetTracker.capture('stdout', resetSentinelBytes.subarray(1));

    const snapshot = tracker.snapshot();
    expect([
      snapshot.apiKey,
      snapshot.authorizedRoot,
      snapshot.sentinels[0],
      resetTracker.snapshot().sentinels[0]
    ]).toEqual([true, true, true, false]);
  });

  test('原始日志证据构造后不受输入对象与外部哨兵数组突变影响', async () => {
    const fixture = await loadElectronFixtureModule();

    const originalApiKey = 'original-tracker-api-key';
    const originalRoot = 'C:\\original-tracker-root';
    const originalSentinel = `original-sentinel-${'x'.repeat(80)}`;
    const externalSentinels = [originalSentinel];
    const mutableInput = {
      apiKey: originalApiKey,
      authorizedRootDirectory: originalRoot,
      sentinels: externalSentinels
    };
    const tracker = fixture.createCapturedLogEvidenceTracker(mutableInput);
    mutableInput.apiKey = 'replacement-api-key';
    mutableInput.authorizedRootDirectory = 'C:\\replacement-root';
    externalSentinels[0] = 'replacement-sentinel';
    externalSentinels.push('appended-sentinel');

    tracker.capture('stdout', originalApiKey);
    tracker.capture('stdout', originalRoot);
    tracker.capture('stdout', originalSentinel.slice(0, 70));
    tracker.capture('stdout', originalSentinel.slice(70));

    expect(tracker.snapshot()).toEqual({
      apiKey: true,
      authorizedRoot: true,
      authorizationHeader: false,
      sentinels: [true]
    });
  });

  test('原始日志证据拒绝空哨兵，返回冻结布尔快照且 dispose 后不再变化', async () => {
    const fixture = await loadElectronFixtureModule();

    expect(() => fixture.createCapturedLogEvidenceTracker({
      apiKey: 'tracker-api-key',
      authorizedRootDirectory: resolve('C:\\Temp\\tracker-authorized-root'),
      sentinels: ['']
    })).toThrow('EMPTY_LOG_SENTINEL');

    const sentinel = 'dispose-sentinel';
    const tracker = fixture.createCapturedLogEvidenceTracker({
      apiKey: 'tracker-api-key',
      authorizedRootDirectory: resolve('C:\\Temp\\tracker-authorized-root'),
      sentinels: [sentinel]
    });
    tracker.capture('stdout', sentinel.slice(0, 7));
    const beforeDispose = tracker.snapshot();
    tracker.dispose();
    tracker.capture('stdout', sentinel.slice(7));
    tracker.capture('stderr', 'Authorization: Bearer tracker-api-key');
    const afterDispose = tracker.snapshot();

    expect(afterDispose).toEqual(beforeDispose);
    expect({
      snapshot: Object.isFrozen(afterDispose),
      sentinels: Object.isFrozen(afterDispose.sentinels),
      booleans: [
        afterDispose.apiKey,
        afterDispose.authorizedRoot,
        afterDispose.authorizationHeader,
        ...afterDispose.sentinels
      ].every(value => typeof value === 'boolean')
    }).toEqual({ snapshot: true, sentinels: true, booleans: true });
  });

  test('动态 canary 检查覆盖最早日志且捕获溢出时失败关闭', async () => {
    const fixture = await loadElectronFixtureModule();
    const canary = 'dynamic-token-discovered-after-process-start';
    const complete = fixture.createCompleteLogCanaryTracker(128);
    complete.capture('stderr', canary);
    complete.capture('stdout', 'x'.repeat(80));
    expect(complete.inspect([canary])).toEqual([true]);

    complete.capture('stdout', 'y'.repeat(80));
    expect(() => complete.inspect([canary])).toThrow('RAW_LOG_CAPTURE_LIMIT_EXCEEDED');
  });

  test('原始对象递归扫描能识别 JSON 转义 Windows 路径与 file URL 路径', async () => {
    const fixture = await loadElectronFixtureModule();
    const jsonPath = 'C:\\Private\\LocalModel\\json-runtime.exe';
    const fileUrlPath = 'C:\\Private\\Local Model\\url-runtime.exe';
    const artifacts = [{
      main: { rawJsonLog: JSON.stringify({ path: jsonPath }) },
      renderer: [{ status: 'file:///c:/private/local%20model/url-runtime.exe' }]
    }];

    expect(fixture.inspectPrivateArtifactCanaries(
      artifacts,
      [jsonPath, fileUrlPath, 'not-present-canary']
    )).toEqual([true, true, false]);

    const mainRawLogs = fixture.createCompleteLogCanaryTracker(4_096);
    mainRawLogs.capture('stdout', JSON.stringify({ path: jsonPath }));
    mainRawLogs.capture('stderr', 'file:///c:/private/local%20model/url-runtime.exe');
    expect(mainRawLogs.inspect([jsonPath, fileUrlPath])).toEqual([true, true]);
  });

  test('自然退出宽限期内 child 退出时不启动任何强制清理', async () => {
    const fixture = await loadElectronFixtureModule();

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6105, executablePath);
    let spawnCalls = 0;
    let probeCalls = 0;
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };
    const naturalExit = setTimeout(() => {
      child.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
    }, 5);

    try {
      await fixture.terminateElectronProcess(child, executablePath, {
        platform: 'win32',
        gracefulExitTimeoutMs: 20,
        taskkillTimeoutMs: 20,
        processExitTimeoutMs: 10,
        spawnCommand: () => {
          spawnCalls += 1;
          const command = Object.assign(new EventEmitter(), {
            exitCode: null as number | null
          });
          setTimeout(() => emitFakeExit(command, 0), 10);
          return command;
        },
        processProbe: async () => {
          probeCalls += 1;
          return { status: 'running', executablePath };
        }
      });
    } finally {
      clearTimeout(naturalExit);
    }

    expect(spawnCalls).toBe(0);
    expect(probeCalls).toBe(0);
    expect(killCalls).toBe(0);
    expect(child.signalCode).toBe('SIGTERM');
  });

  test('taskkill 非零时仅回退终止原 PID，并确认原 child 退出', async () => {
    const fixture = await loadElectronFixtureModule();

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6101, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    const commandCalls: Array<{ file: string; args: string[] }> = [];
    const killSignals: Array<NodeJS.Signals | number | undefined> = [];
    child.kill = signal => {
      killSignals.push(signal);
      queueMicrotask(() => emitFakeExit(child, 137));
      return true;
    };

    await fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 20,
      processExitTimeoutMs: 20,
      processProbe: async () => ({ status: 'running', executablePath }),
      spawnCommand: (file, args) => {
        commandCalls.push({ file, args });
        queueMicrotask(() => emitFakeExit(command, 1));
        return command;
      }
    });

    expect(commandCalls).toEqual([{
      file: 'taskkill.exe',
      args: ['/PID', '6101', '/T', '/F']
    }]);
    expect(killSignals).toEqual(['SIGKILL']);
    expect(child.exitCode).toBe(137);
  });

  test('taskkill 异步报错后原 PID 已消失时成功收敛并清理监听器', async () => {
    const fixture = await loadElectronFixtureModule();

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6107, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    let probeCalls = 0;
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 20,
      processExitTimeoutMs: 10,
      processProbe: async () => {
        probeCalls += 1;
        return probeCalls === 1
          ? { status: 'running', executablePath }
          : { status: 'absent' };
      },
      spawnCommand: () => {
        queueMicrotask(() => command.emit('error', new Error('TASKKILL_ASYNC_FAILED')));
        return command;
      }
    });

    expect(probeCalls).toBe(2);
    expect(killCalls).toBe(0);
    expect(command.listenerCount('exit')).toBe(0);
    expect(command.listenerCount('error')).toBe(0);
  });

  test('taskkill 异步报错后原 PID 仍精确匹配时安全回退并脱敏诊断', async () => {
    const fixture = await loadElectronFixtureModule();

    const apiKey = runtimeDiagnosticKey();
    const authorizedRootDirectory = resolve(
      'C:\\Temp',
      apiKey,
      'authorized-root'
    );
    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6108, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    let killCalls = 0;
    child.kill = signal => {
      expect(signal).toBe('SIGKILL');
      killCalls += 1;
      return true;
    };

    let thrownError: unknown;
    try {
      await fixture.terminateElectronProcess(child, executablePath, {
        platform: 'win32',
        gracefulExitTimeoutMs: 1,
        taskkillTimeoutMs: 20,
        processExitTimeoutMs: 5,
        probeIntervalMs: 1,
        processProbe: async () => ({ status: 'running', executablePath }),
        spawnCommand: () => {
          queueMicrotask(() => command.emit(
            'error',
            new Error(
              `Authorization: Bearer ${apiKey}\n`
              + `root=${authorizedRootDirectory}\n`
              + 'TASKKILL_ASYNC_FAILED'
            )
          ));
          return command;
        }
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    const diagnostic = (thrownError as Error).message;
    expect(diagnostic).toContain('ELECTRON_PROCESS_STILL_RUNNING:6108:TASKKILL_FAILED:');
    expect(diagnostic).toContain('[已脱敏]');
    expect(diagnostic).not.toContain(apiKey);
    expect(diagnostic).not.toContain(authorizedRootDirectory);
    expect(diagnostic).not.toContain('Authorization:');
    expect(killCalls).toBe(1);
    expect(command.listenerCount('exit')).toBe(0);
    expect(command.listenerCount('error')).toBe(0);
  });

  test('OS 进程探针：grace 后 PID 不存在时不得启动 taskkill', async () => {
    const fixture = await loadElectronFixtureModule();

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6110, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    let spawnCalls = 0;
    let killCalls = 0;
    let probeCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 20,
      processExitTimeoutMs: 10,
      spawnCommand: () => {
        spawnCalls += 1;
        queueMicrotask(() => emitFakeExit(command, 255));
        return command;
      },
      processProbe: async processId => {
        expect(processId).toBe(6110);
        probeCalls += 1;
        return { status: 'absent' };
      }
    });

    expect(probeCalls).toBe(1);
    expect(spawnCalls).toBe(0);
    expect(killCalls).toBe(0);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });

  test('OS 进程探针：默认预算覆盖 PowerShell 冷启动后仍能确认 PID 不存在', async () => {
    const fixture = await loadElectronFixtureModule();

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6114, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 20,
      processExitTimeoutMs: 10,
      spawnCommand: () => {
        queueMicrotask(() => emitFakeExit(command, 255));
        return command;
      },
      processProbe: () => new Promise(resolveProbe => {
        // 模拟本机 PowerShell 冷启动耗时超过旧的 750ms 默认预算。
        setTimeout(() => resolveProbe({ status: 'absent' }), 800);
      })
    });

    expect(killCalls).toBe(0);
  });

  test('OS 进程探针：精确项目进程仍存活时才 fallback，并轮询至 PID 不存在', async () => {
    const fixture = await loadElectronFixtureModule();

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6111, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    let killCalls = 0;
    let probeCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 20,
      processExitTimeoutMs: 30,
      probeIntervalMs: 1,
      spawnCommand: () => {
        queueMicrotask(() => emitFakeExit(command, 255));
        return command;
      },
      processProbe: async () => {
        probeCalls += 1;
        return probeCalls <= 2
          ? { status: 'running', executablePath }
          : { status: 'absent' };
      }
    });

    expect(killCalls).toBe(1);
    expect(probeCalls).toBe(3);
    expect(child.exitCode).toBeNull();
  });

  test('OS 进程探针：PID 被其他路径复用时不得 kill 新进程', async () => {
    const fixture = await loadElectronFixtureModule();

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6112, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    const diagnostics: string[] = [];
    let spawnCalls = 0;
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 20,
      processExitTimeoutMs: 10,
      spawnCommand: () => {
        spawnCalls += 1;
        queueMicrotask(() => emitFakeExit(command, 255));
        return command;
      },
      processProbe: async () => ({
        status: 'running',
        executablePath: resolve('C:\\other\\not-electron.exe')
      }),
      onDiagnostic: message => diagnostics.push(message)
    });

    expect(spawnCalls).toBe(0);
    expect(killCalls).toBe(0);
    expect(diagnostics).toEqual(['ELECTRON_PROCESS_PID_REUSED:6112']);
    expect(diagnostics.join('')).not.toContain('not-electron.exe');
  });

  test('OS 进程探针：访问失败或路径不可验证时不 kill 并明确失败', async () => {
    const fixture = await loadElectronFixtureModule();

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6113, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    let spawnCalls = 0;
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await expect(fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 20,
      processExitTimeoutMs: 10,
      spawnCommand: () => {
        spawnCalls += 1;
        queueMicrotask(() => emitFakeExit(command, 255));
        return command;
      },
      processProbe: async () => { throw new Error('ACCESS_DENIED'); }
    })).rejects.toThrow('ELECTRON_PROCESS_PROBE_FAILED:6113');
    expect(spawnCalls).toBe(0);
    expect(killCalls).toBe(0);
  });

  test('OS 进程探针：退出期间路径短暂不可用时有限重试且不误杀', async () => {
    const fixture = await loadElectronFixtureModule();

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6118, executablePath);
    let probeCalls = 0;
    let spawnCalls = 0;
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      probeIntervalMs: 1,
      probeTimeoutMs: 20,
      processProbe: async () => {
        probeCalls += 1;
        if (probeCalls < 3) {
          throw new Error('WINDOWS_PROCESS_PATH_TEMPORARILY_UNAVAILABLE');
        }
        return { status: 'absent' };
      },
      spawnCommand: () => {
        spawnCalls += 1;
        throw new Error('不应启动 taskkill');
      }
    });

    expect(probeCalls).toBe(3);
    expect(spawnCalls).toBe(0);
    expect(killCalls).toBe(0);
  });

  test('Main 后代进程探针能从人为进程树发现 bridge PowerShell 子进程', async () => {
    const fixture = await loadElectronFixtureModule();

    const descendants = await fixture.inspectWindowsElectronDescendants(6114, {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify([
          { ProcessId: 6114, ParentProcessId: 100, Name: 'electron.exe', CommandLine: 'app' },
          { ProcessId: 6115, ParentProcessId: 6114, Name: 'electron.exe', CommandLine: 'renderer' },
          {
            ProcessId: 6116,
            ParentProcessId: 6115,
            Name: 'powershell.exe',
            CommandLine: 'powershell.exe -File explorer-space-bridge.ps1'
          },
          {
            ProcessId: 7000,
            ParentProcessId: 999,
            Name: 'powershell.exe',
            CommandLine: 'unrelated.ps1'
          }
        ]),
        stderr: ''
      })
    });

    expect(descendants).toEqual([
      { processId: 6115, name: 'electron.exe', powershell: false, explorerBridge: false },
      { processId: 6116, name: 'powershell.exe', powershell: true, explorerBridge: true }
    ]);
  });

  test('跨 Provider 诊断同时清除附加密钥', async () => {
    const fixtureModule = await loadElectronFixtureModule();
    const primaryKey = runtimeDiagnosticKey();
    const secondaryKey = runtimeDiagnosticKey();
    const sanitized = fixtureModule.redactElectronLog(
      `primary=${primaryKey}; secondary=${secondaryKey}`,
      {
        apiKey: primaryKey,
        additionalSecrets: [secondaryKey],
        authorizedRootDirectory: resolve('fixture-authorized-root')
      }
    );

    expect(sanitized.includes(primaryKey), '主 Provider 密钥必须脱敏').toBe(false);
    expect(sanitized.includes(secondaryKey), '附加 Provider 密钥必须脱敏').toBe(false);
  });

  test('默认 OS 进程探针：命令失败诊断保留退出码并截断脱敏 stderr', async () => {
    const fixture = await loadElectronFixtureModule();

    const apiKey = runtimeDiagnosticKey();
    const authorizedRootDirectory = resolve(
      'C:\\Temp\\myself-e2e-probe-diagnostic\\authorized-root'
    );
    const rawStderr = [
      `Authorization: Bearer ${apiKey}`,
      `root=${authorizedRootDirectory}`,
      'x'.repeat(5_000)
    ].join('\n');
    let caught: unknown;
    try {
      await fixture.probeWindowsProcess(6114, {
        runCommand: async () => ({
          exitCode: 7,
          stdout: '',
          stderr: rawStderr
        })
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('WINDOWS_PROCESS_PROBE_COMMAND_FAILED:exit=7');
    expect(message).toContain('[已脱敏]');
    expect(message).not.toContain(apiKey);
    expect(message).not.toContain(authorizedRootDirectory);
    expect(message).not.toMatch(/Authorization\s*:/iu);
    expect(message.length).toBeLessThan(1_200);
  });

  test('默认 OS 进程探针：退出期间空路径映射为可重试过渡态', async () => {
    const fixture = await loadElectronFixtureModule();

    await expect(fixture.probeWindowsProcess(6119, {
      runCommand: async () => ({
        exitCode: 4,
        stdout: '',
        stderr: ''
      })
    })).rejects.toThrow('WINDOWS_PROCESS_PATH_TEMPORARILY_UNAVAILABLE');
  });

  test('默认 OS 进程探针：AbortSignal 传给 runner 并等待取消回调 settle', async () => {
    const fixture = await loadElectronFixtureModule();

    const apiKey = runtimeDiagnosticKey();
    const controller = new AbortController();
    let runnerSignal: AbortSignal | undefined;
    let abortObserved = false;
    let runnerSettled = false;
    let markRunnerReady: (() => void) | undefined;
    const runnerReady = new Promise<void>(resolveReady => {
      markRunnerReady = resolveReady;
    });
    const probePromise = fixture.probeWindowsProcess(6115, {
      signal: controller.signal,
      runCommand: async (_file, _args, signal) => {
        runnerSignal = signal;
        markRunnerReady?.();
        if (!signal) {
          return { exitCode: 9, stdout: '', stderr: 'RUNNER_SIGNAL_MISSING' };
        }
        return new Promise(resolveCommand => {
          signal.addEventListener('abort', () => {
            abortObserved = true;
            runnerSettled = true;
            resolveCommand({
              exitCode: -1,
              stdout: '',
              stderr: `Authorization: Bearer ${apiKey}`
            });
          }, { once: true });
        });
      }
    });

    await runnerReady;
    controller.abort();
    let caught: unknown;
    try {
      await probePromise;
    } catch (error) {
      caught = error;
    }

    expect(runnerSignal).toBe(controller.signal);
    expect(abortObserved).toBe(true);
    expect(runnerSettled).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('WINDOWS_PROCESS_PROBE_COMMAND_FAILED:exit=-1');
    expect((caught as Error).message).toContain('[已脱敏]');
    expect((caught as Error).message).not.toContain(apiKey);
  });

  test('OS 进程探针：超时后 abort 并等待 respecting probe settle', async () => {
    const fixture = await loadElectronFixtureModule();

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6116, executablePath);
    let abortObserved = false;
    let probeSettled = false;
    let spawnCalls = 0;
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await expect(fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      probeTimeoutMs: 5,
      helperExitTimeoutMs: 20,
      spawnCommand: () => {
        spawnCalls += 1;
        return Object.assign(new EventEmitter(), { exitCode: null as number | null });
      },
      processProbe: (_processId, signal) => new Promise((_resolveProbe, rejectProbe) => {
        signal?.addEventListener('abort', () => {
          abortObserved = true;
          setTimeout(() => {
            probeSettled = true;
            rejectProbe(new Error('ABORTED_AFTER_SETTLE'));
          }, 5);
        }, { once: true });
      })
    })).rejects.toThrow('PROCESS_PROBE_TIMEOUT');

    expect(abortObserved).toBe(true);
    expect(probeSettled).toBe(true);
    expect(spawnCalls).toBe(0);
    expect(killCalls).toBe(0);
  });

  test('OS 进程探针：忽略 AbortSignal 时有界报告契约违规且不继续破坏操作', async () => {
    const fixture = await loadElectronFixtureModule();

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6117, executablePath);
    let spawnCalls = 0;
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await expect(fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      probeTimeoutMs: 5,
      helperExitTimeoutMs: 5,
      spawnCommand: () => {
        spawnCalls += 1;
        return Object.assign(new EventEmitter(), { exitCode: null as number | null });
      },
      processProbe: () => new Promise(() => undefined)
    })).rejects.toThrow('PROCESS_PROBE_CONTRACT_VIOLATION');

    expect(spawnCalls).toBe(0);
    expect(killCalls).toBe(0);
  });

  test('taskkill 成功且原 child 在监听前按信号退出时不误报仍存活', async () => {
    const fixture = await loadElectronFixtureModule();

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6104, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    let fallbackKillCalls = 0;
    child.kill = () => {
      fallbackKillCalls += 1;
      return true;
    };

    await fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 20,
      processExitTimeoutMs: 5,
      spawnCommand: () => {
        queueMicrotask(() => {
          // 精确复现：原 child 的 exit 先发生，helper 随后才开始等待原 child。
          child.signalCode = 'SIGTERM';
          child.emit('exit', null, 'SIGTERM');
          emitFakeExit(command, 0);
        });
        return command;
      },
      processProbe: async () => ({ status: 'running', executablePath })
    });

    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe('SIGTERM');
    expect(fallbackKillCalls).toBe(0);
  });

  test('taskkill 超时时回退 SIGKILL，原 child 仍存活则明确失败', async () => {
    const fixture = await loadElectronFixtureModule();

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6102, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      kill: () => {
        queueMicrotask(() => emitFakeExit(command, 137));
        return true;
      }
    });
    const killSignals: Array<NodeJS.Signals | number | undefined> = [];
    child.kill = signal => {
      killSignals.push(signal);
      return true;
    };

    await expect(fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 5,
      helperExitTimeoutMs: 5,
      processExitTimeoutMs: 5,
      probeIntervalMs: 1,
      spawnCommand: () => command,
      processProbe: async () => ({ status: 'running', executablePath })
    })).rejects.toThrow('ELECTRON_PROCESS_STILL_RUNNING');
    expect(killSignals).toEqual(['SIGKILL']);
    expect(child.exitCode).toBeNull();
  });

  test('taskkill helper 收到 SIGKILL 后仍不退出时停止后续探针与破坏操作', async () => {
    const fixture = await loadElectronFixtureModule();

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6106, executablePath);
    const helperKillSignals: Array<NodeJS.Signals | number | undefined> = [];
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      kill: (signal?: NodeJS.Signals | number) => {
        helperKillSignals.push(signal);
        return true;
      }
    });
    let probeCalls = 0;
    let processKillCalls = 0;
    child.kill = () => {
      processKillCalls += 1;
      return true;
    };

    await expect(fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 5,
      helperExitTimeoutMs: 5,
      processExitTimeoutMs: 5,
      spawnCommand: () => command,
      processProbe: async () => {
        probeCalls += 1;
        return { status: 'running', executablePath };
      }
    })).rejects.toThrow('TASKKILL_HELPER_STILL_RUNNING');

    expect(helperKillSignals).toEqual(['SIGKILL']);
    expect(probeCalls).toBe(1);
    expect(processKillCalls).toBe(0);
  });

  test('路径不匹配时在启动 taskkill 或发送信号前拒绝，绝不误伤其他进程', async () => {
    const fixture = await loadElectronFixtureModule();

    const child = fakeElectronProcess(6103, resolve('C:\\other\\electron.exe'));
    let spawnCalls = 0;
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await expect(fixture.terminateElectronProcess(
      child,
      resolve('C:\\project\\electron.exe'),
      {
        platform: 'win32',
        gracefulExitTimeoutMs: 1,
        spawnCommand: () => {
          spawnCalls += 1;
          return Object.assign(new EventEmitter(), { exitCode: null as number | null });
        }
      }
    )).rejects.toThrow('ELECTRON_PROCESS_PATH_MISMATCH');
    expect(spawnCalls).toBe(0);
    expect(killCalls).toBe(0);
  });

  test('测试夹具直接 spawn 后连接 CDP，并在释放时按精确 Electron 路径和 PID 清理', async () => {
    const fixtureModule = await loadElectronFixtureModule();

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const fakeProcess = fakeElectronProcess(4242, expectedExecutable);
    const baseDirectory = resolve('C:\\Temp\\myself-fixture');
    const userDataDirectory = resolve(baseDirectory, 'user-data');
    const authorizedRootDirectory = resolve(baseDirectory, 'authorized-root');
    const spawnedPlans: ElectronLaunchPlan[] = [];
    const waitedEndpoints: string[] = [];
    const connectedEndpoints: string[] = [];
    const terminated: Array<{ pid: number; executablePath: string }> = [];
    const removed: string[] = [];
    const browserCloseCalls: number[] = [];
    const apiKey = runtimeDiagnosticKey();
    const logSentinel = 'fixture-provider-reply-sentinel';

    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey,
      logSentinels: [logSentinel],
      dependencies: {
        allocateLoopbackPort: async () => 43124,
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory,
          authorizedRootDirectory
        }),
        spawnProcess: plan => {
          spawnedPlans.push(plan);
          queueMicrotask(() => {
            fakeProcess.stdout.write(`Authorization: Bearer ${apiKey}\n`);
            fakeProcess.stderr.write(`root=${authorizedRootDirectory}\n`);
            fakeProcess.stderr.write(`${'x'.repeat(4_100)}${logSentinel}\n`);
            for (let index = 0; index < 101; index += 1) {
              fakeProcess.stderr.write(`safe-diagnostic-${index}\n`);
            }
          });
          return fakeProcess;
        },
        waitForReady: async options => {
          waitedEndpoints.push(options.endpoint);
        },
        connectOverCdp: async endpoint => {
          connectedEndpoints.push(endpoint);
          return { close: async () => { browserCloseCalls.push(1); } };
        },
        terminateProcess: async (child, executablePath) => {
          terminated.push({ pid: child.pid, executablePath });
        },
        removeTemporaryBase: async directory => {
          removed.push(directory);
        }
      }
    });

    expect(spawnedPlans).toHaveLength(1);
    expect(spawnedPlans[0]?.executablePath).toBe(expectedExecutable);
    expect(waitedEndpoints).toEqual(['http://127.0.0.1:43124']);
    expect(connectedEndpoints).toEqual(['http://127.0.0.1:43124']);
    expect(fixture.processId).toBe(4242);
    expect(fixture.executablePath).toBe(expectedExecutable);
    const publicLogLeakFlags = [apiKey, authorizedRootDirectory, logSentinel]
      .map(value => fixture.logs.some(log => log.includes(value)));
    expect(publicLogLeakFlags).toEqual([false, false, false]);
    expect(fixture.capturedLogEvidence).toEqual({
      apiKey: true,
      authorizedRoot: true,
      authorizationHeader: true,
      sentinels: [true]
    });

    await fixture.dispose();

    expect(browserCloseCalls).toHaveLength(1);
    expect(terminated).toEqual([{ pid: 4242, executablePath: expectedExecutable }]);
    expect(removed).toEqual([baseDirectory]);
  });

  test('进程终止使用自身有界契约，不被通用 operationTimeoutMs 提前截断', async () => {
    const fixtureModule = await loadElectronFixtureModule();

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const fakeProcess = fakeElectronProcess(4243, expectedExecutable);
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-terminate-owner');
    let terminateCalls = 0;
    const removed: string[] = [];

    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey: runtimeDiagnosticKey(),
      operationTimeoutMs: 5,
      dependencies: {
        allocateLoopbackPort: async () => 43129,
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory: resolve(baseDirectory, 'user-data'),
          authorizedRootDirectory: resolve(baseDirectory, 'authorized-root')
        }),
        spawnProcess: () => fakeProcess,
        waitForReady: async () => undefined,
        connectOverCdp: async () => ({ close: async () => undefined }),
        terminateProcess: async child => {
          terminateCalls += 1;
          // 模拟终止器超过通用阶段预算，但仍在自身有界契约内成功。
          await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 25));
          emitFakeExit(child, 0);
        },
        removeTemporaryBase: async directory => {
          removed.push(directory);
        }
      }
    });

    await fixture.dispose();
    await fixture.dispose();

    expect(terminateCalls).toBe(1);
    expect(removed).toEqual([baseDirectory]);
    expect(() => fixture.processId).toThrow('ELECTRON_PROCESS_PID_INVALID');
    expect(() => fixture.executablePath).toThrow('ELECTRON_LAUNCH_PLAN_UNAVAILABLE');
  });

  test('CDP 连接失败时仍清理精确进程和临时目录且不留残余', async () => {
    const fixtureModule = await loadElectronFixtureModule();

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const fakeProcess = fakeElectronProcess(4343, expectedExecutable);
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-failure');
    const terminated: Array<{ pid: number; executablePath: string }> = [];
    const removed: string[] = [];

    await expect(fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey: runtimeDiagnosticKey(),
      launchTimeoutMs: 50,
      dependencies: {
        allocateLoopbackPort: async () => 43125,
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory: resolve(baseDirectory, 'user-data'),
          authorizedRootDirectory: resolve(baseDirectory, 'authorized-root')
        }),
        spawnProcess: () => fakeProcess,
        waitForReady: async () => undefined,
        connectOverCdp: async () => { throw new Error('CDP_CONNECT_FAILED'); },
        terminateProcess: async (child, executablePath) => {
          terminated.push({ pid: child.pid, executablePath });
        },
        removeTemporaryBase: async directory => {
          removed.push(directory);
        }
      }
    })).rejects.toThrow('CDP_CONNECT_FAILED');

    expect(terminated).toEqual([{ pid: 4343, executablePath: expectedExecutable }]);
    expect(removed).toEqual([baseDirectory]);
  });

  test('清理阶段超时时报告阶段与脱敏 stderr，并继续回收进程和目录', async () => {
    const fixtureModule = await loadElectronFixtureModule();

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const fakeProcess = fakeElectronProcess(4444, expectedExecutable);
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-timeout');
    const authorizedRootDirectory = resolve(baseDirectory, 'authorized-root');
    const apiKey = runtimeDiagnosticKey();
    const terminated: number[] = [];
    const removed: string[] = [];

    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey,
      operationTimeoutMs: 20,
      dependencies: {
        allocateLoopbackPort: async () => 43126,
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory: resolve(baseDirectory, 'user-data'),
          authorizedRootDirectory
        }),
        spawnProcess: () => {
          queueMicrotask(() => {
            fakeProcess.stderr.write(
              `Authorization: Bearer ${apiKey}\nroot=${authorizedRootDirectory}\n`
            );
          });
          return fakeProcess;
        },
        waitForReady: async () => undefined,
        connectOverCdp: async () => ({
          close: () => new Promise<void>(() => undefined)
        }),
        terminateProcess: async child => {
          terminated.push(child.pid);
        },
        removeTemporaryBase: async directory => {
          removed.push(directory);
        }
      }
    });

    const guardedDispose = Promise.race([
      fixture.dispose(),
      new Promise<never>((_resolveGuard, rejectGuard) => {
        setTimeout(() => rejectGuard(new Error('UNIT_GUARD_TIMEOUT')), 200);
      })
    ]);
    let caught: unknown;
    try {
      await guardedDispose;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('ELECTRON_STAGE_TIMEOUT:cleanup_browser_close');
    expect(message).toContain('[已脱敏]');
    expect(message).not.toContain(apiKey);
    expect(message).not.toContain(authorizedRootDirectory);
    expect(terminated).toEqual([4444]);
    expect(removed).toEqual([baseDirectory]);
  });

  test('首次 dispose 进程清理失败后保留资源，第二次可重试并完成目录清理', async () => {
    const fixtureModule = await loadElectronFixtureModule();

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const fakeProcess = fakeElectronProcess(6201, expectedExecutable);
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-dispose-retry');
    const lateLogSentinel = 'dispose-failure-late-log';
    let terminateCalls = 0;
    const removed: string[] = [];

    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey: runtimeDiagnosticKey(),
      logSentinels: [lateLogSentinel],
      dependencies: {
        allocateLoopbackPort: async () => 43127,
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory: resolve(baseDirectory, 'user-data'),
          authorizedRootDirectory: resolve(baseDirectory, 'authorized-root')
        }),
        spawnProcess: () => fakeProcess,
        waitForReady: async () => undefined,
        connectOverCdp: async () => ({ close: async () => undefined }),
        terminateProcess: async child => {
          terminateCalls += 1;
          if (terminateCalls === 1) throw new Error('TERMINATE_FIRST_FAILED');
          emitFakeExit(child, 0);
        },
        removeTemporaryBase: async directory => {
          removed.push(directory);
        }
      }
    });

    await expect(fixture.dispose()).rejects.toThrow('TERMINATE_FIRST_FAILED');
    expect(terminateCalls).toBe(1);
    expect(removed).toEqual([]);
    expect(fixture.processId).toBe(6201);
    const evidenceAfterFailedDispose = fixture.capturedLogEvidence;
    fakeProcess.stdout.write(lateLogSentinel);
    expect(fixture.capturedLogEvidence).toEqual(evidenceAfterFailedDispose);
    await expect(fixture.restart()).rejects.toThrow('ELECTRON_FIXTURE_DISPOSED');
    expect(terminateCalls).toBe(1);

    await fixture.dispose();
    await fixture.dispose();
    expect(terminateCalls).toBe(2);
    expect(removed).toEqual([baseDirectory]);
  });

  test('create 的 CDP 主错误与清理错误并发时以主错误为 cause 并保留清理诊断', async () => {
    const fixtureModule = await loadElectronFixtureModule();

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const fakeProcess = fakeElectronProcess(6301, expectedExecutable);
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-primary-create');
    let caught: unknown;

    try {
      await fixtureModule.createElectronAppFixture({
        workspaceRoot,
        apiKey: runtimeDiagnosticKey(),
        dependencies: {
          allocateLoopbackPort: async () => 43128,
          createTemporaryDirectories: async () => ({
            baseDirectory,
            userDataDirectory: resolve(baseDirectory, 'user-data'),
            authorizedRootDirectory: resolve(baseDirectory, 'authorized-root')
          }),
          spawnProcess: () => fakeProcess,
          waitForReady: async () => undefined,
          connectOverCdp: async () => { throw new Error('PRIMARY_CDP_CONNECT_FAILED'); },
          terminateProcess: async () => { throw new Error('CLEANUP_TERMINATE_FAILED'); },
          removeTemporaryBase: async () => undefined
        }
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.cause).toBeInstanceOf(Error);
    expect((aggregate.cause as Error).message).toContain('PRIMARY_CDP_CONNECT_FAILED');
    expect(aggregate.errors.map(error => String(error))).toEqual(expect.arrayContaining([
      expect.stringContaining('PRIMARY_CDP_CONNECT_FAILED'),
      expect.stringContaining('CLEANUP_TERMINATE_FAILED')
    ]));
  });

  test('restart 的 CDP 主错误与新进程清理错误并发时仍保留主错误', async () => {
    const fixtureModule = await loadElectronFixtureModule();

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const processes = [
      fakeElectronProcess(6302, expectedExecutable),
      fakeElectronProcess(6303, expectedExecutable)
    ];
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-primary-restart');
    let connectCalls = 0;
    let failedRestartCleanup = false;
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey: runtimeDiagnosticKey(),
      dependencies: {
        allocateLoopbackPort: async () => 43129 + connectCalls,
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory: resolve(baseDirectory, 'user-data'),
          authorizedRootDirectory: resolve(baseDirectory, 'authorized-root')
        }),
        spawnProcess: () => {
          const child = processes.shift();
          if (!child) throw new Error('缺少测试进程');
          return child;
        },
        waitForReady: async () => undefined,
        connectOverCdp: async () => {
          connectCalls += 1;
          if (connectCalls === 2) throw new Error('PRIMARY_RESTART_CDP_FAILED');
          return { close: async () => undefined };
        },
        terminateProcess: async child => {
          if (child.pid === 6303 && !failedRestartCleanup) {
            failedRestartCleanup = true;
            throw new Error('RESTART_CLEANUP_TERMINATE_FAILED');
          }
          emitFakeExit(child, 0);
        },
        removeTemporaryBase: async () => undefined
      }
    });

    let caught: unknown;
    try {
      await fixture.restart();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect((aggregate.cause as Error).message).toContain('PRIMARY_RESTART_CDP_FAILED');
    expect(aggregate.errors.map(error => String(error))).toEqual(expect.arrayContaining([
      expect.stringContaining('PRIMARY_RESTART_CDP_FAILED'),
      expect.stringContaining('RESTART_CLEANUP_TERMINATE_FAILED')
    ]));
    await fixture.dispose();
  });

  test('重启时复用隔离目录、重新分配回环端口并分别清理精确 PID', async () => {
    const fixtureModule = await loadElectronFixtureModule();

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-restart');
    const userDataDirectory = resolve(baseDirectory, 'user-data');
    const authorizedRootDirectory = resolve(baseDirectory, 'authorized-root');
    const persistentSentinel = 'restart-persistent-sentinel';
    const crossEpochSentinel = 'restart-cross-epoch-sentinel';
    const sameEpochSentinel = 'restart-same-epoch-sentinel';
    const ports = [43130, 43131];
    const firstProcess = fakeElectronProcess(5001, expectedExecutable);
    const secondProcess = fakeElectronProcess(5002, expectedExecutable);
    const processes = [firstProcess, secondProcess];
    const plans: ElectronLaunchPlan[] = [];
    const terminated: number[] = [];
    const removed: string[] = [];

    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey: runtimeDiagnosticKey(),
      logSentinels: [persistentSentinel, crossEpochSentinel, sameEpochSentinel],
      dependencies: {
        allocateLoopbackPort: async () => {
          const port = ports.shift();
          if (!port) throw new Error('缺少测试端口');
          return port;
        },
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory,
          authorizedRootDirectory
        }),
        spawnProcess: plan => {
          plans.push(plan);
          const child = processes.shift();
          if (!child) throw new Error('缺少测试进程');
          const epoch = plans.length;
          queueMicrotask(() => {
            if (epoch === 1) {
              child.stdout.write(persistentSentinel);
              return;
            }
            firstProcess.stdout.write(crossEpochSentinel.slice(0, 11));
            child.stdout.write(crossEpochSentinel.slice(11));
            child.stdout.write(sameEpochSentinel.slice(0, 10));
            child.stdout.write(sameEpochSentinel.slice(10));
          });
          return child;
        },
        waitForReady: async () => undefined,
        connectOverCdp: async () => ({ close: async () => undefined }),
        terminateProcess: async child => {
          terminated.push(child.pid);
        },
        removeTemporaryBase: async directory => {
          removed.push(directory);
        }
      }
    });

    expect(typeof fixture.restart).toBe('function');
    if (!fixture.restart) return;
    await fixture.restart();

    expect(plans).toHaveLength(2);
    expect(plans.map(plan => plan.environment['MYSELF_E2E_USER_DATA']))
      .toEqual([userDataDirectory, userDataDirectory]);
    expect(plans.map(plan => plan.environment['MYSELF_E2E_AUTHORIZED_ROOT']))
      .toEqual([authorizedRootDirectory, authorizedRootDirectory]);
    expect(plans.map(plan => plan.cdpEndpoint)).toEqual([
      'http://127.0.0.1:43130',
      'http://127.0.0.1:43131'
    ]);
    expect(terminated).toEqual([5001]);
    expect(removed).toEqual([]);
    expect(fixture.capturedLogEvidence.sentinels).toEqual([true, false, true]);

    await fixture.dispose();

    expect(terminated).toEqual([5001, 5002]);
    expect(removed).toEqual([baseDirectory]);
  });

  test('restart 等待钩子期间 dispose 开始后不得再启动新进程', async () => {
    const fixtureModule = await loadElectronFixtureModule();

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-restart-dispose-race');
    const processes = [
      fakeElectronProcess(5101, expectedExecutable),
      fakeElectronProcess(5102, expectedExecutable)
    ];
    let beforeRestartEntered!: () => void;
    const entered = new Promise<void>(resolveEntered => {
      beforeRestartEntered = resolveEntered;
    });
    let releaseRestart!: () => void;
    const restartGate = new Promise<void>(resolveGate => {
      releaseRestart = resolveGate;
    });
    let spawnCalls = 0;
    const terminated: number[] = [];
    const removed: string[] = [];

    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey: runtimeDiagnosticKey(),
      beforeRestart: async () => {
        beforeRestartEntered();
        await restartGate;
      },
      dependencies: {
        allocateLoopbackPort: async () => 43134 + spawnCalls,
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory: resolve(baseDirectory, 'user-data'),
          authorizedRootDirectory: resolve(baseDirectory, 'authorized-root')
        }),
        spawnProcess: () => {
          const child = processes[spawnCalls];
          spawnCalls += 1;
          if (!child) throw new Error('缺少测试进程');
          return child;
        },
        waitForReady: async () => undefined,
        connectOverCdp: async () => ({ close: async () => undefined }),
        terminateProcess: async child => {
          terminated.push(child.pid);
        },
        removeTemporaryBase: async directory => {
          removed.push(directory);
        }
      }
    });

    const restarting = fixture.restart();
    await entered;
    await fixture.dispose();
    releaseRestart();

    await expect(restarting).rejects.toThrow('ELECTRON_FIXTURE_DISPOSED');
    expect(spawnCalls).toBe(1);
    expect(terminated).toEqual([5101]);
    expect(removed).toEqual([baseDirectory]);
  });

  test('restart 分配端口期间 dispose 完成后不得再 spawn', async () => {
    const fixtureModule = await loadElectronFixtureModule();

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-allocator-dispose-race');
    const processes = [
      fakeElectronProcess(5201, expectedExecutable),
      fakeElectronProcess(5202, expectedExecutable)
    ];
    let allocatorEntered!: () => void;
    const entered = new Promise<void>(resolveEntered => {
      allocatorEntered = resolveEntered;
    });
    let releaseAllocator!: () => void;
    const allocatorGate = new Promise<void>(resolveGate => {
      releaseAllocator = resolveGate;
    });
    let allocationCalls = 0;
    let spawnCalls = 0;
    const terminated: number[] = [];
    const removed: string[] = [];

    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey: runtimeDiagnosticKey(),
      dependencies: {
        allocateLoopbackPort: async () => {
          allocationCalls += 1;
          if (allocationCalls === 1) return 43136;
          allocatorEntered();
          await allocatorGate;
          return 43137;
        },
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory: resolve(baseDirectory, 'user-data'),
          authorizedRootDirectory: resolve(baseDirectory, 'authorized-root')
        }),
        spawnProcess: () => {
          const child = processes[spawnCalls];
          spawnCalls += 1;
          if (!child) throw new Error('缺少测试进程');
          return child;
        },
        waitForReady: async () => undefined,
        connectOverCdp: async () => ({ close: async () => undefined }),
        terminateProcess: async child => {
          terminated.push(child.pid);
        },
        removeTemporaryBase: async directory => {
          removed.push(directory);
        }
      }
    });

    const restarting = fixture.restart();
    await entered;
    await fixture.dispose();
    releaseAllocator();

    await expect(restarting).rejects.toThrow('ELECTRON_FIXTURE_DISPOSED');
    expect(allocationCalls).toBe(2);
    expect(spawnCalls).toBe(1);
    expect(terminated).toEqual([5201]);
    expect(removed).toEqual([baseDirectory]);
  });
});

test.describe('真实 Electron CDP smoke', () => {
  test('直接启动构建产物并连接可见桌宠 Renderer', async () => {
    const fixtureModule = await loadElectronFixtureModule();

    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: runtimeDiagnosticKey(),
      launchTimeoutMs: 15_000
    });
    try {
      const petPage = await waitForRendererPage(fixture, 'pet');
      await expect(petPage.getByRole('main', { name: 'AI Pet 桌宠' })).toBeVisible();
      const layout = await petPage.evaluate(() => {
        const measure = (selector: string): { width: number; height: number } => {
          const element = document.querySelector<HTMLElement>(selector);
          if (!element) throw new Error(`缺少布局元素：${selector}`);
          const rect = element.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        };
        const canvas = document.querySelector<HTMLCanvasElement>(
          '.character-player-host canvas'
        );
        return {
          shell: measure('.pet-shell'),
          surface: measure('.pet-character-surface'),
          player: measure('.character-player'),
          host: measure('.character-player-host'),
          stage: measure('.character-player-stage'),
          canvas: canvas
            ? {
                box: measure('.character-player-host canvas'),
                width: canvas.width,
                height: canvas.height
              }
            : null
        };
      });

      expect(layout.shell).toEqual({ width: 180, height: 220 });
      expect(layout.surface).toEqual({ width: 156, height: 192 });
      expect(layout.player).toEqual(layout.surface);
      expect(layout.host).toEqual(layout.surface);
      expect(layout.stage).toEqual(layout.surface);
      if (layout.canvas) {
        expect(layout.canvas.box).toEqual(layout.surface);
        expect({
          width: layout.canvas.width,
          height: layout.canvas.height
        }).toEqual(layout.surface);
      }
    } finally {
      await fixture.dispose();
    }
  });
});

test.describe('真实桌宠像素命中与左键拖拽', () => {
  test('像素命中探针保持透明穿透且不建立 Renderer 拖拽会话', async () => {
    test.setTimeout(120_000);
    const fixtureModule = await loadElectronFixtureModule();

    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: runtimeDiagnosticKey(),
      launchTimeoutMs: 15_000
    });
    try {
      const pet = await waitForRendererPage(fixture, 'pet');
      await pet.emulateMedia({ reducedMotion: 'reduce' });
      await expect(pet.getByRole('main', { name: 'AI Pet 桌宠' })).toBeVisible();
      await expect(pet.locator('.character-player')).toHaveAttribute(
        'data-status',
        'ready',
        { timeout: 20_000 }
      );
      const shell = pet.getByRole('main', { name: 'AI Pet 桌宠' });
      const dispatchPointer = async (
        point: { x: number; y: number }
      ): Promise<void> => {
        await shell.evaluate((element, input) => {
          element.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            clientX: input.x,
            clientY: input.y,
            pointerId: 41
          }));
        }, point);
      };

      const transparent = { x: 1, y: 1 };
      await dispatchPointer(transparent);
      await expect.poll(() => fixture.getPetInteractionProbe()).toMatchObject({
        passthrough: true,
        dragging: false
      });
      let visible: { x: number; y: number } | undefined;
      for (let y = 6; y < 220 && !visible; y += 8) {
        for (let x = 6; x < 180; x += 8) {
          const candidate = { x, y };
          await dispatchPointer(candidate);
          const probe = await fixture.getPetInteractionProbe();
          if (!probe.passthrough) {
            visible = candidate;
            break;
          }
        }
      }
      expect(visible, '应在官方默认角色渲染区域中命中可见像素').toBeDefined();
      if (!visible) return;

      await expect(pet.getByRole('button', {
        name: '打开与 AI Pet 的聊天'
      })).toHaveCount(0);
      await dispatchPointer(visible);
      await expect.poll(() => fixture.getPetInteractionProbe()).toMatchObject({
        passthrough: false,
        dragging: false
      });
    } finally {
      await fixture.dispose();
    }
  });
});

test.describe('固定尺寸视觉几何', () => {
  test('桌宠滚轮输入不改变 Main 档位或持久化默认尺寸', async () => {
    const fixture = await createGeometryFixture(runtimeDiagnosticKey());
    try {
      const pet = await waitForReadyPet(fixture);
      const before = await waitForGeometry(fixture);
      const shell = pet.getByRole('main', { name: 'AI Pet 桌宠' });
      const bounds = await shell.boundingBox();
      if (!bounds) throw new Error('桌宠窗口不可见');

      await pet.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await pet.mouse.wheel(0, -600);
      await pet.waitForTimeout(300);

      const after = await waitForGeometry(fixture);
      const placement = await readPlacement(fixture.userDataDirectory, 'builtin-default');
      expect(before.scaleTick).toBe(10);
      expect(after.scaleTick).toBe(10);
      expect(placement?.scale).toBe(1);
    } finally {
      await fixture.dispose();
    }
  });
  type Placement = PetPlacementForE2e;
  type GeometryProbe = NonNullable<Awaited<ReturnType<AppFixture['getMainE2eState']>>['geometry']>;
  type PointRatio = Readonly<{ x: number; y: number }>;
  type WorkAreaEdge = 'left' | 'right' | 'top' | 'bottom';

  const createGeometryFixture = async (apiKey: string): Promise<AppFixture> => (
    (await loadElectronFixtureModule()).createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey,
      launchTimeoutMs: 15_000,
      enableSoftwareRasterizer: true
    })
  );

  const waitForReadyPet = async (
    fixture: AppFixture,
    timeout = 20_000
  ): Promise<Page> => {
    const pet = await waitForRendererPage(fixture, 'pet', timeout);
    await expect(pet.locator('.character-player')).toHaveAttribute('data-status', 'ready', {
      timeout
    });
    return pet;
  };

  const configureGeometryProvider = async (
    pet: Page,
    input: Readonly<{ baseUrl: string; apiKey: string; openChat: boolean }>
  ): Promise<void> => {
    await pet.evaluate(async ({ baseUrl, apiKey, openChat }) => {
      await window.myself.saveProviderProfile({
        profile: {
          id: 'visual-geometry-e2e', displayName: '视觉几何 E2E', mode: 'custom',
          protocol: 'openai-compatible', baseUrl, modelId: 'visual-geometry-model',
          additionalParameters: {}, capabilities: ['chat', 'tools']
        },
        secret: apiKey,
        persistSecret: true
      });
      await window.myself.saveModelRoute({
        primaryProfileId: 'visual-geometry-e2e',
        chatProfileId: 'visual-geometry-e2e',
        agentProfileId: 'visual-geometry-e2e',
        visionProfileId: null,
        fallbackProfileIds: [],
        allowCrossProviderFallback: false
      });
      await window.myself.savePrivacySettings({
        dataCategories: { memory: false },
        longTermMemory: false,
        proactivityMode: 'passive'
      });
      if (openChat) await window.myself.openChat();
    }, input);
  };

  const readPlacement = async (
    userDataDirectory: string,
    characterId: string
  ): Promise<Placement | null> => {
    try {
      const settings = JSON.parse(
        await readFile(join(userDataDirectory, 'settings.json'), 'utf8')
      ) as {
        petPlacementState?: {
          kind?: string;
          placements?: Placement[];
        };
      };
      if (settings.petPlacementState?.kind !== 'ready') return null;
      return settings.petPlacementState.placements?.find(
        placement => placement.characterId === characterId
      ) ?? null;
    } catch {
      return null;
    }
  };

  const sameFoot = (left: Placement | null, right: Placement | null): boolean => Boolean(
    left && right
    && left.footAnchorDip.x === right.footAnchorDip.x
    && left.footAnchorDip.y === right.footAnchorDip.y
  );

  const waitForGeometry = async (fixture: AppFixture): Promise<GeometryProbe> => {
    await expect.poll(async () => {
      const state = await fixture.getMainE2eState();
      return {
        geometryReady: state.geometry !== null,
        nativeDragging: state.petNativeDragging,
        bounds: state.petWindowBoundsDip
      };
    }).toMatchObject({ geometryReady: true, nativeDragging: false });
    const geometry = (await fixture.getMainE2eState()).geometry;
    if (!geometry) throw new Error('缺少视觉几何 E2E 探针');
    return geometry;
  };

  const movePetToWorkAreaCenter = async (
    fixture: AppFixture,
    pet: Page,
    characterId: string
  ): Promise<Placement> => {
    const before = await readPlacement(fixture.userDataDirectory, characterId);
    await pet.evaluate(() => {
      const currentScreen = window.screen as Screen & { availLeft?: number; availTop?: number };
      const availableLeft = currentScreen.availLeft ?? 0;
      const availableTop = currentScreen.availTop ?? 0;
      window.moveTo(
        Math.round(availableLeft + (currentScreen.availWidth - window.outerWidth) / 2),
        Math.round(availableTop + (currentScreen.availHeight - window.outerHeight) / 2)
      );
    });
    await expect.poll(async () => {
      const current = await readPlacement(fixture.userDataDirectory, characterId);
      return Boolean(current && (!before || !sameFoot(current, before)));
    }).toBe(true);
    await expect.poll(async () => (
      await fixture.getMainE2eState()
    ).geometry?.outOfBounds).toBe(false);
    const centered = await readPlacement(fixture.userDataDirectory, characterId);
    if (!centered) throw new Error('桌宠移动到工作区中心后没有持久脚底');
    return centered;
  };

  /** 复用正式 alpha hit，不从 Canvas 或几何摘要猜测可见像素。 */
  const findVisiblePointRatio = async (
    fixture: AppFixture,
    pet: Page
  ): Promise<PointRatio> => {
    const shell = pet.getByRole('main', { name: 'AI Pet 桌宠' });
    await pet.mouse.move(1, 1);
    await expect.poll(() => fixture.getPetInteractionProbe()).toMatchObject({
      passthrough: true
    });
    const viewport = await shell.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    const candidates: Array<{ x: number; y: number }> = [];
    for (let y = 6; y < viewport.height; y += 8) {
      for (let x = 6; x < viewport.width; x += 8) candidates.push({ x, y });
    }
    candidates.sort((left, right) => (
      Math.hypot(left.x - viewport.width / 2, left.y - viewport.height / 2)
      - Math.hypot(right.x - viewport.width / 2, right.y - viewport.height / 2)
    ));
    for (const { x, y } of candidates) {
      await pet.mouse.move(x, y);
      // 穿透 IPC 跨 Renderer/Main 串行确认，不能把上一候选的迟到状态归给当前像素。
      await pet.waitForTimeout(50);
      if (!(await fixture.getPetInteractionProbe()).passthrough) {
        return { x: x / viewport.width, y: y / viewport.height };
      }
    }
    throw new Error('官方默认角色没有可供滚轮验收的 alpha 命中像素');
  };

  const hoverVisiblePoint = async (
    fixture: AppFixture,
    pet: Page,
    ratio: PointRatio
  ): Promise<void> => {
    const shell = pet.getByRole('main', { name: 'AI Pet 桌宠' });
    const point = await shell.evaluate((element, normalized) => {
      const rect = element.getBoundingClientRect();
      return {
        x: Math.max(1, Math.min(rect.width - 1, rect.width * normalized.x)),
        y: Math.max(1, Math.min(rect.height - 1, rect.height * normalized.y))
      };
    }, ratio);
    await pet.mouse.move(point.x, point.y);
    await expect.poll(() => fixture.getPetInteractionProbe()).toMatchObject({
      passthrough: false
    });
  };


  /** 只把全局窗口事实留在 Renderer 内组合，测试进程仅接收贴边布尔。 */
  const touchesWorkAreaEdge = async (
    pet: Page,
    geometry: GeometryProbe,
    edge: WorkAreaEdge
  ): Promise<boolean> => pet.evaluate(({ visual, targetEdge }) => {
    const currentScreen = window.screen as Screen & { availLeft?: number; availTop?: number };
    const availableLeft = currentScreen.availLeft ?? 0;
    const availableTop = currentScreen.availTop ?? 0;
    const availableRight = availableLeft + currentScreen.availWidth;
    const availableBottom = availableTop + currentScreen.availHeight;
    const visualLeft = window.screenX + visual.x * window.outerWidth;
    const visualTop = window.screenY + visual.y * window.outerHeight;
    const visualRight = visualLeft + visual.width * window.outerWidth;
    const visualBottom = visualTop + visual.height * window.outerHeight;
    const toleranceDip = 1.1;
    if (targetEdge === 'left') return Math.abs(visualLeft - availableLeft) <= toleranceDip;
    if (targetEdge === 'right') return Math.abs(visualRight - availableRight) <= toleranceDip;
    if (targetEdge === 'top') return Math.abs(visualTop - availableTop) <= toleranceDip;
    return Math.abs(visualBottom - availableBottom) <= toleranceDip;
  }, {
    visual: geometry.visualBoundsInWindowRatio,
    targetEdge: edge
  });




});

test.describe('角色工作台布局分隔器', () => {
  const workspaceRoot = resolve(process.cwd());
  let fixtureModule: ElectronFixtureModule;

  test.beforeAll(async () => {
    fixtureModule = await loadElectronFixtureModule();
  });

  const openWorkshop = async (fixture: AppFixture): Promise<Page> => {
    const pet = await waitForRendererPage(fixture, 'pet', 15_000);
    await pet.evaluate(() => window.myself.openCharacterWorkshop());
    const workshop = await waitForRendererPage(fixture, 'characters', 15_000);
    await expect(workshop.getByRole('separator')).toHaveCount(4);
    return workshop;
  };

  const dragSplitter = async (
    page: Page,
    name: string,
    delta: Readonly<{ x: number; y: number }>
  ): Promise<void> => {
    const splitter = page.getByRole('separator', { name });
    const box = await splitter.boundingBox();
    if (!box) throw new Error(`分隔器不可见：${name}`);
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + delta.x, start.y + delta.y, { steps: 4 });
    await page.mouse.up();
  };

  test('四条分隔器真实拖动、重开恢复且窄屏回退无空轨道', async () => {
    test.setTimeout(90_000);
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey: runtimeDiagnosticKey(),
      launchTimeoutMs: 15_000,
      enableSoftwareRasterizer: true,
      prepareUserData: async directories => {
        const settings = new SettingsStore(
          join(directories.userDataDirectory, 'settings.json'),
          async () => false
        );
        await settings.saveWorkshopLayout({
          leftWidth: 900,
          rightWidth: 600,
          sidebarTopHeight: 300,
          stageHeight: 470
        });
      }
    });

    try {
      const workshop = await openWorkshop(fixture);
      const before = await workshop.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        return {
          left: rect('.workshop-sidebar').width,
          right: rect('.workshop-inspector').width,
          character: rect('.character-section').height,
          preview: rect('.preview-workspace').height
        };
      });

      const rightKeyboardSplitter = workshop.getByRole('separator', {
        name: '调整属性侧栏宽度'
      });
      const keyboardStartBox = await rightKeyboardSplitter.boundingBox();
      if (!keyboardStartBox) throw new Error('右侧分隔器不可见');
      await rightKeyboardSplitter.press('ArrowRight');
      await expect.poll(() => workshop.locator('.workshop-inspector').evaluate(element => (
        element.getBoundingClientRect().width
      ))).toBeLessThanOrEqual(before.right - 7);
      const keyboardRightWidth = await workshop.locator('.workshop-inspector').evaluate(element => (
        element.getBoundingClientRect().width
      ));
      expect(keyboardRightWidth).toBeGreaterThanOrEqual(before.right - 9);
      const keyboardRightBox = await rightKeyboardSplitter.boundingBox();
      expect(keyboardRightBox?.x).toBeGreaterThanOrEqual(keyboardStartBox.x + 7);
      await rightKeyboardSplitter.press('Shift+ArrowRight');
      await expect.poll(() => workshop.locator('.workshop-inspector').evaluate(element => (
        element.getBoundingClientRect().width
      ))).toBeLessThanOrEqual(before.right - 39);
      const keyboardShiftWidth = await workshop.locator('.workshop-inspector').evaluate(element => (
        element.getBoundingClientRect().width
      ));
      expect(keyboardShiftWidth).toBeGreaterThanOrEqual(before.right - 41);

      const leftBeforeDrag = await workshop.locator('.workshop-sidebar').evaluate(element => (
        element.getBoundingClientRect().width
      ));
      await dragSplitter(workshop, '调整角色侧栏宽度', { x: -8, y: 0 });
      await expect.poll(() => workshop.locator('.workshop-sidebar').evaluate(element => (
        element.getBoundingClientRect().width
      ))).toBeLessThanOrEqual(leftBeforeDrag - 7);
      const leftAfterDrag = await workshop.locator('.workshop-sidebar').evaluate(element => (
        element.getBoundingClientRect().width
      ));
      expect(leftAfterDrag).toBeGreaterThanOrEqual(leftBeforeDrag - 9);
      const rightBeforeDrag = await workshop.locator('.workshop-inspector').evaluate(element => (
        element.getBoundingClientRect().width
      ));
      await dragSplitter(workshop, '调整属性侧栏宽度', { x: 8, y: 0 });
      await expect.poll(() => workshop.locator('.workshop-inspector').evaluate(element => (
        element.getBoundingClientRect().width
      ))).toBeLessThanOrEqual(rightBeforeDrag - 7);
      const rightAfterDrag = await workshop.locator('.workshop-inspector').evaluate(element => (
        element.getBoundingClientRect().width
      ));
      expect(rightAfterDrag).toBeGreaterThanOrEqual(rightBeforeDrag - 9);
      await dragSplitter(workshop, '调整角色区与状态区高度', { x: 0, y: 24 });
      await dragSplitter(workshop, '调整预览区与时间轴高度', { x: 0, y: -24 });

      const after = await workshop.evaluate(() => {
        const columns = document.querySelector<HTMLElement>('.workshop-columns')!;
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        return {
          left: rect('.workshop-sidebar').width,
          right: rect('.workshop-inspector').width,
          character: rect('.character-section').height,
          preview: rect('.preview-workspace').height,
          values: [
            '--workshop-left-width',
            '--workshop-right-width',
            '--workshop-sidebar-top-height',
            '--workshop-stage-height'
          ].map(name => columns.style.getPropertyValue(name))
        };
      });
      expect(rightAfterDrag).toBeLessThan(rightBeforeDrag);
      expect(after.character).toBeGreaterThan(before.character + 8);
      expect(after.preview).toBeLessThan(before.preview - 8);

      const workshopClosed = workshop.waitForEvent('close');
      await workshop.evaluate(() => window.close());
      await workshopClosed;
      const reopened = await openWorkshop(fixture);
      await expect.poll(() => reopened.evaluate(() => {
        const columns = document.querySelector<HTMLElement>('.workshop-columns')!;
        return [
          '--workshop-left-width',
          '--workshop-right-width',
          '--workshop-sidebar-top-height',
          '--workshop-stage-height'
        ].map(name => columns.style.getPropertyValue(name));
      })).toEqual(after.values);

      await reopened.evaluate(() => window.resizeTo(900, 620));
      await expect(reopened.getByRole('separator')).toHaveCount(0);
      await expect(reopened.locator('.workshop-inspector')).toBeVisible();
      const narrowTracks = await reopened.locator('.workshop-columns').evaluate(element => (
        getComputedStyle(element).gridTemplateColumns
      ));
      expect(narrowTracks.split(' ').filter(Boolean)).toHaveLength(2);
      const narrowPanels = await reopened.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        return {
          leftWidth: rect('.workshop-sidebar').width,
          centerWidth: rect('.workshop-stage').width,
          rightWidth: rect('.workshop-inspector').width,
          characterHeight: rect('.character-section').height,
          stateHeight: rect('.state-section').height,
          previewHeight: rect('.preview-workspace').height,
          timelineHeight: rect('.action-timeline, .timeline-empty').height
        };
      });
      expect(narrowPanels.leftWidth).toBeGreaterThanOrEqual(220);
      expect(narrowPanels.centerWidth).toBeGreaterThanOrEqual(360);
      expect(narrowPanels.rightWidth).toBeGreaterThanOrEqual(360);
      expect(narrowPanels.characterHeight).toBeGreaterThanOrEqual(220);
      expect(narrowPanels.stateHeight).toBeGreaterThanOrEqual(220);
      expect(narrowPanels.previewHeight).toBeGreaterThanOrEqual(280);
      expect(narrowPanels.timelineHeight).toBeGreaterThanOrEqual(150);

      await reopened.evaluate(() => window.resizeTo(1_120, 760));
      await expect(reopened.getByRole('separator')).toHaveCount(4);
      await expect.poll(() => reopened.locator('.workshop-columns').evaluate(element => (
        (element as HTMLElement).style.getPropertyValue('--workshop-left-width')
      ))).toBe(after.values[0]);
    } finally {
      await fixture.dispose();
    }
  });
});

test.describe('角色工作台双皮肤包兼容', () => {
  const workspaceRoot = resolve(process.cwd());
  const characterId = 'e2e-safe-character';
  let fixtureModule: ElectronFixtureModule;

  test.beforeAll(async () => {
    fixtureModule = await loadElectronFixtureModule();
  });

  const openWorkshop = async (fixture: AppFixture): Promise<Page> => {
    const pet = await waitForRendererPage(fixture, 'pet', 15_000);
    await pet.evaluate(() => window.myself.openCharacterWorkshop());
    return waitForRendererPage(fixture, 'characters', 15_000);
  };

  const importFixtureCharacter = async (workshop: Page): Promise<void> => {
    await workshop.getByRole('button', { name: '导入角色包' }).click({
      timeout: 15_000
    });
    const character = workshop.locator(`[data-character-id="${characterId}"]`);
    await expect(character).toBeVisible({ timeout: 15_000 });
    await character.getByRole('button', { name: /^E2E 安全角色/u }).click({
      timeout: 10_000
    });
  };

  const selectIdleAction = async (workshop: Page): Promise<void> => {
    const idleState = workshop.getByRole('list', { name: '状态与动作列表' })
      .locator(':scope > li')
      .filter({ has: workshop.getByRole('button', { name: /^待机/u }) })
      .first();
    await idleState.getByRole('button', { name: /^待机/u }).first().click({
      timeout: 10_000
    });
    await idleState.getByRole('list', { name: '待机动作' })
      .getByRole('button', { name: /^待机/u })
      .click({ timeout: 10_000 });
  };

  const readV2PackageState = async (fixture: AppFixture) => {
    const root = join(fixture.userDataDirectory, 'characters', characterId);
    const [draft, manifest] = await Promise.all([
      readFile(join(root, 'draft', 'draft.json'), 'utf8'),
      readFile(join(root, 'compiled', 'manifest.json'), 'utf8')
    ]);
    return {
      draft: JSON.parse(draft) as {
        defaultSkinId: string;
        skins: Array<{ id: string }>;
      },
      manifest: JSON.parse(manifest) as {
        defaultSkinId: string;
        skins: Array<{
          id: string;
          presentations: Array<{
            actionId: string;
            playbackRate?: number;
            mirrorX?: boolean;
          }>;
        }>;
      }
    };
  };

  const expectWinterPackageState = async (fixture: AppFixture): Promise<void> => {
    const { draft, manifest } = await readV2PackageState(fixture);
    expect(draft.defaultSkinId).toBe('winter');
    expect(draft.skins.map(skin => skin.id)).toEqual(['default', 'winter']);
    expect(manifest.defaultSkinId).toBe('winter');
    expect(manifest.skins.map(skin => skin.id)).toEqual(['default', 'winter']);
    expect(manifest.skins[1]?.presentations.find(
      presentation => presentation.actionId === 'safe-idle-action'
    )).toMatchObject({ playbackRate: 1.5, mirrorX: true });
  };

  const expectWinterRuntime = async (fixture: AppFixture): Promise<void> => {
    const pet = await waitForRendererPage(fixture, 'pet', 15_000);
    await expect.poll(async () => pet.evaluate(async () => {
      const snapshot = await window.myself.getCharacterRuntimeSnapshot();
      // 正式 IPC 返回 V3 播放视图，按已解析的 idle 动作查找表现。
      const view = snapshot?.manifest;
      const idleAction = view?.presentations
        .find(item => item.actionId === view.idle.actionId)?.presentation;
      return {
        activeCharacterId: snapshot?.activeCharacterId ?? null,
        playbackRate: idleAction?.playbackRate ?? null,
        mirrorX: idleAction?.mirrorX ?? null
      };
    }), { timeout: 15_000 }).toEqual({
      activeCharacterId: characterId,
      playbackRate: 1.5,
      mirrorX: true
    });
  };

  test('真实导入、编译、导出与回导保留双皮肤默认运行表现', async () => {
    test.setTimeout(180_000);
    const first = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey: runtimeDiagnosticKey(),
      launchTimeoutMs: 15_000,
      enableSoftwareRasterizer: true
    });
    try {
      const workshop = await openWorkshop(first);
      await importFixtureCharacter(workshop);
      await expect(workshop.getByRole('heading', { name: '角色', exact: true }))
        .toBeVisible();
      await expect(workshop.getByRole('list', { name: '皮肤列表' })).toHaveCount(0);
      await expect(workshop.getByRole('button', { name: '新增皮肤' })).toHaveCount(0);
      await selectIdleAction(workshop);
      const preview = workshop.locator('[data-preview-status]');
      await expect(preview).toHaveAttribute('data-preview-status', 'ready');
      await expect(preview).toHaveAttribute('data-preview-speed', '1.5');
      await expect(preview).toHaveAttribute('data-preview-direction', 'left');

      await workshop.getByRole('button', { name: '编译并发布' }).click();
      await expect(workshop.getByText('运行版本已编译并发布。'))
        .toBeVisible({ timeout: 15_000 });
      await workshop.getByRole('button', {
        name: '关闭工作台提示：运行版本已编译并发布。'
      }).click();
      await expectWinterPackageState(first);
      await workshop.getByRole('button', { name: '启用角色' }).click();
      await expect(workshop.getByText('角色已启用。')).toBeVisible({ timeout: 15_000 });
      await workshop.getByRole('button', {
        name: '关闭工作台提示：角色已启用。'
      }).click();
      await expectWinterRuntime(first);

      await workshop.getByRole('button', { name: '导出角色包' }).click();
      await expect(workshop.getByText('角色包已导出。')).toBeVisible({ timeout: 15_000 });
      await workshop.getByRole('button', {
        name: '关闭工作台提示：角色包已导出。'
      }).click();
      const exportedBytes = await readFile(first.characterExportDestination!);
      expect(exportedBytes.byteLength).toBeGreaterThan(0);

      // 同一 Electron 生命周期内删除已导入角色，再以刚导出的包回导，避免无关的二次启动成本。
      // 该闭环需要连续两次选择安全包；默认 E2E 队列仍保留 safe→malicious 供安全用例使用。
      await Promise.all([
        writeFile(first.safeCharacterPackage!, exportedBytes),
        writeFile(first.maliciousCharacterPackage!, exportedBytes)
      ]);
      await expect(Promise.all([
        readFile(first.safeCharacterPackage!),
        readFile(first.maliciousCharacterPackage!)
      ])).resolves.toEqual([exportedBytes, exportedBytes]);
      await workshop.locator('[data-character-id="builtin-default"] button')
        .first()
        .click({ timeout: 10_000 });
      await workshop.getByRole('button', { name: '启用角色' }).click({
        timeout: 10_000
      });
      await expect(workshop.getByText('角色已启用。')).toBeVisible({
        timeout: 15_000
      });
      await workshop.getByRole('button', {
        name: '关闭工作台提示：角色已启用。'
      }).click();
      await workshop.getByRole('button', { name: '删除 E2E 安全角色' }).click();
      const deleteDialog = workshop.getByRole('dialog', {
        name: '删除角色“E2E 安全角色”'
      });
      await deleteDialog.getByRole('button', { name: '确认删除' }).click();
      await expect(workshop.locator(`[data-character-id="${characterId}"]`))
        .toHaveCount(0);
      await importFixtureCharacter(workshop);
      await expectWinterPackageState(first);
      await expect(workshop.getByRole('list', { name: '皮肤列表' })).toHaveCount(0);
      await workshop.getByRole('button', { name: '启用角色' }).click();
      await expect(workshop.getByText('角色已启用。')).toBeVisible({ timeout: 15_000 });
      await expectWinterRuntime(first);
    } finally {
      await first.dispose();
    }
  });
});

test.describe('角色恢复', () => {
  const workspaceRoot = resolve(process.cwd());
  const targetId = 'e2e-safe-character';
  let fixtureModule: ElectronFixtureModule;

  test.beforeAll(async () => {
    fixtureModule = await loadElectronFixtureModule();
  });

  const openWorkshop = async (fixture: AppFixture): Promise<Page> => {
    const pet = await waitForRendererPage(fixture, 'pet', 15_000);
    await pet.evaluate(() => window.myself.openCharacterWorkshop());
    return waitForRendererPage(fixture, 'characters', 15_000);
  };

  const importSafeCharacter = async (workshop: Page): Promise<void> => {
    await workshop.getByRole('button', { name: '导入角色包' }).click();
    await expect(workshop.locator('[data-character-id="e2e-safe-character"]'))
      .toBeVisible({ timeout: 15_000 });
  };

  test('非活动角色恢复问题不降级桌宠并只在选中角色时显示', async () => {
    test.setTimeout(120_000);
    const brokenDraftBytes = Buffer.from('{"version":1,"phase":"prepared"');
    const brokenPackageBytes = Buffer.from('{"version":3,"private":"marker-sentinel"');
    const recoverableId = 'recoverable-import';
    const recoverableTransactionId = '11111111-1111-4111-8111-111111111111';
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey: runtimeDiagnosticKey(),
      launchTimeoutMs: 15_000,
      enableSoftwareRasterizer: true,
      beforeRestart: async directories => {
        const charactersDirectory = join(directories.userDataDirectory, 'characters');
        const store = new CharacterStore(charactersDirectory);
        await store.create(
          { id: recoverableId, name: '待恢复半安装角色' },
          { importTransactionId: recoverableTransactionId }
        );
        await writeFile(
          join(charactersDirectory, `.package-import-rollback-${recoverableId}.json`),
          JSON.stringify({
            version: 3, characterId: recoverableId,
            importTransactionId: recoverableTransactionId
          }),
          { flag: 'wx' }
        );
        await writeFile(
          join(charactersDirectory, targetId, 'draft', 'draft-transaction.json'),
          brokenDraftBytes,
          { flag: 'wx' }
        );
        await writeFile(
          join(charactersDirectory, `.package-import-rollback-${targetId}.json`),
          brokenPackageBytes,
          { flag: 'wx' }
        );
      }
    });

    try {
      const initialWorkshop = await openWorkshop(fixture);
      await importSafeCharacter(initialWorkshop);
      await expect(initialWorkshop.locator(`[data-character-id="${targetId}"]`))
        .toHaveAttribute('data-character-active', 'false');
      await fixture.restart();

      const pet = await waitForRendererPage(fixture, 'pet', 15_000);
      await expect(pet.locator('.character-player')).toHaveAttribute(
        'data-status', 'ready', { timeout: 20_000 }
      );
      expect(await pet.evaluate(async () => (
        (await window.myself.getCharacterRuntimeSnapshot())?.activeCharacterId
      ))).toBe('builtin-default');
      const workshop = await openWorkshop(fixture);
      const snapshot = await workshop.evaluate(async () => (
        window.myself.getCharacterRecoverySnapshot()
      ));
      expect(snapshot.fallbackErrorCode).toBeNull();
      expect(snapshot.issues).toHaveLength(2);
      await workshop.locator(`[data-character-id="${targetId}"] button`).first().click();
      await expect(workshop.getByText(/角色草稿恢复受阻/)).toBeVisible();
      await expect(workshop.getByText(/角色导入恢复受阻/)).toBeVisible();
      await workshop.locator('[data-character-id="builtin-default"] button').first().click();
      await expect(workshop.getByText(/角色草稿恢复受阻/)).toHaveCount(0);
      await expect(workshop.getByText(/角色导入恢复受阻/)).toHaveCount(0);
      await expect(pet.getByRole('alert')).toHaveCount(0);

      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain(fixture.userDataDirectory);
      expect(serialized).not.toContain('marker-sentinel');
      expect(serialized).not.toMatch(/hash|token|owner|11111111/iu);
      const charactersDirectory = join(fixture.userDataDirectory, 'characters');
      await expect(readFile(join(
        charactersDirectory, targetId, 'draft', 'draft-transaction.json'
      ))).resolves.toEqual(brokenDraftBytes);
      await expect(access(join(charactersDirectory, recoverableId))).rejects.toThrow();
      const packageEvidence = (await readdir(charactersDirectory))
        .filter(name => name.startsWith(`.package-import-rollback-${targetId}.json.corrupt-`));
      expect(packageEvidence).toHaveLength(1);
      await expect(readFile(join(charactersDirectory, packageEvidence[0]!)))
        .resolves.toEqual(brokenPackageBytes);
      await pet.evaluate(() => window.myself.openChat());
      const chat = await waitForRendererPage(fixture, 'chat', 15_000);
      await submitChatMessage(chat, '非活动角色恢复后继续聊天');
      await expect(chat.getByText('请先完成模型服务设置。')).toBeVisible();
    } finally {
      await fixture.dispose();
    }
  });

  test('活动角色发布恢复受阻后切换官方默认角色并保留证据', async () => {
    test.setTimeout(120_000);
    const brokenPublishBytes = Buffer.from([0xff, 0x00, 0x7b, 0x7d]);
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey: runtimeDiagnosticKey(),
      launchTimeoutMs: 15_000,
      enableSoftwareRasterizer: true,
      beforeRestart: async directories => {
        await writeFile(
          join(directories.userDataDirectory, 'characters', targetId, 'publish-transaction.json'),
          brokenPublishBytes,
          { flag: 'wx' }
        );
      }
    });

    try {
      const initialWorkshop = await openWorkshop(fixture);
      await importSafeCharacter(initialWorkshop);
      await initialWorkshop.locator(`[data-character-id="${targetId}"] button`).first().click();
      await initialWorkshop.getByRole('button', { name: '启用角色' }).click();
      await expect(initialWorkshop.getByText('角色已启用。')).toBeVisible();
      await fixture.restart();

      const pet = await waitForRendererPage(fixture, 'pet', 15_000);
      // 完整行为门禁下恢复扫描可能超过默认 10 秒；等待预算与同组恢复用例保持一致。
      await expect(pet.locator('.character-player')).toHaveAttribute(
        'data-status', 'ready', { timeout: 20_000 }
      );
      await expect(pet.getByRole('alert')).toContainText('已切换到官方默认角色');
      await expect(pet.getByRole('button', { name: '打开角色工作室' })).toBeVisible();
      expect(await pet.evaluate(async () => (
        (await window.myself.getCharacterRuntimeSnapshot())?.activeCharacterId
      ))).toBe('builtin-default');
      await pet.getByRole('button', { name: '打开角色工作室' }).click();
      const workshop = await waitForRendererPage(fixture, 'characters', 15_000);
      await expect(workshop.locator('[data-character-id="builtin-default"]')).toBeVisible();
      await expect(workshop.locator(`[data-character-id="${targetId}"]`)).toBeVisible();
      await expect(readFile(join(
        fixture.userDataDirectory, 'characters', targetId, 'publish-transaction.json'
      ))).resolves.toEqual(brokenPublishBytes);

      await pet.evaluate(() => window.myself.openChat());
      const chat = await waitForRendererPage(fixture, 'chat', 15_000);
      await submitChatMessage(chat, '活动角色降级后继续聊天');
      await expect(chat.getByText('请先完成模型服务设置。')).toBeVisible();
    } finally {
      await fixture.dispose();
    }
  });

});

test.describe('真实桌宠像素命中与左键拖拽', () => {
  test('Win32 系统光标连续拖拽三轮时 Main 全程持有 owner 且尺寸恒定', async () => {
    test.skip(process.platform !== 'win32', '该验收只验证 Windows 原生系统光标链。');
    test.setTimeout(180_000);
    const fixtureModule = await loadElectronFixtureModule();
    const originalCursor = await readWindowsCursor();
    await setWindowsLeftButton(false);
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: runtimeDiagnosticKey(),
      launchTimeoutMs: 15_000,
      // 拖拽验收只允许系统光标改变窗口位置，排除间歇自主移动跨 DPI 屏幕的干扰。
      prepareUserData: async directories => {
        const settings = new SettingsStore(
          join(directories.userDataDirectory, 'settings.json'),
          async () => false
        );
        await settings.saveMovementMode(0);
      }
    });
    try {
      const pet = await waitForRendererPage(fixture, 'pet');
      await pet.emulateMedia({ reducedMotion: 'reduce' });
      const shell = pet.getByRole('main', { name: 'AI Pet 桌宠' });
      await expect(pet.locator('.character-player')).toHaveAttribute(
        'data-status', 'ready', { timeout: 20_000 }
      );
      await expect.poll(async () => {
        const state = await fixture.getMainE2eState();
        return {
          nativeDragging: state.petNativeDragging,
          bounds: state.petWindowBoundsDip
        };
      }, { timeout: 20_000 }).toMatchObject({
        nativeDragging: false,
        bounds: { width: expect.any(Number), height: expect.any(Number) }
      });
      const idleBounds = (await fixture.getMainE2eState()).petWindowBoundsDip;
      await new Promise(resolve => setTimeout(resolve, 1_000));
      expect((await fixture.getMainE2eState()).petWindowBoundsDip).toMatchObject({
        width: idleBounds.width,
        height: idleBounds.height
      });
      const dispatchPointerMove = async (point: { x: number; y: number }): Promise<void> => {
        await shell.evaluate((element, value) => {
          element.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            clientX: value.x,
            clientY: value.y,
            pointerId: 73
          }));
        }, point);
      };
      let visible: { x: number; y: number } | undefined;
      for (let y = 6; y < 220 && !visible; y += 8) {
        for (let x = 6; x < 180; x += 8) {
          if (x >= 140 && y >= 178) continue;
          const candidate = { x, y };
          await dispatchPointerMove(candidate);
          if (!(await fixture.getPetInteractionProbe()).passthrough) {
            visible = candidate;
            break;
          }
        }
      }
      expect(visible, '应找到可由真实左键按住的可见像素').toBeDefined();
      if (!visible) return;

      const measureRenderer = () => pet.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          '.character-player-host canvas'
        );
        const rect = canvas?.getBoundingClientRect();
        return {
          width: window.outerWidth,
          height: window.outerHeight,
          canvas: rect ? { width: rect.width, height: rect.height } : null
        };
      });

      const mainSizeBaseline = (await fixture.getMainE2eState()).petWindowBoundsDip;
      const rendererSizeBaseline = await measureRenderer();
      const mainSizeSamples: Array<{ width: number; height: number }> = [];
      const recordMainSize = (bounds: { width: number; height: number }): void => {
        mainSizeSamples.push({ width: bounds.width, height: bounds.height });
        // Windows 物理像素换算为 DIP 时可能随窗口位置产生 ±1 的非累积取整差。
        const evidence = JSON.stringify({ mainSizeBaseline, bounds });
        expect(Math.abs(bounds.width - mainSizeBaseline.width), evidence).toBeLessThanOrEqual(1);
        expect(Math.abs(bounds.height - mainSizeBaseline.height), evidence).toBeLessThanOrEqual(1);
      };
      recordMainSize(mainSizeBaseline);
      const rendererCanvasSamples = new Set<string>([[
        rendererSizeBaseline.canvas?.width ?? 'null',
        rendererSizeBaseline.canvas?.height ?? 'null'
      ].join('x')]);
      const recordRendererSize = (size: typeof rendererSizeBaseline): void => {
        expect(Math.abs(size.width - rendererSizeBaseline.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(size.height - rendererSizeBaseline.height)).toBeLessThanOrEqual(1);
        expect(size.canvas).toEqual(rendererSizeBaseline.canvas);
        rendererCanvasSamples.add([
          size.canvas?.width ?? 'null', size.canvas?.height ?? 'null'
        ].join('x'));
      };
      for (let round = 0; round < 3; round += 1) {
        let roundVisible = visible;
        for (let y = 6; y < 220; y += 8) {
          for (let x = 6; x < 180; x += 8) {
            if (x >= 140 && y >= 178) continue;
            const candidate = { x, y };
            await dispatchPointerMove(candidate);
            if (!(await fixture.getPetInteractionProbe()).passthrough) {
              roundVisible = candidate;
              break;
            }
          }
          if (!(await fixture.getPetInteractionProbe()).passthrough) break;
        }
        const mainBeforeHover = (await fixture.getMainE2eState()).petWindowBoundsDip;
        recordMainSize(mainBeforeHover);
        await raiseWindowsProcessWindow(fixture.processId);
        await expect.poll(async () => (
          await fixture.getMainE2eState()
        ).petWindowAlwaysOnTop).toBe(false);
        recordMainSize((await fixture.getMainE2eState()).petWindowBoundsDip);
        const nativeBeforeHover = await readWindowsProcessWindowRect(fixture.processId);
        const physicalPerDipX = (
          nativeBeforeHover.right - nativeBeforeHover.left
        ) / mainBeforeHover.width;
        const physicalPerDipY = (
          nativeBeforeHover.bottom - nativeBeforeHover.top
        ) / mainBeforeHover.height;
        const nativeTargetPoint = {
          x: nativeBeforeHover.left + Math.round(roundVisible.x * physicalPerDipX),
          y: nativeBeforeHover.top + Math.round(roundVisible.y * physicalPerDipY)
        };
        await setWindowsCursor(nativeTargetPoint);
        await expect.poll(() => fixture.getPetInteractionProbe()).toMatchObject({
          passthrough: false,
          dragging: false
        });
        await expect.poll(async () => (
          await readWindowsPointerTarget()
        ).processId, {
          message: JSON.stringify({
            fixtureProcessId: fixture.processId,
            mainBeforeHover,
            nativeBeforeHover,
            nativeTargetPoint,
            roundVisible,
            physicalPerDipX,
            physicalPerDipY
          })
        }).toBe(fixture.processId);
        const cursorAtStart = await readWindowsCursor();
        const mainAtStart = (await fixture.getMainE2eState()).petWindowBoundsDip;
        recordMainSize(mainAtStart);
        const rendererAtStart = await measureRenderer();
        recordRendererSize(rendererAtStart);
        const available = await pet.evaluate(() => ({
          left: (window.screen as Screen & { availLeft?: number }).availLeft ?? 0,
          width: window.screen.availWidth
        }));
        const direction = mainAtStart.x < available.left + available.width / 2 ? 1 : -1;
        await setWindowsLeftButton(true);
        await expect.poll(async () => (
          await readWindowsPointerTarget()
        ).leftButtonDown).toBe(true);

        // 先以第一次 Main 权威位置变化为锚点，避免把物理像素与 DIP
        // 的初始取整差误判成桌宠跟随延迟；真实 Win32 注入也可能在首次移动时才投递按下事件。
        let nativeDragStarted = false;
        for (let primeStep = 1; primeStep <= 20; primeStep += 1) {
          const primePhysicalDelta = Math.round(primeStep * physicalPerDipX);
          await setWindowsCursor({
            x: cursorAtStart.x + direction * primePhysicalDelta,
            y: cursorAtStart.y
          });
          nativeDragStarted = (
            await fixture.getMainE2eState()
          ).petWindowBoundsDip.x !== mainAtStart.x;
          if (nativeDragStarted) break;
        }
        expect(nativeDragStarted, '连续系统光标事件应启动 Main 权威拖拽').toBe(true);
        await expect.poll(() => fixture.getPetInteractionProbe()).toMatchObject({ dragging: true });
        await expect.poll(async () => (
          await fixture.getMainE2eState()
        ).petNativeDragging).toBe(true);
        const cursorAtDragAnchor = await readWindowsCursor();
        const mainAtDragAnchor = (await fixture.getMainE2eState()).petWindowBoundsDip;
        recordMainSize(mainAtDragAnchor);

        // 长按停顿期间 owner 和几何 blocker 必须保持，不允许自主运动或布局事务插入。
        await new Promise(resolve => setTimeout(resolve, 5_500));
        const heldState = await fixture.getMainE2eState();
        expect(heldState.petNativeDragging).toBe(true);
        expect(await fixture.getPetInteractionProbe()).toMatchObject({ dragging: true });
        recordMainSize(heldState.petWindowBoundsDip);

        for (let step = 1; step <= 20; step += 1) {
          const physicalDelta = Math.round(step * physicalPerDipX);
          const expectedDipDelta = Math.round(physicalDelta / physicalPerDipX);
          await setWindowsCursor({
            x: cursorAtDragAnchor.x + direction * physicalDelta,
            y: cursorAtDragAnchor.y
          });
          await expect.poll(async () => Math.abs(
            (await fixture.getMainE2eState()).petWindowBoundsDip.x
            - (mainAtDragAnchor.x + direction * expectedDipDelta)
          // 锚点之后只允许 Windows 物理像素与 DIP 换算产生非累积取整差。
          ), { timeout: 3_000 }).toBeLessThanOrEqual(2);
          const mainState = await fixture.getMainE2eState();
          expect(mainState.petNativeDragging).toBe(true);
          expect(await fixture.getPetInteractionProbe()).toMatchObject({ dragging: true });
          const mainCurrent = mainState.petWindowBoundsDip;
          recordMainSize(mainCurrent);
          expect(mainCurrent.y).toBe(mainAtDragAnchor.y);
          const rendererCurrent = await measureRenderer();
          recordRendererSize(rendererCurrent);
        }
        await setWindowsLeftButton(false);
        await expect.poll(async () => (
          await readWindowsPointerTarget()
        ).leftButtonDown).toBe(false);
        await expect.poll(async () => (
          await fixture.getMainE2eState()
        ).petNativeDragging).toBe(false);
        await expect.poll(async () => (
          await fixture.getMainE2eState()
        ).geometry, { timeout: 10_000 }).not.toBeNull();
        await expect.poll(() => fixture.getPetInteractionProbe()).toMatchObject({
          dragging: false
        });
        const mainAfterRelease = (await fixture.getMainE2eState()).petWindowBoundsDip;
        recordMainSize(mainAfterRelease);
      }
      expect(mainSizeSamples.length, '三轮真实拖拽必须逐步采集 Main 尺寸').toBeGreaterThan(60);
      expect(rendererCanvasSamples.size, '三轮真实拖拽期间角色 Canvas 尺寸集合必须唯一').toBe(1);
    } finally {
      await setWindowsLeftButton(false).catch(() => undefined);
      await setWindowsCursor(originalCursor).catch(() => undefined);
      await fixture.dispose();
    }
  });
});

test.describe('真实角色工作室闭环', () => {
  test('V3 人设、自定义状态动作与有限播放在发布重启回导中保持一致', async () => {
    test.setTimeout(300_000);
    const fixtureModule = await loadElectronFixtureModule();

    const workspaceRoot = resolve(process.cwd());
    const apiKey = runtimeDiagnosticKey();
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey,
      launchTimeoutMs: 15_000,
      enableSoftwareRasterizer: true
    });
    type AppFixture = Awaited<
      ReturnType<ElectronFixtureModule['createElectronAppFixture']>
    >;
    const diagnostics: string[] = [];
    const sensitiveFixtures: AppFixture[] = [fixture];
    let exportedPackage = '';
    let exportedBytes: Uint8Array | null = null;
    let recoverySnapshot = '';
    let characterProvider: Awaited<ReturnType<typeof startProviderServer>> | null = null;
    let publishedCustomState: { id: string; actionIds: string[] } | null = null;
    const sanitizeDiagnostic = (text: string): string => sanitizeCapturedDiagnostic(
      text,
      apiKey,
      recoverySnapshot,
      exportedPackage,
      ...(characterProvider ? [characterProvider.apiKey] : []),
      ...sensitiveFixtures.flatMap(candidate => [
        candidate.authorizedRootDirectory,
        candidate.userDataDirectory,
        candidate.characterAssetsDirectory,
        candidate.safeCharacterPackage,
        candidate.maliciousCharacterPackage,
        candidate.characterExportDestination
      ])
    );
    const observedPages = new WeakSet<Page>();
    const observeFixturePages = (appFixture: AppFixture, phase: string): Page[] => {
      const currentPages = appFixture.browser.contexts()
        .flatMap(context => context.pages());
      for (const page of currentPages) {
        if (observedPages.has(page)) continue;
        observedPages.add(page);
        page.setDefaultTimeout(15_000);
        page.on('console', message => {
          diagnostics.push(sanitizeDiagnostic(
            `[${phase}:${page.url()}] console ${message.type()}: ${message.text()}`
          ));
        });
        page.on('pageerror', error => {
          diagnostics.push(sanitizeDiagnostic(
            `[${phase}:${page.url()}] pageerror: ${error.message}`
          ));
        });
      }
      return currentPages;
    };
    const pageFor = (
      appFixture: AppFixture,
      view: string,
      phase: string
    ): Page | undefined => observeFixturePages(appFixture, phase).find(page => {
      try {
        return new URL(page.url()).searchParams.get('view') === view;
      } catch {
        return false;
      }
    });
    const waitForPage = async (
      appFixture: AppFixture,
      view: string,
      step: string
    ): Promise<Page> => {
      try {
        await expect.poll(async () => {
          const page = pageFor(appFixture, view, step);
          return page ? page.locator('main').count() : 0;
        }, {
          timeout: 15_000,
          message: `E2E 步骤“${step}”未等到 ${view} Renderer 的 main`
        }).toBeGreaterThan(0);
        return pageFor(appFixture, view, step)!;
      } catch (error) {
        throw new Error(
          sanitizeDiagnostic(`${String(error)}\nE2E 诊断：${diagnostics.join(' | ')}`)
        );
      }
    };
    const waitForVisibleView = async (page: Page, step: string): Promise<void> => {
      await expect.poll(
        () => page.evaluate(() => document.visibilityState),
        {
          timeout: 15_000,
          message: `E2E 步骤“${step}”的窗口未进入可见状态`
        }
      ).toBe('visible');
      await expect(page.locator('main'), `E2E 步骤“${step}”的 main 不可见`)
        .toBeVisible({ timeout: 15_000 });
    };
    const clickReadyButton = async (
      page: Page,
      name: string,
      step: string
    ): Promise<void> => {
      const button = page.getByRole('button', { name });
      await expect(button, `E2E 步骤“${step}”的按钮不可见`)
        .toBeVisible({ timeout: 15_000 });
      await expect(button, `E2E 步骤“${step}”的按钮不可操作`)
        .toBeEnabled({ timeout: 15_000 });
      await button.click({ timeout: 15_000 });
    };
    const closeWorkshopToast = async (
      page: Page,
      text: string
    ): Promise<void> => {
      const close = page.getByRole('button', {
        name: `关闭工作台提示：${text}`
      });
      await expect(close).toBeVisible({ timeout: 15_000 });
      await close.click();
    };
    const expectExactIdlePresentation = async (page: Page): Promise<void> => {
      await expect(page.getByRole('region', { name: '序列帧时间轴' }).locator('li'))
        .toHaveCount(4);
      await expect(page.getByLabel('ground X')).toHaveValue('0.45');
      await expect(page.getByLabel('ground Y')).toHaveValue('0.95');
    };
    const selectIdleAction = async (
      page: Page,
      actionName: RegExp,
      step: string
    ): Promise<void> => {
      const stateList = page.getByRole('list', { name: '状态与动作列表' });
      const idleState = stateList.locator(':scope > li').filter({
        has: page.getByRole('button', { name: /^待机/u })
      }).first();
      const idleStateButton = idleState.getByRole('button', { name: /^待机/u }).first();
      await idleStateButton.click();
      await expect(idleStateButton, `E2E 步骤“${step}”未选中待机状态`)
        .toHaveAttribute('aria-pressed', 'true');

      const actionButton = idleState.getByRole('list', { name: '待机动作' })
        .getByRole('button', { name: actionName });
      await expect(actionButton, `E2E 步骤“${step}”的待机动作不可见`)
        .toBeVisible();
      await expect(actionButton, `E2E 步骤“${step}”的待机动作不可操作`)
        .toBeEnabled();
      await actionButton.click();
    };
    const openWorkshop = async (
      appFixture: AppFixture,
      phase: string
    ): Promise<Page> => {
      const pet = await waitForPage(appFixture, 'pet', `${phase}：等待桌宠`);
      await waitForVisibleView(pet, `${phase}：桌宠就绪`);
      await pet.evaluate(() => window.myself.openChat());
      const chat = await waitForPage(appFixture, 'chat', `${phase}：等待聊天`);
      await waitForVisibleView(chat, `${phase}：聊天就绪`);
      await clickReadyButton(chat, '设置', `${phase}：打开设置`);
      const settings = await waitForPage(appFixture, 'settings', `${phase}：等待设置`);
      await waitForVisibleView(settings, `${phase}：设置就绪`);
      await clickReadyButton(settings, '角色工作室', `${phase}：打开工作室`);
      const workshop = await waitForPage(
        appFixture,
        'characters',
        `${phase}：等待角色工作室`
      );
      await waitForVisibleView(workshop, `${phase}：角色工作室就绪`);
      return workshop;
    };
    observeFixturePages(fixture, '初始启动');

    let primaryError: unknown = null;
    let recoveryCleanupError: unknown = null;
    try {
    try {
      const workshop = await openWorkshop(fixture, '初始启动');
      const petDiagnostics: string[] = [];
      const diagnosticPet = await waitForPage(fixture, 'pet', '初始启动：读取桌宠诊断');
      diagnosticPet.on('console', message => petDiagnostics.push(
        sanitizeDiagnostic(message.text())
      ));
      diagnosticPet.on('pageerror', error => petDiagnostics.push(
        sanitizeDiagnostic(error.message)
      ));
      await workshop.getByRole('button', { name: '新建角色' }).click();
      await workshop.getByLabel('角色名称').fill('E2E 工作室角色');
      await workshop.getByRole('button', { name: '创建角色' }).click();
      await expect(workshop.getByRole('button', { name: /^E2E 工作室角色/ }))
        .toBeVisible();

      // 人设与动作表现通过正式受控表单写入，后续由同一闭环验证持久化与包等价。
      await workshop.getByRole('button', { name: '编辑角色人设' }).click();
      await workshop.getByLabel('角色描述').fill('喜欢整理桌面的伙伴');
      await workshop.getByLabel('角色背景').fill('从冬日窗边来到桌面的伙伴');
      await workshop.getByLabel('语言风格').fill('温和而简洁');
      await workshop.getByRole('button', { name: '添加性格标签' }).click();
      await workshop.getByRole('group', { name: '性格标签' })
        .getByRole('textbox')
        .fill('细心');
      await workshop.getByRole('button', {
        name: '向“待机”添加动作'
      }).click();
      await workshop.getByRole('button', { name: '导入素材' }).click();
      await workshop.getByLabel('已导入素材').selectOption({ label: 'idle.png' });
      await workshop.getByLabel('行数').fill('2');
      await workshop.getByLabel('列数').fill('2');
      await workshop.getByLabel('有效帧数').fill('4');
      await workshop.getByRole('button', { name: '应用到当前动作' }).click();
      await expect(workshop.getByText('精灵图网格已应用到当前动作。')).toBeVisible();
      await closeWorkshopToast(workshop, '精灵图网格已应用到当前动作。');
      const idleActionDelete = workshop.getByRole('button', {
        name: '删除动作“动作 1”'
      });
      await workshop.getByRole('button', {
        name: '向“待机”添加动作'
      }).click();
      const emptyActionDelete = workshop.getByRole('button', {
        name: '删除动作“动作 2”'
      });
      await expect(emptyActionDelete).toBeVisible();
      await emptyActionDelete.click();
      const emptyActionDeleteDialog = workshop.getByRole('dialog', {
        name: '删除动作“动作 2”'
      });
      await expect(emptyActionDeleteDialog).toContainText('states.0.actionIds');
      await emptyActionDeleteDialog.getByRole('button', { name: '确认删除' }).click();
      await expect(emptyActionDelete).toHaveCount(0);
      await idleActionDelete.click();
      const configuredActionDeleteDialog = workshop.getByRole('dialog', {
        name: '删除动作“动作 1”'
      });
      await expect(configuredActionDeleteDialog).toContainText('skins.0.presentations');
      await configuredActionDeleteDialog.getByRole('button', { name: '取消' }).click();
      await expect(configuredActionDeleteDialog).toHaveCount(0);
      await expect(idleActionDelete).toBeVisible();
      const draftPreview = workshop.locator('[data-preview-status]');
      await expect(draftPreview).toHaveAttribute('data-preview-status', 'ready');
      await expect(workshop.getByText('当前使用：当前皮肤精确表现')).toBeVisible();
      await workshop.getByRole('button', { name: '切换左右方向' }).click();
      await expect(draftPreview).toHaveAttribute('data-preview-direction', 'left');
      await workshop.locator('.preview-controls input[type="range"]').fill('1.5');
      await expect(draftPreview).toHaveAttribute('data-preview-speed', '1.5');
      await workshop.getByLabel('ground X').fill('0.45');
      await workshop.getByLabel('ground Y').fill('0.95');
      await expectExactIdlePresentation(workshop);

      // 作者定义一个状态和两个动作，名称、描述与有限播放均沿正式编辑表单保存。
      await workshop.getByRole('button', { name: '添加扩展状态' }).click();
      const stateNameInput = workshop.getByLabel('状态名称');
      await expect(stateNameInput).toBeFocused();
      const createStateButton = workshop.getByRole('button', { name: '创建自定义状态' });
      await expect(createStateButton).toBeDisabled();
      await stateNameInput.fill('星光时刻');
      await workshop.getByLabel('状态描述（可选）').fill('收到好消息后轻快而安心地陪伴伙伴。');
      await createStateButton.click();
      await workshop.getByLabel('允许智能体推断').check();
      const customState = workshop.getByRole('list', { name: '状态与动作列表' })
        .getByRole('listitem')
        .filter({ has: workshop.getByRole('button', { name: /^星光时刻/u }) });
      for (const [name, description] of [
        ['轻轻摇摆', '喜悦持续时轻轻摇摆。'],
        ['向你挥手', '短暂抬手，向伙伴打个招呼。']
      ]) {
        await customState.getByRole('button', { name: '向“星光时刻”添加动作' }).click();
        await workshop.getByLabel('动作名称').fill(name);
        await workshop.getByLabel('动作详细描述').fill(description);
        await workshop.getByLabel('循环策略').selectOption('until-interrupted');
        await workshop.getByLabel('已导入素材').selectOption({ label: 'idle.png' });
        await workshop.getByRole('button', { name: '应用到当前动作' }).click();
        await expect(workshop.getByText('精灵图网格已应用到当前动作。')).toBeVisible();
        await closeWorkshopToast(workshop, '精灵图网格已应用到当前动作。');
        // 首帧作者时长让一次明确动作稳定可观察；无限循环素材仍须在一次播放后返回。
        await workshop.getByLabel('当前帧时长').fill('1200');
      }
      await selectIdleAction(workshop, /^动作 1/u, '初始启动：恢复待机精确表现');
      await expectExactIdlePresentation(workshop);
      await workshop.getByRole('button', { name: '编译并发布' }).click();
      await expect(workshop.getByText('运行版本已编译并发布。')).toBeVisible();
      await closeWorkshopToast(workshop, '运行版本已编译并发布。');

      const createdCharacterItem = workshop.getByRole('list', { name: '角色列表' })
        .getByRole('listitem')
        .filter({ has: workshop.getByRole('button', { name: /^E2E 工作室角色/ }) });
      await expect(createdCharacterItem)
        .toHaveAttribute('data-character-completeness', 'complete');
      await workshop.getByRole('button', { name: '启用角色' }).click();
      await expect(workshop.getByText('角色已启用。')).toBeVisible();
      await closeWorkshopToast(workshop, '角色已启用。');

      const pet = await waitForPage(fixture, 'pet', '初始启动：验证角色播放器');
      try {
        await expect(pet.locator('.character-player')).toHaveAttribute('data-status', 'ready');
      } catch (error) {
        throw new Error(sanitizeDiagnostic(
          `${String(error)}\n角色播放器诊断：${petDiagnostics.join(' | ')}`
        ));
      }
      const runtime = await pet.evaluate(async () => (
        (await window.myself.getCharacterRuntimeSnapshot())?.manifest ?? null
      ));
      expect(runtime?.version).toBe(3);
      const authoredState = runtime?.states.find(state => state.name === '星光时刻');
      expect(authoredState?.actionIds).toHaveLength(2);
      if (!runtime || !authoredState) throw new Error('E2E_V3_AUTHORED_STATE_MISSING');
      publishedCustomState = { id: authoredState.id, actionIds: [...authoredState.actionIds] };
      const moodActionId = authoredState.actionIds[0]!;
      const explicitActionId = authoredState.actionIds[1]!;
      expect(runtime.states.find(state => state.id === runtime.idleStateId)?.actionIds).toHaveLength(1);
      for (const actionId of authoredState.actionIds) {
        expect(runtime.presentations.find(item => item.actionId === actionId))
          .toMatchObject({ skinId: runtime.skinId, source: 'skin-action' });
      }

      characterProvider = await startProviderServer([
      behaviorBindingsStep(),
        ...characterChatSteps('我会原地陪伴你。', {}, {inspect: expectCharacterChatRequest}),
        ...characterChatSteps('听到你的好消息，我也很开心。', {
            kind: 'background', choice: { stateId: authoredState.id, actionId: moodActionId }
          }, { inspect: expectCharacterChatRequest }, request => {
            const system = request.messages.filter(message => message.role === 'system')
              .map(message => message.content).join('\n');
            for (const text of [
              '喜欢整理桌面的伙伴', '从冬日窗边来到桌面的伙伴', '温和而简洁', '细心',
              '收到好消息后轻快而安心地陪伴伙伴。', '喜悦持续时轻轻摇摆。',
              '短暂抬手，向伙伴打个招呼。', authoredState.id, moodActionId, explicitActionId
            ]) expect(system).toContain(text);
          }),
        ...characterChatSteps('向你挥手后，继续陪你开心。', {}, {inspect: expectCharacterChatRequest})
      ]);
      await pet.evaluate(async ({ baseUrl, apiKey }) => {
        await window.myself.saveProviderProfile({
          profile: { id: 'workshop-v3', displayName: 'V3 工作室闭环', mode: 'custom',
            protocol: 'openai-compatible', baseUrl, modelId: 'workshop-v3',
            additionalParameters: {}, capabilities: ['chat', 'tools'] },
          secret: apiKey, persistSecret: false
        });
        await window.myself.saveModelRoute({
          primaryProfileId: 'workshop-v3', chatProfileId: 'workshop-v3',
          agentProfileId: 'workshop-v3', visionProfileId: null,
          fallbackProfileIds: [], allowCrossProviderFallback: false
        });
        await window.myself.savePrivacySettings({
          dataCategories: { memory: false }, longTermMemory: false,
          proactivityMode: 'passive', autonomousMoodEnabled: false
        });
        await window.myself.openChat();
      }, { baseUrl: characterProvider.baseUrl, apiKey: characterProvider.apiKey });
      const chat = await waitForPage(fixture, 'chat', '初始启动：验证自定义表现');
      await waitForVisibleView(chat, '初始启动：聊天就绪');
      await submitChatMessage(chat, '停下');
      await expect(chat.getByText('我会原地陪伴你。')).toBeVisible();
      await pet.evaluate(() => {
        const scope = globalThis as typeof globalThis & {
          __workshopPlays?: Array<{ stateId: string; actionId: string; mode: string }>;
        };
        scope.__workshopPlays = [];
        window.myself.subscribeCharacterMotion(event => {
          if (event.type === 'behavior-action') scope.__workshopPlays?.push({
            stateId: event.stateId, actionId: event.actionId, mode: event.playback.mode
          });
        });
      });
      await submitChatMessage(chat, '今天我的小目标完成了，你也开心吗？');
      await expect(chat.getByText('听到你的好消息，我也很开心。')).toBeVisible();
      await expect.poll(() => fixture.getCharacterBehaviorProbe()).toMatchObject({
        stateId: authoredState.id, actionId: moodActionId, playbackStatus: 'started'
      });
      await submitChatMessage(chat, '播放向你挥手动作');
      try {
        await expect.poll(() => fixture.getCharacterBehaviorProbe(), { intervals: [50, 100, 200] })
          .toMatchObject({ stateId: authoredState.id, actionId: explicitActionId, playbackStatus: 'started' });
      } catch (error) {
        // 失败时只投影合成角色的动作与时序字段，不输出完整草稿、资源或设置。
        const explicitPlaybackDiagnostic = {
          plays: await pet.evaluate(() => (
            (globalThis as typeof globalThis & {
              __workshopPlays?: Array<{ stateId: string; actionId: string; mode: string }>;
            }).__workshopPlays ?? []
          )),
          state: { id: authoredState.id, name: authoredState.name },
          actions: await workshop.evaluate(async ({ characterId, actionIds }) => {
            const draft = await window.myself.getCharacterDraft(characterId);
            return actionIds.map(id => ({ id, name: draft.actions.find(action => action.id === id)?.name ?? null }));
          }, { characterId: runtime.id, actionIds: [...authoredState.actionIds] }),
          presentations: authoredState.actionIds.map(actionId => {
            const presentation = runtime.presentations.find(item => item.actionId === actionId)?.presentation;
            return { actionId, durationMs: presentation?.frames.map(frame => frame.durationMs ?? null) ?? null,
              fps: presentation?.fps ?? null, playbackRate: presentation?.playbackRate ?? null };
          }),
          userInChatDom: await chat.getByText('播放向你挥手动作', { exact: true }).count() > 0,
          assistantInChatDom: await chat.getByText('向你挥手后，继续陪你开心。', { exact: true }).count() > 0
        };
        throw sanitizedCapturedError(error, message => sanitizeDiagnostic(
          `${message}\n明确动作诊断：${JSON.stringify(explicitPlaybackDiagnostic)}`
        ));
      }
      await expect(chat.getByText('向你挥手后，继续陪你开心。')).toBeVisible();
      // 不发送下一条消息，真实 Renderer 完成一次动作后恢复仍有效的心情动作。
      await expect.poll(() => fixture.getCharacterBehaviorProbe(), { timeout: 15_000 })
        .toMatchObject({ stateId: authoredState.id, actionId: moodActionId, playbackStatus: 'started' });
      const plays = await pet.evaluate(() => (
        (globalThis as typeof globalThis & {
          __workshopPlays?: Array<{ stateId: string; actionId: string; mode: string }>;
        }).__workshopPlays ?? []
      ));
      expect(plays).toEqual([
        { stateId: authoredState.id, actionId: moodActionId, mode: 'loop' },
        { stateId: authoredState.id, actionId: explicitActionId, mode: 'once' },
        { stateId: authoredState.id, actionId: moodActionId, mode: 'loop' }
      ]);
      expect((await pet.evaluate(() => window.myself.getCharacterMotionSnapshot())).moving).toBe(false);
      characterProvider.assertComplete();
      expect(characterProvider.inspectionErrors).toEqual([]);

      await workshop.getByRole('button', { name: '导出角色包' }).click();
      await expect(workshop.getByText('角色包已导出。')).toBeVisible();
      await closeWorkshopToast(workshop, '角色包已导出。');
      exportedPackage = fixture.characterExportDestination!;
      exportedBytes = await readFile(exportedPackage);
      expect(exportedBytes.byteLength).toBeGreaterThan(0);

      await workshop.getByLabel('动作名称').fill('冬日待机');
      await workshop.getByRole('button', { name: '保存草稿' }).click();
      await expect(workshop.getByText('草稿已保存', { exact: true })).toBeVisible();
      await expect(workshop.getByRole('button', {
        name: '关闭工作台提示：草稿已保存'
      })).toHaveCount(0);
      recoverySnapshot = await mkdtemp(join(tmpdir(), 'ai-pet-character-recovery-'));
      await cp(
        join(fixture.userDataDirectory, 'characters'),
        join(recoverySnapshot, 'characters'),
        { recursive: true }
      );
    } finally {
      try { await fixture.dispose(); } finally { await characterProvider?.close(); }
    }

    const recovered = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey,
      launchTimeoutMs: 15_000,
      enableSoftwareRasterizer: true,
      prepareUserData: async directories => {
        await cp(
          join(recoverySnapshot, 'characters'),
          join(directories.userDataDirectory, 'characters'),
          {
            recursive: true,
            force: true
          }
        );
      }
    });
    sensitiveFixtures.push(recovered);
    observeFixturePages(recovered, '重启恢复');
    try {
      const workshop = await openWorkshop(recovered, '重启恢复');
      const pet = await waitForPage(recovered, 'pet', '重启恢复：读取活动角色');
      const recoveredCharacter = workshop.getByRole('button', {
        name: /^E2E 工作室角色/
      });
      await expect(recoveredCharacter).toBeVisible({ timeout: 15_000 });
      await recoveredCharacter.click();
      await workshop.getByRole('button', { name: '编辑角色人设' }).click();
      await expect(workshop.getByLabel('角色描述'))
        .toHaveValue('喜欢整理桌面的伙伴');
      await expect(workshop.getByLabel('角色背景'))
        .toHaveValue('从冬日窗边来到桌面的伙伴');
      await expect(workshop.getByLabel('语言风格')).toHaveValue('温和而简洁');
      await expect(workshop.getByRole('group', { name: '性格标签' })
        .getByRole('textbox')).toHaveValue('细心');
      await selectIdleAction(workshop, /^冬日待机/u, '重启恢复：选择待机动作');
      await expect(workshop.getByLabel('已导入素材')).toContainText('idle.png');
      await expect(workshop.getByLabel('动作名称'))
        .toHaveValue('冬日待机', { timeout: 15_000 });
      await expect(workshop.getByText('当前使用：当前皮肤精确表现')).toBeVisible();
      const recoveredPreview = workshop.locator('[data-preview-status]');
      await expect(recoveredPreview).toHaveAttribute('data-preview-status', 'ready');
      await expectExactIdlePresentation(workshop);
      await expect(workshop.getByRole('button', {
        name: '向“待机”添加动作'
      })).toBeVisible();
      await expect(workshop.getByRole('button', {
        name: '删除动作“冬日待机”'
      })).toBeVisible();
      await expect(
        workshop.getByRole('region', { name: '序列帧时间轴' })
          .locator('li')
          .first()
          .getByRole('button')
      ).toHaveAttribute('aria-pressed', 'true');
      const active = await pet.evaluate(async () => (
        (await window.myself.getCharacterRuntimeSnapshot())?.activeCharacterId
      ));
      expect(active).not.toBe('builtin-default');
      expect(await pet.evaluate(async () => (
        (await window.myself.getCharacterRuntimeSnapshot())?.manifest.states
          .find(state => state.name === '星光时刻')
      ))).toMatchObject(publishedCustomState!);
    } finally {
      await recovered.dispose();
    }

    const isolated = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey,
      launchTimeoutMs: 15_000,
      enableSoftwareRasterizer: true,
      prepareUserData: async directories => {
        if (!directories.packagesDirectory) {
          throw new Error('缺少隔离角色包目录');
        }
        if (!exportedBytes) throw new Error('缺少已导出的角色包');
        await writeFile(
          join(directories.packagesDirectory, 'safe-character.zip'),
          exportedBytes
        );
      }
    });
    sensitiveFixtures.push(isolated);
    observeFixturePages(isolated, '隔离导入');
    try {
      const workshop = await openWorkshop(isolated, '隔离导入');
      const pet = await waitForPage(isolated, 'pet', '隔离导入：读取桌宠状态');

      await clickReadyButton(workshop, '导入角色包', '隔离导入：导入安全角色包');
      const importedCharacter = workshop.getByRole('button', { name: /^E2E 工作室角色/ });
      await expect(importedCharacter).toBeVisible({ timeout: 15_000 });
      await importedCharacter.click();
      await workshop.getByRole('button', { name: '编辑角色人设' }).click();
      await expect(workshop.getByLabel('角色描述'))
        .toHaveValue('喜欢整理桌面的伙伴');
      await expect(workshop.getByLabel('角色背景'))
        .toHaveValue('从冬日窗边来到桌面的伙伴');
      await expect(workshop.getByLabel('语言风格')).toHaveValue('温和而简洁');
      await expect(workshop.getByRole('group', { name: '性格标签' })
        .getByRole('textbox')).toHaveValue('细心');
      await selectIdleAction(workshop, /^动作 1/u, '隔离导入：选择待机动作');
      await expect(workshop.getByText('当前使用：当前皮肤精确表现')).toBeVisible();
      await expectExactIdlePresentation(workshop);
      const characterList = workshop.getByRole('list', { name: '角色列表' });
      const summariesBefore = await characterList.getByRole('listitem').evaluateAll(items => (
        items.map(item => ({
          id: (item as HTMLElement).dataset.characterId,
          active: (item as HTMLElement).dataset.characterActive,
          completeness: (item as HTMLElement).dataset.characterCompleteness,
          text: item.textContent
        }))
      ));
      const runtimeBefore = await pet.evaluate(async () => ({
        activeCharacterId: (
          await window.myself.getCharacterRuntimeSnapshot()
        )?.activeCharacterId ?? null,
        state: document.querySelector('main[data-character-state]')
          ?.getAttribute('data-character-state') ?? null
      }));
      const isolatedCharactersDirectory = join(
        isolated.userDataDirectory,
        'characters'
      );
      await expect.poll(async () => (
        await snapshotCharacterPersistence(isolatedCharactersDirectory)
      ).tree.some(entry => (
        entry.type === 'file' && entry.path.startsWith('.locks/')
      )), {
        message: '安全角色包导入锁应在持久化快照前释放'
      }).toBe(false);
      const persistenceBefore = await snapshotCharacterPersistence(
        isolatedCharactersDirectory
      );
      await clickReadyButton(workshop, '导入角色包', '隔离导入：拒绝恶意角色包');
      await expect(workshop.getByRole('alert'))
        .toContainText('角色包包含不安全路径，已拒绝导入。', { timeout: 15_000 });
      expect(await characterList.getByRole('listitem').evaluateAll(items => (
        items.map(item => ({
          id: (item as HTMLElement).dataset.characterId,
          active: (item as HTMLElement).dataset.characterActive,
          completeness: (item as HTMLElement).dataset.characterCompleteness,
          text: item.textContent
        }))
      ))).toEqual(summariesBefore);
      expect(await pet.evaluate(async () => ({
        activeCharacterId: (
          await window.myself.getCharacterRuntimeSnapshot()
        )?.activeCharacterId ?? null,
        state: document.querySelector('main[data-character-state]')
          ?.getAttribute('data-character-state') ?? null
      }))).toEqual(runtimeBefore);
      expect(await snapshotCharacterPersistence(
        isolatedCharactersDirectory
      )).toEqual(persistenceBefore);
    } finally {
      await isolated.dispose();
    }
    } catch (error) {
      primaryError = sanitizedCapturedError(error, sanitizeDiagnostic);
    } finally {
      if (recoverySnapshot) {
        try {
          await rm(recoverySnapshot, { recursive: true, force: true });
        } catch (error) {
          recoveryCleanupError = sanitizedCapturedError(error, sanitizeDiagnostic);
        }
      }
    }

    if (primaryError && recoveryCleanupError) {
      throw new AggregateError(
        [primaryError, recoveryCleanupError],
        sanitizeDiagnostic(
          `角色工作室闭环失败：${String(primaryError)}\n附加清理诊断：${String(recoveryCleanupError)}`
        ),
        { cause: primaryError }
      );
    }
    if (primaryError) throw primaryError;
    if (recoveryCleanupError) throw recoveryCleanupError;
  });

  test('fake bridge 脚本只向隔离目录写入固定无参数事件令牌', async () => {
    const fixture = await loadElectronFixtureModule();
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'myself-e2e-explorer-events-'));
    try {
      await fixture.writeMainE2eExplorerEvent(temporaryDirectory, 'ambiguous');
      await fixture.writeMainE2eExplorerEvent(temporaryDirectory, 'foreground-explorer');

      await expect(readFile(
        join(temporaryDirectory, 'main-e2e-explorer-events'),
        'utf8'
      )).resolves.toBe('ambiguous\nforeground-explorer\n');
      await expect(fixture.writeMainE2eExplorerEvent(
        temporaryDirectory,
        'C:\\Private\\Explorer' as never
      )).rejects.toThrow('E2E_EXPLORER_EVENT_INVALID');
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('工作室清理的单错误、聚合 errors 与 cause 均只保留脱敏错误', () => {
    const userDataDirectory = 'C:\\Temp\\private-user-data';
    const recoverySnapshot = 'C:\\Temp\\private-recovery';
    const safePackage = 'C:\\Temp\\private-package.zip';
    const sanitize = (text: string): string => sanitizeCapturedDiagnostic(
      text,
      userDataDirectory,
      recoverySnapshot,
      safePackage
    );
    const primary = sanitizedCapturedError(
      new Error(`主失败 ${userDataDirectory}`),
      sanitize
    );
    const cleanup = sanitizedCapturedError(
      new Error(`清理失败 ${recoverySnapshot} ${safePackage}`),
      sanitize
    );
    const aggregate = new AggregateError(
      [primary, cleanup],
      sanitize(`主失败 ${userDataDirectory}；清理失败 ${recoverySnapshot} ${safePackage}`),
      { cause: primary }
    );
    const observable = [
      primary.message,
      primary.stack,
      cleanup.message,
      cleanup.stack,
      aggregate.message,
      ...aggregate.errors.map(error => error instanceof Error ? error.message : String(error)),
      aggregate.cause instanceof Error ? aggregate.cause.message : String(aggregate.cause)
    ].join('\n');

    expect(observable).not.toContain(userDataDirectory);
    expect(observable).not.toContain(recoverySnapshot);
    expect(observable).not.toContain(safePackage);
    expect(observable).toContain('[已脱敏]');
  });
});

test.describe('自主行为最小闭环', () => {
  /** 重启后只恢复 E2E Provider，不触碰被测的主动行为停止状态。 */
  const restoreB7ProviderAfterRestart = async (
    pet: Page,
    input: { profileId: string; displayName: string; modelId: string; baseUrl: string; apiKey: string }
  ): Promise<void> => {
    await pet.evaluate(async ({ profileId, displayName, modelId, baseUrl, apiKey }) => {
      await window.myself.saveProviderProfile({
        profile: {
          id: profileId,
          displayName,
          mode: 'custom',
          protocol: 'openai-compatible',
          baseUrl,
          modelId,
          additionalParameters: {},
          capabilities: ['chat', 'tools']
        },
        secret: apiKey,
        persistSecret: true
      });
      await window.myself.saveModelRoute({
        primaryProfileId: profileId,
        chatProfileId: profileId,
        agentProfileId: profileId,
        visionProfileId: null,
        fallbackProfileIds: [],
        allowCrossProviderFallback: false
      });
    }, input);
  };

  const b7MovementCases = [
    {
      prompt: '向左一点', reply: '已向左移动', axis: 'horizontal', sign: -1,
      selection: { mode: 'once', target: 'left', distance: 'near' }
    },
    {
      prompt: '向上远一点', reply: '已向上移动', axis: 'vertical', sign: -1,
      selection: { mode: 'once', target: 'top', distance: 'far' }
    },
    {
      prompt: '向右一点', reply: '已向右移动', axis: 'horizontal', sign: 1,
      selection: { mode: 'once', target: 'right', distance: 'near' },
      precondition: {
        prompt: '向左一点', reply: '右移前置已向左移动',
        selection: { mode: 'once', target: 'left', distance: 'near' }
      }
    },
    {
      prompt: '向下一点', reply: '已向下移动', axis: 'vertical', sign: 1,
      selection: { mode: 'once', target: 'bottom', distance: 'near' },
      precondition: {
        prompt: '向上远一点', reply: '下移前置已向上移动',
        selection: { mode: 'once', target: 'top', distance: 'far' }
      }
    },
    {
      prompt: '去左上角', reply: '已移动到左上区域', axis: 'region', sign: -1,
      selection: { mode: 'once', target: 'top_left', distance: 'far' }
    }
  ] as const;

  for (const movement of b7MovementCases) {
    test(`B7 快速移动：JSON Output“${movement.prompt}”只通过累计 delta 证明真实方向`, async () => {
      test.setTimeout(60_000);
      const fixtureModule = await loadElectronFixtureModule();
      // 位移只能借用 Provider 明确选中的合法 moving 活动，动作名称不授予移动能力。
      const movingChoice = { stateId: 'moving', actionId: 'safe-move-action' };
      const provider = await startProviderServer([
      behaviorBindingsStep({ moving: movingChoice }),
        ...('precondition' in movement ? [...characterChatSteps(movement.precondition.reply, {
            kind: 'movement', choice: movingChoice, ...movement.precondition.selection
          }, {inspect: expectCharacterChatRequest}), behaviorBindingsStep({ moving: movingChoice }), behaviorBindingsStep({ moving: movingChoice })] : []),
        ...characterChatSteps(movement.reply, {
            kind: 'movement', choice: movingChoice, ...movement.selection
          }, {inspect: expectCharacterChatRequest})
      ]);
      const fixture = await fixtureModule.createElectronAppFixture({
        workspaceRoot: resolve(process.cwd()),
        apiKey: provider.apiKey,
        launchTimeoutMs: 15_000,
        enableSoftwareRasterizer: true,
        prepareUserData: async ({ userDataDirectory }) => {
          // 纯方向测试隔离自主移动；明确位移命令仍须给出真实方向证据。
          await new SettingsStore(join(userDataDirectory, 'settings.json')).saveMovementMode(0);
        }
      });
      let movementBefore: unknown;
      try {
        const pet = await waitForRendererPage(fixture, 'pet');
        let chat = await waitForRendererPage(fixture, 'chat');
        const imported = await pet.evaluate(async () => window.myself.importCharacterPackage());
        expect(imported.kind).toBe('imported');
        if (imported.kind !== 'imported') return;
        await pet.evaluate(async ({ characterId, baseUrl, apiKey }) => {
          await window.myself.activateCharacter(characterId);
          await window.myself.saveProviderProfile({
            profile: {
              id: 'behavior-b7-movement',
              displayName: '行为导演 B7 移动 E2E',
              mode: 'custom',
              protocol: 'openai-compatible',
              baseUrl,
              modelId: 'behavior-b7-movement-model',
              additionalParameters: {},
              capabilities: ['chat', 'tools']
            },
            secret: apiKey,
            persistSecret: true
          });
          await window.myself.saveModelRoute({
            primaryProfileId: 'behavior-b7-movement',
            chatProfileId: 'behavior-b7-movement',
            agentProfileId: 'behavior-b7-movement',
            visionProfileId: null,
            fallbackProfileIds: [],
            allowCrossProviderFallback: false
          });
          await window.myself.savePrivacySettings({
            dataCategories: { memory: false },
            longTermMemory: false,
            proactivityMode: 'passive'
          });
          await window.myself.openChat();
        }, {
          characterId: imported.characterId,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey
        });
        await expect.poll(() => chat.evaluate(() => document.visibilityState)).toBe('visible');
        // 换角色首帧与几何提交完成后才采集基线，避免把窗口重排当成指令位移。
        await expect.poll(() => fixture.getCharacterBehaviorProbe(), { timeout: 15_000 }).toMatchObject({
          actionId: 'safe-idle-action', playbackStatus: 'started'
        });
        movementBefore = { motion: await pet.evaluate(() => window.myself.getCharacterMotionSnapshot()),
          delta: await fixture.getCharacterMotionDeltaProbe(), bounds: (await fixture.getMainE2eState()).petWindowBoundsDip };
        if ('precondition' in movement) {
          const beforePrecondition = await fixture.getCharacterMotionDeltaProbe();
          await submitChatMessage(chat, movement.precondition.prompt);
          await expect(chat.getByText(movement.precondition.reply)).toBeVisible();
          await expect.poll(async () => {
            const after = await fixture.getCharacterMotionDeltaProbe();
            return movement.axis === 'horizontal'
              ? Math.sign(after.horizontal - beforePrecondition.horizontal)
              : Math.sign(after.vertical - beforePrecondition.vertical);
          }).toBe(-1);
          await expect.poll(() => pet.evaluate(async () => (
            await window.myself.getCharacterMotionSnapshot()
          ).moving)).toBe(false);
          await fixture.restart();
          // 启动先绑定一次；恢复 Provider 配置使生命周期再次失效，下一轮再绑定一次。
          await provider.waitForCompletedResponses(4);
          const restartedPet = await waitForRendererPage(fixture, 'pet', 15_000);
          await expect.poll(() => fixture.getCharacterBehaviorProbe(), { timeout: 15_000 })
            .toMatchObject({
              actionId: 'safe-idle-action',
              playbackStatus: expect.stringMatching(/^(started|completed)$/u)
            });
          await restoreB7ProviderAfterRestart(restartedPet, {
            profileId: 'behavior-b7-movement',
            displayName: '行为导演 B7 移动 E2E',
            modelId: 'behavior-b7-movement-model',
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey
          });
          const restartedChat = await waitForRendererPage(fixture, 'chat', 15_000);
          await restartedChat.evaluate(() => window.myself.openChat());
          await expect.poll(() => restartedChat.evaluate(() => document.visibilityState))
            .toBe('visible');
          chat = restartedChat;
        }
        const before = await fixture.getCharacterMotionDeltaProbe();

        await submitChatMessage(chat, movement.prompt);
        await expect(chat.getByText(movement.reply)).toBeVisible();
        await expect.poll(async () => {
          const after = await fixture.getCharacterMotionDeltaProbe();
          const horizontal = Math.sign(after.horizontal - before.horizontal);
          const vertical = Math.sign(after.vertical - before.vertical);
          return movement.axis === 'horizontal'
            ? horizontal
            : movement.axis === 'vertical'
              ? vertical
              : horizontal === movement.sign && vertical === movement.sign;
        }).toBe(movement.axis === 'region' ? true : movement.sign);
        provider.assertComplete();
        expect(provider.inspectionErrors).toEqual([]);
      } catch (error) {
        const activePet = await waitForRendererPage(fixture, 'pet');
        console.log('B7纯坐标诊断', JSON.stringify({ before: movementBefore,
          after: { motion: await activePet.evaluate(() => window.myself.getCharacterMotionSnapshot()),
            delta: await fixture.getCharacterMotionDeltaProbe(), bounds: (await fixture.getMainE2eState()).petWindowBoundsDip },
          behavior: await fixture.getCharacterBehaviorProbe(), requests: provider.requests, inspections: provider.inspectionErrors }));
        throw error;
      } finally {
        await fixture.dispose();
        await provider.close();
      }
    });
  }

  test('B7 快速状态：缺动作不伪装 idle，停止跨重启且显式移动会解除停止', async () => {
    test.setTimeout(120_000);
    const fixtureModule = await loadElectronFixtureModule();
    const provider = await startProviderServer([
      behaviorBindingsStep(),
      ...characterChatSteps('缺失动作请求已安全处理', {}, {}),
      ...characterChatSteps('停止状态已保存', {
          kind: 'movement', mode: 'still'
        }, {}),
      behaviorBindingsStep({ moving: { stateId: 'moving', actionId: 'safe-move-action' } }),
      behaviorBindingsStep({ moving: { stateId: 'moving', actionId: 'safe-move-action' } }),
      ...characterChatSteps('停止期间仍可挥手回应', {
          kind: 'action', choice: { stateId: 'custom-wave', actionId: 'safe-wave-action' }
        }, {}),
      ...characterChatSteps('停止期间移动请求已处理', {
          kind: 'movement', choice: { stateId: 'moving', actionId: 'safe-move-action' }, mode: 'once', target: 'left', distance: 'near'
        }, {})
    ]);
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: provider.apiKey,
      launchTimeoutMs: 15_000,
      enableSoftwareRasterizer: true,
      prepareUserData: async ({ userDataDirectory }) => {
        await new SettingsStore(join(userDataDirectory, 'settings.json')).saveMovementMode(0);
      }
    });

    /** 每次重启后重新注册只保留公开 actionId 的测试观察器。 */
    const observeBehaviorActions = async (pet: Page): Promise<void> => {
      await pet.evaluate(() => {
        const scope = globalThis as typeof globalThis & { __b7BehaviorActions?: string[] };
        scope.__b7BehaviorActions = [];
        window.myself.subscribeCharacterMotion(event => {
          if (event.type === 'behavior-action') scope.__b7BehaviorActions?.push(event.actionId);
        });
      });
    };
    const behaviorActions = (pet: Page): Promise<string[]> => pet.evaluate(() => (
      (globalThis as typeof globalThis & { __b7BehaviorActions?: string[] })
        .__b7BehaviorActions?.slice() ?? []
    ));
    try {
      let pet = await waitForRendererPage(fixture, 'pet');
      let chat = await waitForRendererPage(fixture, 'chat');
      await observeBehaviorActions(pet);
      const imported = await pet.evaluate(async () => window.myself.importCharacterPackage());
      expect(imported.kind).toBe('imported');
      if (imported.kind !== 'imported') return;
      await pet.evaluate(async ({ characterId, baseUrl, apiKey }) => {
        await window.myself.activateCharacter(characterId);
        await window.myself.saveProviderProfile({
          profile: {
            id: 'behavior-b7-fast',
            displayName: '行为导演 B7 快速 E2E',
            mode: 'custom',
            protocol: 'openai-compatible',
            baseUrl,
            modelId: 'behavior-b7-fast-model',
            additionalParameters: {},
            capabilities: ['chat', 'tools']
          },
          secret: apiKey,
          persistSecret: true
        });
        await window.myself.saveModelRoute({
          primaryProfileId: 'behavior-b7-fast',
          chatProfileId: 'behavior-b7-fast',
          agentProfileId: 'behavior-b7-fast',
          visionProfileId: null,
          fallbackProfileIds: [],
          allowCrossProviderFallback: false
        });
        await window.myself.savePrivacySettings({
          dataCategories: { memory: false },
          longTermMemory: false,
          proactivityMode: 'passive'
        });
        await window.myself.openChat();
      }, {
        characterId: imported.characterId,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey
      });
      await expect.poll(() => chat.evaluate(() => document.visibilityState)).toBe('visible');
      await expect.poll(() => fixture.getCharacterBehaviorProbe(), { timeout: 15_000 }).toMatchObject({
        actionId: 'safe-idle-action', playbackStatus: 'started'
      });
      const missingActionOffset = (await behaviorActions(pet)).length;
      await submitChatMessage(chat, '播放不存在动作');
      await expect(chat.getByText('请先配置对应状态和动作。', { exact: true })).toBeVisible();
      await expect(chat.getByText('缺失动作请求已安全处理')).toBeVisible();
      // 留出完整 IPC 与动画调度观察窗，防止迟到的 idle 回退被下一步重启掩盖。
      await pet.waitForTimeout(2_000);
      expect((await behaviorActions(pet)).slice(missingActionOffset))
        .not.toContain('safe-idle-action');

      await submitChatMessage(chat, '停止不动');
      await expect(chat.getByText('停止状态已保存')).toBeVisible();
      await fixture.restart();
      await provider.waitForCompletedResponses(6);

      pet = await waitForRendererPage(fixture, 'pet', 15_000);
      chat = await waitForRendererPage(fixture, 'chat', 15_000);
      await expect.poll(() => fixture.getCharacterBehaviorProbe(), { timeout: 15_000 })
        .toMatchObject({
          actionId: 'safe-idle-action',
          playbackStatus: expect.stringMatching(/^(started|completed)$/u)
        });
      await restoreB7ProviderAfterRestart(pet, {
        profileId: 'behavior-b7-fast',
        displayName: '行为导演 B7 快速 E2E',
        modelId: 'behavior-b7-fast-model',
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey
      });
      await observeBehaviorActions(pet);
      await pet.evaluate(() => window.myself.openChat());
      await expect.poll(() => chat.evaluate(() => document.visibilityState)).toBe('visible');

      await submitChatMessage(chat, '挥手一会儿');
      await expect(chat.getByText('停止期间仍可挥手回应')).toBeVisible();
      await expect.poll(() => behaviorActions(pet)).toContain('safe-wave-action');

      const stoppedBaseline = await fixture.getCharacterMotionDeltaProbe();
      await submitChatMessage(chat, '向左一点');
      await expect(chat.getByText('停止期间移动请求已处理')).toBeVisible();
      await pet.waitForTimeout(1_500);
      const stoppedAfter = await fixture.getCharacterMotionDeltaProbe();
      expect(stoppedAfter.horizontal).toBeLessThan(stoppedBaseline.horizontal);
      expect(stoppedAfter.vertical).toBe(stoppedBaseline.vertical);
      expect(stoppedAfter.moved).toBe(true);
      provider.assertComplete();
      expect(provider.inspectionErrors).toEqual([]);
    } finally {
      await fixture.dispose();
      await provider.close();
    }
  });

  test('E2E 只读探针观察默认角色待机播放', async () => {
    test.setTimeout(60_000);
    const fixtureModule = await loadElectronFixtureModule();
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: runtimeDiagnosticKey(),
      launchTimeoutMs: 15_000
    });

    try {
      await expect.poll(() => fixture.getCharacterBehaviorProbe()).toMatchObject({
        stateId: 'idle',
        actionId: 'idle-action',
        playbackStatus: expect.stringMatching(/^(started|completed)$/u)
      });
      const probe = await fixture.getCharacterBehaviorProbe();
      expect(probe.revision).toBeGreaterThan(0);
      expect(Object.keys(probe).sort()).toEqual([
        'actionId',
        'playbackStatus',
        'revision',
        'stateId'
      ]);
    } finally {
      await fixture.dispose();
    }
  });

});

test.describe('Explorer 动态图层自动验收', () => {
  test('准确快照建立层级，非 Explorer 与失败路径不隐藏或置顶桌宠', async () => {
    test.setTimeout(60_000);
    const fixtureModule = await loadElectronFixtureModule();
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: runtimeDiagnosticKey(),
      launchTimeoutMs: 15_000
    });

    const waitForEvent = async (event: Parameters<typeof fixture.sendExplorerEvent>[0]) => {
      const before = await fixture.getMainE2eState();
      await fixture.sendExplorerEvent(event);
      await expect.poll(() => fixture.getMainE2eState()).toMatchObject({
        petWindowVisible: true,
        petWindowAlwaysOnTop: false,
        processedExplorerEventRevision: before.processedExplorerEventRevision + 1,
        processedExplorerEvent: event
      });
      return fixture.getMainE2eState();
    };

    try {
      await expect.poll(() => fixture.getMainE2eState()).toMatchObject({
        petWindowVisible: true,
        petWindowAlwaysOnTop: false,
        bridge: { state: 'ready', observing: true, polling: true },
        layer: { status: 'idle', activationRevision: 0, errorRevision: 0 }
      });

      const active = await waitForEvent('foreground-explorer');
      expect(active.layer).toEqual({
        status: 'active', activationRevision: 1, errorRevision: 0
      });

      for (const event of ['non-explorer', 'blurred', 'minimized', 'ambiguous'] as const) {
        const unchanged = await waitForEvent(event);
        expect(unchanged.layer).toEqual({
          status: 'active', activationRevision: 1, errorRevision: 0
        });
      }

      const failed = await waitForEvent('layer-error');
      expect(failed.layer).toEqual({
        status: 'failed', activationRevision: 1, errorRevision: 1
      });

      const recovered = await waitForEvent('foreground-explorer');
      expect(recovered.layer).toEqual({
        status: 'active', activationRevision: 2, errorRevision: 1
      });
    } finally {
      await fixture.dispose();
    }
  });
});

test.describe('真实 Provider 业务闭环', () => {
  test('内置本地模型在真实 Electron 中经历加载、CPU 就绪、云路由恢复与退出清理', async () => {
    test.setTimeout(120_000);
    const fixtureModule = await loadElectronFixtureModule();
    const stderrCanary = 'stderr-canary-local-electron';
    const localPrompt = '本地模型窗口生命周期问候';
    const localReply = '本地模型 fixture 回复';
    const pendingPrompt = '请创建 switch-stale.txt';
    const cloudPrompt = '关闭本地模型后回复我';
    const cloudReply = '云端路由已恢复';
    const logSentinels = [
      stderrCanary,
      localPrompt,
      localReply,
      pendingPrompt,
      cloudPrompt,
      cloudReply,
      'body-canary-local-electron'
    ];
    // 模型生命周期切回云路由后先重新绑定公开用途，不发送聊天或私有任务正文。
    const cloud = await startProviderServer([behaviorBindingsStep({}, request => {
      const schemaMessage = request.messages.find(message => message.role === 'system' && message.content.startsWith('完整输出 JSON Schema：'));
      const schema = JSON.parse(schemaMessage!.content.slice('完整输出 JSON Schema：'.length));
      expect(schema.required.sort()).toEqual([...characterBehaviorRoles].sort());
      expect(Object.keys(schema.properties).sort()).toEqual([...characterBehaviorRoles].sort());
    }), ...characterChatSteps(cloudReply, {}, {inspect: request => {
        expectCharacterChatRequest(request);
        if (request.messages.at(-1)?.content !== cloudPrompt) {
          throw new Error('关闭本地模型后没有恢复持久化云路由');
        }
      }})]);
    let fixture: Awaited<ReturnType<ElectronFixtureModule['createElectronAppFixture']>>;
    try {
      fixture = await fixtureModule.createElectronAppFixture({
        workspaceRoot: resolve(process.cwd()),
        apiKey: cloud.apiKey,
        logSentinels,
        enableLocalModelFixture: true,
        localModelStderrCanary: stderrCanary,
        launchTimeoutMs: 15_000,
        enableSoftwareRasterizer: true
      });
    } catch (error) {
      await cloud.close();
      throw error;
    }
    let finalLocalProcessId: number | undefined;
    let finalTokenFilePath = '';
    let firstLocalProcessId: number | undefined;
    let firstTokenFilePath = '';
    const rendererDiagnostics: string[] = [];
    const publicLocalModelSnapshots: unknown[] = [];
    const connectionCanaries: string[] = [];
    let privateCanaries: string[] = [];
    try {
      await expect.poll(() => Boolean(
        rendererPage(fixture, 'pet')
        && rendererPage(fixture, 'chat')
        && rendererPage(fixture, 'settings')
      )).toBe(true);
      const pet = rendererPage(fixture, 'pet');
      const chat = rendererPage(fixture, 'chat');
      let settings = rendererPage(fixture, 'settings');
      if (!pet || !chat || !settings) throw new Error('本地模型 E2E 缺少首屏窗口');
      for (const page of [pet, chat, settings]) {
        page.on('console', message => rendererDiagnostics.push(message.text()));
        page.on('pageerror', error => rendererDiagnostics.push(error.message));
      }
      await pet.evaluate(async ({ baseUrl, apiKey }) => {
        await window.myself.saveProviderProfile({
          profile: {
            id: 'local-model-cloud-route',
            displayName: '本地模型关闭后的云路由',
            mode: 'custom',
            protocol: 'openai-compatible',
            baseUrl,
            modelId: 'local-model-cloud-fixture',
            additionalParameters: {},
            capabilities: ['chat', 'tools']
          },
          secret: apiKey,
          persistSecret: false
        });
        await window.myself.saveModelRoute({
          primaryProfileId: 'local-model-cloud-route',
          chatProfileId: 'local-model-cloud-route',
          agentProfileId: 'local-model-cloud-route',
          visionProfileId: null,
          fallbackProfileIds: [],
          allowCrossProviderFallback: false
        });
        await window.myself.savePrivacySettings({
          dataCategories: { memory: false },
          longTermMemory: false,
          proactivityMode: 'passive'
        });
        await window.myself.chooseAuthorizedRoot();
        await window.myself.openChat();
      }, { baseUrl: cloud.baseUrl, apiKey: cloud.apiKey });
      await expect.poll(() => chat.evaluate(() => document.visibilityState)).toBe('visible');

      await expect(settings.getByText('正在检查资源', { exact: true })).toBeVisible();
      await expect(chat.getByText('本地模型加载中，暂时不能发送消息。', { exact: true }))
        .toBeVisible();
      await expect(chat.getByRole('button', { name: '发送给 AI Pet' })).toBeDisabled();
      expect(cloud.requests).toHaveLength(0);
      connectionCanaries.push(...fixture.getLocalModelFixturePrivatePaths());

      await fixture.markLocalModelValidationReady();
      await expect(settings.getByText('本地模型加载中', { exact: true })).toBeVisible();
      await fixture.markLocalModelReady();
      await expect(chat.getByText('CPU 兼容模式', { exact: true })).toBeVisible();
      const firstEvidence = await fixture.getLocalModelFixtureEvidence();
      firstLocalProcessId = firstEvidence.processId;
      firstTokenFilePath = firstEvidence.tokenFilePath;
      expect(firstEvidence.requestedSpawnOptions).toEqual({ shell: false, windowsHide: true });
      expect(firstEvidence.actualSpawnOptions).toEqual({ shell: false, windowsHide: true });
      connectionCanaries.push(
        firstEvidence.token,
        String(firstEvidence.port),
        firstEvidence.fixtureScriptPath,
        firstEvidence.modelPath,
        firstEvidence.requestedRuntimePath,
        firstEvidence.actualRuntimePath,
        firstEvidence.resourceRoot,
        firstEvidence.tokenFilePath
      );
      publicLocalModelSnapshots.push(await settings.evaluate(async () => (
        await window.myself.getSettingsDashboard()
      ).localModel));
      await submitChatMessage(chat, localPrompt);
      await expect(chat.getByText(localReply, { exact: true })).toBeVisible();
      expect(cloud.requests).toHaveLength(0);

      await submitChatMessage(chat, pendingPrompt);
      const pendingCard = chat.getByRole('article', { name: '本地任务授权' });
      await expect(pendingCard).toBeVisible();
      await expect(pendingCard).toContainText('builtin-local');
      await expect(lstat(join(fixture.authorizedRootDirectory, 'switch-stale.txt')))
        .rejects.toMatchObject({ code: 'ENOENT' });

      await chat.getByRole('button', { name: '设置' }).click();
      await expect.poll(() => Boolean(rendererPage(fixture, 'settings'))).toBe(true);
      settings = rendererPage(fixture, 'settings');
      if (!settings) throw new Error('缺少本地模型设置窗口');
      await expect.poll(() => settings.evaluate(() => document.visibilityState)).toBe('visible');
      const localSwitch = settings.getByRole('switch', { name: '启用内置本地模型' });
      await expect(localSwitch).toBeChecked();
      await localSwitch.uncheck();
      await expect(settings.getByText('已关闭', { exact: true }).first()).toBeVisible();
      await expect(localSwitch).toBeEnabled();
      await expect(localSwitch).not.toBeChecked();
      publicLocalModelSnapshots.push(await settings.evaluate(async () => (
        await window.myself.getSettingsDashboard()
      ).localModel));
      await expect(pendingCard).toHaveCount(0);
      await expect(lstat(join(fixture.authorizedRootDirectory, 'switch-stale.txt')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      if (!firstLocalProcessId) throw new Error('缺少首次本地 fixture PID');
      await expect(fixtureModule.probeWindowsProcess(firstLocalProcessId)).resolves.toEqual({
        status: 'absent'
      });
      await expect(lstat(firstTokenFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await settings.getByRole('button', { name: '关闭设置', exact: true }).click();

      await cloud.waitForCompletedResponses(1);
      expect(cloud.requests).toHaveLength(1);
      await submitChatMessage(chat, cloudPrompt);
      await expect(chat.getByText(cloudReply, { exact: true })).toBeVisible();
      expect(cloud.requests).toHaveLength(3);
      cloud.assertComplete();
      expect(cloud.inspectionErrors).toEqual([]);

      await chat.getByRole('button', { name: '设置' }).click();
      await expect.poll(() => Boolean(rendererPage(fixture, 'settings'))).toBe(true);
      settings = rendererPage(fixture, 'settings');
      if (!settings) throw new Error('重新打开后缺少本地模型设置窗口');
      await expect.poll(() => settings!.evaluate(() => document.visibilityState)).toBe('visible');
      const reopenedSwitch = settings.getByRole('switch', { name: '启用内置本地模型' });
      await expect(reopenedSwitch).not.toBeChecked();
      await reopenedSwitch.click();
      await expect(reopenedSwitch).toBeChecked();
      await expect(settings.getByText('CPU 兼容模式', { exact: true })).toBeVisible();
      const finalEvidence = await fixture.getLocalModelFixtureEvidence();
      finalLocalProcessId = finalEvidence.processId;
      finalTokenFilePath = finalEvidence.tokenFilePath;
      connectionCanaries.push(
        finalEvidence.token,
        String(finalEvidence.port),
        finalEvidence.fixtureScriptPath,
        finalEvidence.modelPath,
        finalEvidence.requestedRuntimePath,
        finalEvidence.actualRuntimePath,
        finalEvidence.resourceRoot,
        finalEvidence.tokenFilePath
      );
      publicLocalModelSnapshots.push(await settings.evaluate(async () => (
        await window.myself.getSettingsDashboard()
      ).localModel));

      privateCanaries = [...new Set([
        ...connectionCanaries,
        stderrCanary,
        localPrompt,
        localReply,
        pendingPrompt,
        cloudPrompt,
        cloudReply,
        'body-canary-local-electron'
      ])];
      const assertNoPrivateArtifacts = (): void => {
        expect(fixture.inspectCapturedLogCanaries(privateCanaries))
          .toEqual(privateCanaries.map(() => false));
        const artifacts = [
          rendererDiagnostics,
          publicLocalModelSnapshots,
          fixture.logs
        ];
        expect(fixtureModule.inspectPrivateArtifactCanaries(artifacts, privateCanaries))
          .toEqual(privateCanaries.map(() => false));
        expect(fixture.capturedLogEvidence).toEqual({
          apiKey: false,
          authorizedRoot: false,
          authorizationHeader: false,
          sentinels: logSentinels.map(() => false)
        });
      };
      assertNoPrivateArtifacts();

      await settings.evaluate(async () => window.myself.quit());
      await fixture.closeApplicationForInspection();
      if (!finalLocalProcessId) throw new Error('缺少退出前本地 fixture PID');
      await expect(fixtureModule.probeWindowsProcess(finalLocalProcessId)).resolves.toEqual({
        status: 'absent'
      });
      await expect(lstat(finalTokenFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
      // 关闭期间可能产生新的 console/pageerror/log；自然退出后重新序列化全部诊断。
      assertNoPrivateArtifacts();
    } finally {
      try {
        await fixture.dispose();
      } finally {
        await cloud.close();
      }
    }
  });

  test('默认聊天与设置浮层提示', async () => {
    test.setTimeout(120_000);
    const fixtureModule = await loadElectronFixtureModule();
    const chatInputs = [
      '你好',
      '聊天呀',
      '我想和你聊天',
      '帮我整理一下',
      '如何更安全地删除文件',
      'read example.com',
      'Can you delete version 1.2?',
      '读取 a.txt是什么意思？'
    ] as const;
    const chatReplies = [
      '你好！很高兴见到你。',
      '当然可以，我们随便聊聊。',
      "## 一起聊天\n\n- 我会认真听\n\n```ts\nconst topic = '陪伴';\n```",
      '可以，我们先把目标和优先级理清。',
      '可以先确认范围并使用可恢复的回收站操作。',
      '这是一个裸域名示例。',
      '版本号本身不是本地文件。',
      '这句话是在询问读取操作的含义。'
    ] as const;
    const connectionReplies = ['第一次连接正常', '第二次连接正常'] as const;
    const fileRequestBeforeAuthorization = '你能帮我列出当前文件夹吗？';
    const fileRequestAfterAuthorization = 'Could you please list .\\docs?';
    const fileReply = '当前文件夹包含 docs 目录。';
    const logTextSentinels = [
      ...chatInputs,
      ...chatReplies,
      ...connectionReplies,
      fileRequestBeforeAuthorization,
      fileRequestAfterAuthorization,
      fileReply
    ];
    const chatSteps: ProviderStep[] = chatReplies.flatMap((reply, index) => (characterChatSteps(reply, {}, {inspect: request => {
        const systemMessage = request.messages[0];
        if (request.responseFormatWasJsonObject
          || request.tools.length !== 1
          || systemMessage?.role !== 'system'
          || /只输出单个 JSON 对象|规划系统协议/u.test(systemMessage.content)
          || request.messages.at(-1)?.content !== chatInputs[index]) {
          throw new Error(`第 ${index + 1} 轮默认聊天请求越界`);
        }
      }})));
    const provider = await startProviderServer([
      { response: { type: 'text', text: connectionReplies[0] } },
      { response: { type: 'text', text: connectionReplies[1] } },
      behaviorBindingsStep(),
      ...chatSteps,
      ...taskAuthorizationSteps(),
      behaviorBindingsStep(),
      ...taskAuthorizationSteps(),
      { response: codingResponse([{ name: 'read', args: { path: '.' } }]) },
      { response: codingResponse(fileReply), inspectRaw: request => { expect(JSON.stringify(request.messages)).toContain('docs'); } }
    ]);
    let fixture: Awaited<ReturnType<ElectronFixtureModule['createElectronAppFixture']>>;
    try {
      fixture = await fixtureModule.createElectronAppFixture({
        workspaceRoot: resolve(process.cwd()),
        apiKey: provider.apiKey,
        logSentinels: logTextSentinels,
        launchTimeoutMs: 15_000,
        prepareUserData: async ({ userDataDirectory }) => {
          // 设置与聊天验收不消费独立自主活动响应。
          await new SettingsStore(join(userDataDirectory, 'settings.json')).saveMovementMode(0);
        }
      });
    } catch (error) {
      // Electron 创建失败时也必须关闭已启动的本地 Provider。
      await provider.close();
      throw error;
    }
    const rendererDiagnostics: string[] = [];
    let rendererLeakDetected = false;
    const sensitiveValues = [
      provider.apiKey,
      fixture.authorizedRootDirectory,
      ...logTextSentinels
    ];
    const pages = (): Page[] => fixture.browser.contexts().flatMap(context => context.pages());
    const pageFor = (view: 'pet' | 'chat' | 'settings'): Page | undefined => pages().find(page => {
      try {
        return new URL(page.url()).searchParams.get('view') === view;
      } catch {
        return false;
      }
    });

    try {
      await mkdir(join(fixture.authorizedRootDirectory, 'docs'), { recursive: true });
      await expect.poll(() => Boolean(pageFor('pet') && pageFor('chat') && pageFor('settings')))
        .toBe(true);
      const pet = pageFor('pet')!;
      const chat = pageFor('chat')!;
      let settings = pageFor('settings')!;

      // 只记录脱敏后的 Renderer 诊断，泄漏判定仅保留布尔结果。
      for (const page of pages()) {
        const recordDiagnostic = (text: string): void => {
          rendererLeakDetected ||= sensitiveValues.some(value => text.includes(value));
          rendererDiagnostics.push(sanitizeCapturedDiagnostic(text, ...sensitiveValues));
        };
        page.on('console', message => recordDiagnostic(message.text()));
        page.on('pageerror', error => recordDiagnostic(error.message));
      }

      await pet.evaluate(() => window.myself.openSettings());
      await expect.poll(() => settings.evaluate(() => document.visibilityState)).toBe('visible');
      await settings.getByLabel('自定义').check();
      await settings.getByText('高级设置', { exact: true }).click();
      await settings.getByLabel('档案名称').fill('默认聊天验收');
      await settings.getByLabel('Base URL').fill(provider.baseUrl);
      await settings.getByLabel('Model ID').fill('acceptance-chat-model');
      await settings.getByLabel('API Key', { exact: true }).fill(provider.apiKey);
      await settings.getByRole('button', { name: '保存档案' }).click();
      await expect(settings.getByText('模型档案已保存。')).toBeVisible();

      const paneBeforeToast = await settings.locator('.settings-pane').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      await settings.getByRole('button', { name: '测试 默认聊天验收 连接' }).click();
      const autoToast = settings.getByText('连接测试完成。', { exact: true });
      await expect(autoToast).toBeVisible();
      const paneWithToast = await settings.locator('.settings-pane').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      expect(paneWithToast).toEqual(paneBeforeToast);
      await expect.poll(() => autoToast.count(), {
        timeout: 5_000,
        intervals: [100, 200, 400]
      }).toBe(0);

      await settings.getByRole('button', { name: '测试 默认聊天验收 连接' }).click();
      await expect(autoToast).toBeVisible();
      await settings.getByRole('button', {
        name: '关闭设置提示：连接测试完成。'
      }).click();
      await expect(autoToast).toHaveCount(0);

      await settings.getByRole('combobox', { name: '主模型', exact: true })
        .selectOption({ label: '默认聊天验收' });
      await settings.getByRole('combobox', { name: '对话模型', exact: true })
        .selectOption({ label: '默认聊天验收' });
      await settings.getByRole('combobox', { name: 'Agent 模型', exact: true })
        .selectOption({ label: '默认聊天验收' });
      await settings.getByRole('button', { name: '保存路由' }).click();
      await expect(settings.getByText('模型路由已保存。')).toBeVisible();
      await settings.getByRole('button', { name: '关闭设置', exact: true }).click();

      await pet.evaluate(() => window.myself.openChat());
      await expect.poll(() => chat.evaluate(() => document.visibilityState)).toBe('visible');
      for (let index = 0; index < chatInputs.length; index += 1) {
        await submitChatMessage(chat, chatInputs[index]);
        await expect(chat.getByText(chatReplies[index], { exact: true })).toBeVisible();
        await expect.poll(() => fixture.getConversationProbe()).toMatchObject({
          visibleMessageCount: (index + 1) * 2,
          historyDisclosureVisible: false,
          fileConfirmationVisible: false
        });
      }
      await expect(chat.getByText('## 一起聊天', { exact: false })).toBeVisible();
      await expect(chat.getByText("const topic = '陪伴';", { exact: false })).toBeVisible();
      await expect(chat.getByText(
        '我还不确定你是想聊天，还是希望我处理本地文件。可以再具体说明一下吗？',
        { exact: true }
      )).toHaveCount(0);
      await expect(chat.getByRole('button', { name: '打开设置' })).toHaveCount(0);

      await submitChatMessage(chat, fileRequestBeforeAuthorization);
      await expect(chat.getByRole('button', { name: '打开设置' })).toBeVisible();
      await expect.poll(() => provider.requests.length).toBe(21);
      await chat.getByRole('button', { name: '打开设置' }).click();
      await expect.poll(() => Boolean(pageFor('settings'))).toBe(true);
      settings = pageFor('settings')!;
      await expect.poll(() => settings.evaluate(() => document.visibilityState)).toBe('visible');
      await settings.getByRole('button', { name: '隐私' }).click();
      await settings.getByRole('button', { name: '保存隐私设置' }).click();
      await expect(settings.getByText('隐私设置已保存。')).toBeVisible();
      await settings.getByRole('button', { name: '选择目录' }).click();
      await expect(settings.getByText('授权目录已更新。')).toBeVisible();
      await expect(settings.getByText('authorized-root', { exact: true })).toBeVisible();
      await settings.getByRole('button', { name: '关闭设置', exact: true }).click();

      await submitChatMessage(chat, fileRequestAfterAuthorization);
      await approveCodingScope(chat);
      await expect(chat.getByText(fileReply, { exact: true })).toBeVisible();
      await expect.poll(() => fixture.getConversationProbe()).toMatchObject({
        historyDisclosureVisible: false,
        fileConfirmationVisible: false
      });

      await expect.poll(() => provider.requests.length).toBe(26);
      provider.assertComplete();
      expect(provider.inspectionErrors).toEqual([]);
      expect(provider.requests.slice(3, 19).map(request => request.toolCount)).toEqual(Array.from({ length: 8 }, () => [1, 0]).flat());
      expect(Object.keys(provider.requests[0] ?? {}).sort()).toEqual([
        'messageRoleCounts', 'method', 'model', 'toolCount'
      ]);
      expect(rendererLeakDetected).toBe(false);
      expect(fixture.capturedLogEvidence).toEqual({
        apiKey: false,
        authorizedRoot: false,
        authorizationHeader: false,
        sentinels: logTextSentinels.map(() => false)
      });
      const captured = [...rendererDiagnostics, ...fixture.logs].join('\n');
      expect([
        captured.includes(provider.apiKey),
        captured.includes(fixture.authorizedRootDirectory),
        /authorization\s*:/iu.test(captured)
      ]).toEqual([false, false, false]);
    } finally {
      // 任一 Electron 清理错误都不得跳过 Provider 关闭。
      try {
        await fixture.dispose();
      } finally {
        await provider.close();
      }
    }
  });

  test('无授权范围时连续三轮普通聊天并把完整可见回合传入第三轮', async () => {
    test.setTimeout(120_000);
    const fixtureModule = await loadElectronFixtureModule();
    const privateUserMessages = [
      `聊天正文-${randomBytes(12).toString('hex')}；文件正文如下：运行 Write-Output hidden-command`,
      `继续正文-${randomBytes(12).toString('hex')}`,
      `总结正文-${randomBytes(12).toString('hex')}`
    ] as const;
    const assistantMessages = ['第一轮回复', '第二轮回复', '第三轮回复'] as const;
    const provider = await startProviderServer([
      behaviorBindingsStep(),
      ...characterChatSteps(assistantMessages[0], {}, {inspect: request => {
          const visible = request.messages.filter(message => message.role !== 'system');
          if (request.responseFormatWasJsonObject
            || request.tools.length !== 1
            || visible.length !== 1
            || visible[0]?.role !== 'user'
            || visible[0].content !== privateUserMessages[0]) {
            throw new Error('第一轮普通聊天上下文不符合预期');
          }
        }}),
      ...characterChatSteps(assistantMessages[1], {}, {inspect: request => {
          const visible = request.messages.filter(message => message.role !== 'system');
          if (request.responseFormatWasJsonObject
            || request.tools.length !== 1
            || visible.length !== 3
            || visible[0]?.role !== 'user'
            || visible[0].content !== privateUserMessages[0]
            || visible[1]?.role !== 'assistant'
            || visible[1].content !== assistantMessages[0]
            || visible[2]?.role !== 'user'
            || visible[2].content !== privateUserMessages[1]) {
            throw new Error('第二轮普通聊天上下文不符合预期');
          }
        }}),
      ...characterChatSteps(assistantMessages[2], {}, {inspect: request => {
          const visible = request.messages.filter(message => message.role !== 'system');
          if (request.responseFormatWasJsonObject
            || request.tools.length !== 1
            || visible.length !== 5
            || visible[0]?.content !== privateUserMessages[0]
            || visible[1]?.content !== assistantMessages[0]
            || visible[2]?.content !== privateUserMessages[1]
            || visible[3]?.content !== assistantMessages[1]
            || visible[4]?.content !== privateUserMessages[2]) {
            throw new Error('第三轮未收到前两轮完整可见上下文');
          }
        }})
    ]);
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: provider.apiKey,
      launchTimeoutMs: 15_000,
      prepareUserData: async ({ userDataDirectory }) => {
        await new SettingsStore(join(userDataDirectory, 'settings.json')).saveMovementMode(0);
      }
    });
    try {
      await expect.poll(() => Boolean(
        rendererPage(fixture, 'pet') && rendererPage(fixture, 'chat')
      )).toBe(true);
      const pet = rendererPage(fixture, 'pet');
      if (!pet) throw new Error('缺少 pet Renderer');
      const chat = rendererPage(fixture, 'chat');
      if (!chat) throw new Error('缺少 chat Renderer');
      await pet.evaluate(async ({ baseUrl, apiKey }) => {
        await window.myself.saveProviderProfile({
          profile: {
            id: 'conversation-e2e',
            displayName: '会话 E2E',
            mode: 'custom',
            protocol: 'openai-compatible',
            baseUrl,
            modelId: 'conversation-e2e-model',
            additionalParameters: {},
            capabilities: ['chat', 'tools']
          },
          secret: apiKey,
          persistSecret: false
        });
        await window.myself.saveModelRoute({
          primaryProfileId: 'conversation-e2e',
          chatProfileId: 'conversation-e2e',
          agentProfileId: 'conversation-e2e',
          visionProfileId: null,
          fallbackProfileIds: [],
          allowCrossProviderFallback: false
        });
        await window.myself.openChat();
      }, { baseUrl: provider.baseUrl, apiKey: provider.apiKey });

      for (let index = 0; index < privateUserMessages.length; index += 1) {
        await submitChatMessage(chat, privateUserMessages[index]);
        await expect.poll(() => fixture.getConversationProbe()).toMatchObject({
          visibleMessageCount: (index + 1) * 2,
          historyDisclosureVisible: false,
          fileConfirmationVisible: false
        });
      }

      await expect(chat.getByRole('region', { name: '运行 PowerShell 命令' }))
        .toHaveCount(0);

      provider.assertComplete();
      expect(provider.inspectionErrors).toEqual([]);
      const captured = fixture.logs.join('\n');
      for (const privateText of privateUserMessages) {
        expect(captured.includes(privateText), 'Electron 日志不得包含聊天正文').toBe(false);
      }
      expect(captured.includes(provider.apiKey), 'Electron 日志不得包含 Provider 密钥').toBe(false);
      expect(captured.includes(fixture.authorizedRootDirectory), 'Electron 日志不得包含绝对路径')
        .toBe(false);
    } finally {
      await fixture.dispose();
      await provider.close();
    }
  });

  test('模糊请求按默认聊天回复且明确文件请求在无授权时只引导设置', async () => {
    test.setTimeout(120_000);
    const fixtureModule = await loadElectronFixtureModule();
    const ambiguousText = '帮我整理一下';
    const privateLogSentinel = randomBytes(12).toString('hex');
    const fileName = `未授权-${privateLogSentinel}.txt`;
    const provider = await startProviderServer([
      behaviorBindingsStep(),
      ...characterChatSteps('无法确定请求类型', {}, {inspect: request => {
          if (request.responseFormatWasJsonObject
            || request.tools.length !== 1
            || request.messages.at(-1)?.content !== ambiguousText) {
            throw new Error('模糊请求未走正式主请求');
          }
        }}),
      ...taskAuthorizationSteps()
    ]);
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: provider.apiKey,
      launchTimeoutMs: 15_000,
      prepareUserData: async ({ userDataDirectory }) => {
        await new SettingsStore(join(userDataDirectory, 'settings.json')).saveMovementMode(0);
      }
    });
    try {
      await expect.poll(() => Boolean(
        rendererPage(fixture, 'pet') && rendererPage(fixture, 'chat')
      )).toBe(true);
      const pet = rendererPage(fixture, 'pet');
      if (!pet) throw new Error('缺少 pet Renderer');
      const chat = rendererPage(fixture, 'chat');
      if (!chat) throw new Error('缺少 chat Renderer');
      await pet.evaluate(async ({ baseUrl, apiKey }) => {
        await window.myself.saveProviderProfile({
          profile: {
            id: 'routing-e2e',
            displayName: '分流 E2E',
            mode: 'custom',
            protocol: 'openai-compatible',
            baseUrl,
            modelId: 'routing-e2e-model',
            additionalParameters: {},
            capabilities: ['chat', 'tools']
          },
          secret: apiKey,
          persistSecret: false
        });
        await window.myself.saveModelRoute({
          primaryProfileId: 'routing-e2e',
          chatProfileId: 'routing-e2e',
          agentProfileId: 'routing-e2e',
          visionProfileId: null,
          fallbackProfileIds: [],
          allowCrossProviderFallback: false
        });
        await window.myself.openChat();
      }, { baseUrl: provider.baseUrl, apiKey: provider.apiKey });

      const before = await readdir(fixture.authorizedRootDirectory, { recursive: true });
      await submitChatMessage(chat, ambiguousText);
      await expect.poll(() => fixture.getConversationProbe()).toMatchObject({
        visibleMessageCount: 2,
        historyDisclosureVisible: false,
        fileConfirmationVisible: false
      });
      await expect(chat.getByText('无法确定请求类型', { exact: true })).toBeVisible();
      expect(await readdir(fixture.authorizedRootDirectory, { recursive: true })).toEqual(before);

      await submitChatMessage(chat, `读取 ${fileName}`);
      await expect(chat.getByRole('button', { name: '打开设置' })).toBeVisible();
      await expect.poll(() => fixture.getConversationProbe()).toMatchObject({
        visibleMessageCount: 4,
        historyDisclosureVisible: false,
        fileConfirmationVisible: false
      });
      expect(await readdir(fixture.authorizedRootDirectory, { recursive: true })).toEqual(before);
      await expect.poll(() => provider.requests.length).toBe(5);
      provider.assertComplete();
      expect(provider.inspectionErrors).toEqual([]);

      const captured = fixture.logs.join('\n');
      for (const privateText of [privateLogSentinel, fileName, provider.apiKey]) {
        expect(captured.includes(privateText), 'Electron 日志不得包含私密输入或密钥').toBe(false);
      }
      expect(captured.includes(fixture.authorizedRootDirectory), 'Electron 日志不得包含绝对路径')
        .toBe(false);
    } finally {
      await fixture.dispose();
      await provider.close();
    }
  });

  test('Chat 与 Agent 跨 Provider 时两种披露决定均继续且单次共享不会复用', async () => {
    test.setTimeout(120_000);
    const fixtureModule = await loadElectronFixtureModule();
    const privateMessages = [
      `来源正文一-${randomBytes(12).toString('hex')}`,
      `读取 仅当前-${randomBytes(12).toString('hex')}.txt`,
      `来源正文二-${randomBytes(12).toString('hex')}`,
      `读取 共享-${randomBytes(12).toString('hex')}.txt`,
      `读取 再次-${randomBytes(12).toString('hex')}.txt`
    ] as const;
    const sourceReplies = ['来源服务回复一', '来源服务回复二'] as const;
    const sourceProvider = await startProviderServer([
      behaviorBindingsStep(),
      ...characterChatSteps(sourceReplies[0], {}, {inspect: expectCharacterChatRequest}),
      ...taskAuthorizationSteps(),
      ...characterChatSteps(sourceReplies[1], {}, {inspect: expectCharacterChatRequest}),
      ...taskAuthorizationSteps()
    ]);
    const targetProvider = await startProviderServer([
      { response: codingResponse('仅当前文件任务已结束'), inspectRaw: request => {
        const text = JSON.stringify(request.messages); expect(text).not.toContain(privateMessages[0]); expect(text).not.toContain(sourceReplies[0]); expect(text).toContain(privateMessages[1]);
      } },
      { response: codingResponse('共享文件任务已结束'), inspectRaw: request => {
        const text = JSON.stringify(request.messages); expect(text).toContain(privateMessages[2]); expect(text).toContain(sourceReplies[1]); expect(text).toContain(privateMessages[3]);
      } }
    ]);
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: sourceProvider.apiKey,
      additionalSecrets: [targetProvider.apiKey],
      launchTimeoutMs: 15_000,
      // 披露验收使用静止模式，隔离间断活动请求与固定主请求脚本的竞争。
      prepareUserData: async directories => {
        const settings = new SettingsStore(join(directories.userDataDirectory, 'settings.json'), async () => false);
        await settings.saveMovementMode(0);
      }
    });
    try {
      await expect.poll(() => Boolean(
        rendererPage(fixture, 'pet') && rendererPage(fixture, 'chat')
      )).toBe(true);
      const pet = rendererPage(fixture, 'pet');
      if (!pet) throw new Error('缺少 pet Renderer');
      const chat = rendererPage(fixture, 'chat');
      if (!chat) throw new Error('缺少 chat Renderer');
      await pet.evaluate(async input => {
        for (const profile of input.profiles) {
          await window.myself.saveProviderProfile({
            profile: {
              id: profile.id,
              displayName: profile.displayName,
              mode: 'custom',
              protocol: 'openai-compatible',
              baseUrl: profile.baseUrl,
              modelId: `${profile.id}-model`,
              additionalParameters: {},
              capabilities: ['chat', 'tools']
            },
            secret: profile.apiKey,
            persistSecret: false
          });
        }
        await window.myself.saveModelRoute({
          primaryProfileId: 'source-e2e',
          chatProfileId: 'source-e2e',
          agentProfileId: 'target-e2e',
          visionProfileId: null,
          fallbackProfileIds: [],
          allowCrossProviderFallback: false
        });
        await window.myself.savePrivacySettings({
          dataCategories: { memory: false },
          longTermMemory: false,
          proactivityMode: 'passive'
        });
        await window.myself.chooseAuthorizedRoot();
        await window.myself.openChat();
      }, {
        profiles: [
          {
            id: 'source-e2e',
            displayName: '来源 E2E',
            baseUrl: sourceProvider.baseUrl,
            apiKey: sourceProvider.apiKey
          },
          {
            id: 'target-e2e',
            displayName: '目标 E2E',
            baseUrl: targetProvider.baseUrl,
            apiKey: targetProvider.apiKey
          }
        ]
      });

      await submitChatMessage(chat, privateMessages[0]);
      await expect.poll(() => fixture.getConversationProbe()).toMatchObject({
        visibleMessageCount: 2,
        historyDisclosureVisible: false
      });
      await expect.poll(async () => {
        const { phase } = await fixture.getConversationProbe();
        return phase === 'success' || phase === 'idle';
      }).toBe(true);

      await submitChatMessage(chat, privateMessages[1]);
      await expect.poll(() => fixture.getConversationProbe()).toMatchObject({
        visibleMessageCount: 3,
        historyDisclosureVisible: true
      });
      await chat.getByRole('button', { name: '仅发送当前消息' }).click();
      await approveCodingScope(chat);
      await expect.poll(() => fixture.getConversationProbe()).toMatchObject({
        visibleMessageCount: 4,
        historyDisclosureVisible: false
      });
      await expect.poll(async () => {
        const { phase } = await fixture.getConversationProbe();
        return phase === 'success' || phase === 'idle';
      }).toBe(true);

      await chat.getByRole('button', { name: '新对话' }).click();
      await expect.poll(() => fixture.getConversationProbe()).toMatchObject({
        phase: 'idle',
        visibleMessageCount: 0,
        historyDisclosureVisible: false,
        fileConfirmationVisible: false
      });

      await submitChatMessage(chat, privateMessages[2]);
      await expect.poll(() => fixture.getConversationProbe()).toMatchObject({
        visibleMessageCount: 2,
        historyDisclosureVisible: false
      });
      await expect.poll(async () => {
        const { phase } = await fixture.getConversationProbe();
        return phase === 'success' || phase === 'idle';
      }).toBe(true);

      await submitChatMessage(chat, privateMessages[3]);
      await expect.poll(() => fixture.getConversationProbe()).toMatchObject({
        visibleMessageCount: 3,
        historyDisclosureVisible: true
      });
      await chat.getByRole('button', { name: '仅本次共享历史' }).click();
      await approveCodingScope(chat);
      await expect.poll(() => fixture.getConversationProbe()).toMatchObject({
        visibleMessageCount: 4,
        historyDisclosureVisible: false
      });
      await expect.poll(async () => {
        const { phase } = await fixture.getConversationProbe();
        return phase === 'success' || phase === 'idle';
      }).toBe(true);

      await submitChatMessage(chat, privateMessages[4]);
      await expect.poll(() => fixture.getConversationProbe()).toMatchObject({
        visibleMessageCount: 5,
        historyDisclosureVisible: true
      });

      await expect.poll(() => sourceProvider.requests.length).toBe(10);
      // 两种披露决定各只启动获准后的正式 Core 请求。
      expect(targetProvider.requests).toHaveLength(2);

      sourceProvider.assertComplete();
      targetProvider.assertComplete();
      expect(sourceProvider.inspectionErrors).toEqual([]);
      expect(targetProvider.inspectionErrors).toEqual([]);
      const captured = fixture.logs.join('\n');
      for (const privateText of [
        ...privateMessages,
        sourceProvider.apiKey,
        targetProvider.apiKey,
        fixture.authorizedRootDirectory
      ]) {
        expect(captured.includes(privateText), '跨 Provider 诊断不得泄露私密数据').toBe(false);
      }
    } finally {
      await fixture.dispose();
      await sourceProvider.close();
      await targetProvider.close();
    }
  });

  test('模型响应挂起时新建对话会隔离迟到回复并允许新会话继续', async () => {
    test.setTimeout(120_000);
    const fixtureModule = await loadElectronFixtureModule();
    const oldGate = createProviderResponseGate();
    const oldText = `旧会话正文-${randomBytes(12).toString('hex')}`;
    const newText = `新会话正文-${randomBytes(12).toString('hex')}`;
    const provider = await startProviderServer([
      behaviorBindingsStep(),
      ...characterChatSteps('不得回流的旧回复', {}, { gate: oldGate, inspect: expectCharacterChatRequest }),
      behaviorBindingsStep(),
      ...characterChatSteps('新会话回复', {}, {inspect: request => {
          const visible = request.messages.filter(message => message.role !== 'system');
          if (request.tools.length !== 1
            || visible.length !== 1
            || visible[0]?.content !== newText) {
            throw new Error('新会话错误携带了旧会话历史');
          }
        }})
    ]);
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: provider.apiKey,
      launchTimeoutMs: 15_000,
      prepareUserData: async ({ userDataDirectory }) => {
        await new SettingsStore(join(userDataDirectory, 'settings.json')).saveMovementMode(0);
      }
    });
    try {
      await expect.poll(() => Boolean(
        rendererPage(fixture, 'pet') && rendererPage(fixture, 'chat')
      )).toBe(true);
      const pet = rendererPage(fixture, 'pet');
      if (!pet) throw new Error('缺少 pet Renderer');
      const chat = rendererPage(fixture, 'chat');
      if (!chat) throw new Error('缺少 chat Renderer');
      await pet.evaluate(async ({ baseUrl, apiKey }) => {
        await window.myself.saveProviderProfile({
          profile: {
            id: 'reset-e2e',
            displayName: '重置 E2E',
            mode: 'custom',
            protocol: 'openai-compatible',
            baseUrl,
            modelId: 'reset-e2e-model',
            additionalParameters: {},
            capabilities: ['chat', 'tools']
          },
          secret: apiKey,
          persistSecret: false
        });
        await window.myself.saveModelRoute({
          primaryProfileId: 'reset-e2e',
          chatProfileId: 'reset-e2e',
          agentProfileId: 'reset-e2e',
          visionProfileId: null,
          fallbackProfileIds: [],
          allowCrossProviderFallback: false
        });
        await window.myself.openChat();
      }, { baseUrl: provider.baseUrl, apiKey: provider.apiKey });

      await submitChatMessage(chat, oldText);
      await expect.poll(() => oldGate.isWaiting()).toBe(true);
      await expect.poll(() => provider.requests.length).toBe(3);
      await expect.poll(() => fixture.getConversationProbe()).toMatchObject({
        phase: 'thinking',
        visibleMessageCount: 1,
        historyDisclosureVisible: false,
        fileConfirmationVisible: false
      });
      await chat.getByRole('button', { name: '新对话' }).click();
      await expect.poll(() => fixture.getConversationProbe()).toMatchObject({
        phase: 'idle',
        visibleMessageCount: 0,
        historyDisclosureVisible: false,
        fileConfirmationVisible: false
      });

      // 重置已经中止旧连接，解除门闩不能把取消的 HTTP 误算成完成响应。
      await expect.poll(() => oldGate.isWaiting()).toBe(false);
      oldGate.release();
      await expect.poll(() => fixture.getConversationProbe()).toMatchObject({
        phase: 'idle',
        visibleMessageCount: 0,
        historyDisclosureVisible: false,
        fileConfirmationVisible: false
      });

      await submitChatMessage(chat, newText);
      await provider.waitForCompletedResponses(1);
      await expect.poll(() => fixture.getConversationProbe()).toMatchObject({
        visibleMessageCount: 2,
        historyDisclosureVisible: false,
        fileConfirmationVisible: false
      });
      await expect.poll(async () => {
        const { phase } = await fixture.getConversationProbe();
        return phase === 'success' || phase === 'idle';
      }).toBe(true);

      provider.assertComplete();
      expect(provider.inspectionErrors).toEqual([]);
      const captured = fixture.logs.join('\n');
      for (const privateText of [oldText, newText, provider.apiKey, fixture.authorizedRootDirectory]) {
        expect(captured.includes(privateText), '重置诊断不得泄露私密数据').toBe(false);
      }
    } finally {
      oldGate.release();
      await fixture.dispose();
      await provider.close();
    }
  });

  test('MCP 正式链在普通聊天与只读文件任务的重启周期保持保留数据原始字节不变', async () => {
    test.setTimeout(120_000);
    const fixtureModule = await loadElectronFixtureModule();
    const provider = await startProviderServer([
      behaviorBindingsStep(),
      ...characterChatSteps('你好呀，我在。', {}, {inspect: request => {
          if (request.responseFormatWasJsonObject || request.tools.length !== 1) {
            throw new Error('普通聊天只允许无副作用的范围申请');
          }
        }}),
      ...taskAuthorizationSteps(),
      { response: codingResponse([{ name: 'read', args: { path: '.' } }]) },
      { response: codingResponse('只读目录已列出。'), inspectRaw: request => { expect(JSON.stringify(request.messages)).toContain('docs'); } },
      behaviorBindingsStep()
    ]);
    let restartCount = 0;
    let baselineSettingsBuffer: Buffer | undefined;
    let baselineMcpSecretBuffer: Buffer | undefined;
    let fixture: AppFixture;
    try {
      fixture = await fixtureModule.createElectronAppFixture({
        workspaceRoot: resolve(process.cwd()),
        apiKey: provider.apiKey,
        launchTimeoutMs: 15_000,
        prepareUserData: async ({ userDataDirectory }) => {
          // MCP 字节保留验收固定运动模式，避免重启后的活动调度消费正文脚本。
          await new SettingsStore(join(userDataDirectory, 'settings.json')).saveMovementMode(0);
        },
        beforeRestart: async directories => {
          restartCount += 1;
          const settingsFile = join(directories.userDataDirectory, 'settings.json');
          const secretFile = join(directories.userDataDirectory, 'provider-secret.bin');
          const profilesDirectory = `${secretFile}.profiles`;
          const providerSlotFile = join(
            profilesDirectory,
            `${createHash('sha256').update('provider-main').digest('hex')}.bin`
          );
          const mcpSecretSlotFile = join(
            profilesDirectory,
            `${createHash('sha256').update('mcp:remote-tools').digest('hex')}.bin`
          );

          if (restartCount === 1) {
            const settings = new SettingsStore(settingsFile, async () => false);
            await settings.getPetPlacementState('builtin-default');
            await settings.saveMcpServerSettings({
              id: 'remote-tools',
              enabled: true,
              transport: {
                type: 'http',
                url: 'https://mcp.example.com',
                secretNames: ['Authorization']
              },
              tools: {
                search: {
                  enabled: true,
                  readOnly: true,
                  description: '搜索'
                }
              }
            });
            await mkdir(profilesDirectory, { recursive: true });
            await cp(providerSlotFile, mcpSecretSlotFile);
            baselineSettingsBuffer = await readFile(settingsFile);
            baselineMcpSecretBuffer = await readFile(mcpSecretSlotFile);
          } else if (restartCount === 2) {
            if (!baselineSettingsBuffer || !baselineMcpSecretBuffer) {
              throw new Error('缺少首次重启的 MCP 原始字节基线');
            }
            const afterSettingsBuffer = await readFile(settingsFile);
            const afterMcpSecretBuffer = await readFile(mcpSecretSlotFile);
            expect(afterSettingsBuffer.equals(baselineSettingsBuffer)).toBe(true);
            expect(afterMcpSecretBuffer.equals(baselineMcpSecretBuffer)).toBe(true);
          }
        }
      });
    } catch (error) {
      await provider.close();
      throw error;
    }

    try {
      await mkdir(join(fixture.authorizedRootDirectory, 'docs'), { recursive: true });
      const petPage = await waitForRendererPage(fixture, 'pet');
      await petPage.evaluate(async ({ baseUrl, apiKey }) => {
        await window.myself.saveProviderProfile({
          profile: {
            id: 'provider-main',
            displayName: 'MCP 生命周期 Provider',
            mode: 'custom',
            protocol: 'openai-compatible',
            baseUrl,
            modelId: 'mcp-lifecycle-model',
            additionalParameters: {},
            capabilities: ['chat', 'tools']
          },
          secret: apiKey,
          persistSecret: true
        });
        await window.myself.saveModelRoute({
          primaryProfileId: 'provider-main',
          chatProfileId: 'provider-main',
          agentProfileId: 'provider-main',
          visionProfileId: null,
          fallbackProfileIds: [],
          allowCrossProviderFallback: false
        });
        await window.myself.savePrivacySettings({
          dataCategories: { memory: false },
          longTermMemory: false,
          proactivityMode: 'assistive'
        });
        await window.myself.chooseAuthorizedRoot();
      }, { baseUrl: provider.baseUrl, apiKey: provider.apiKey });

      // 首次配置阶段允许正式 coordinator 落盘 V3 placement；基线建立后不再改写几何。
      const firstPetClosed = petPage.waitForEvent('close');
      await petPage.evaluate(() => {
        void window.myself.quit();
      });
      await firstPetClosed;
      await fixture.restart();
      const restartedPetPage = await waitForRendererPage(fixture, 'pet');
      const chatPage = await waitForRendererPage(fixture, 'chat');
      await restartedPetPage.evaluate(() => window.myself.openChat());
      await expect.poll(() => chatPage.evaluate(() => document.visibilityState)).toBe('visible');

      await submitChatMessage(chatPage, '你好呀');
      await expect.poll(() => provider.requests.length).toBe(3);
      expect(provider.inspectionErrors).toEqual([]);
      await expect(chatPage.getByText('你好呀，我在。', { exact: true })).toBeVisible();
      await submitChatMessage(chatPage, '列出当前目录');
      await approveCodingScope(chatPage);
      await expect(chatPage.getByText('只读目录已列出。', { exact: true })).toBeVisible();

      await expect.poll(() => provider.remainingSteps()).toBe(1);
      expect(provider.inspectionErrors).toEqual([]);
      const secondPetClosed = restartedPetPage.waitForEvent('close');
      await restartedPetPage.evaluate(() => {
        void window.myself.quit();
      });
      await secondPetClosed;
      await fixture.restart();
      expect(restartCount).toBe(2);
      await expect.poll(() => provider.remainingSteps()).toBe(0);
      provider.assertComplete();
      expect(provider.inspectionErrors).toEqual([]);
    } finally {
      try {
        await fixture.dispose();
      } finally {
        await provider.close();
      }
    }
  });
});

test.describe('真实桌宠位置重启恢复', () => {
  test('移动并等待持久化后使用同一 userData 重启恢复位置', async () => {
    test.setTimeout(120_000);
    const fixtureModule = await loadElectronFixtureModule();
    type Placement = PetPlacementForE2e;
    const readPlacementAt = async (directory: string): Promise<Placement | null> => {
      try {
        const settings = JSON.parse(
          await readFile(join(directory, 'settings.json'), 'utf8')
        ) as {
          petPlacementState?: {
            kind?: string;
            placements?: Placement[];
          };
        };
        const state = settings.petPlacementState;
        if (state?.kind !== 'ready') {
          return null;
        }
        const placement = state.placements?.find(
          candidate => candidate.characterId === 'builtin-default'
        );
        return placement ?? null;
      } catch {
        return null;
      }
    };
    const sameFoot = (left: Placement | null, right: Placement | null): boolean => Boolean(
      left && right
      && left.footAnchorDip.x === right.footAnchorDip.x
      && left.footAnchorDip.y === right.footAnchorDip.y
    );
    const sameScale = (left: Placement | null, right: Placement | null): boolean => Boolean(
      left && right && left.scale === right.scale
    );
    const sameDisplay = (left: Placement | null, right: Placement | null): boolean => Boolean(
      left && right && left.displayId === right.displayId
    );
    const placementChanged = (left: Placement | null, right: Placement | null): boolean => Boolean(
      left && right && !sameFoot(left, right)
    );
    let savedPlacementAfterShutdown: Placement | null = null;
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: runtimeDiagnosticKey(),
      launchTimeoutMs: 15_000,
      beforeRestart: async directories => {
        savedPlacementAfterShutdown = await readPlacementAt(directories.userDataDirectory);
      }
    });
    const userDataDirectory = fixture.userDataDirectory;
    const authorizedRootDirectory = fixture.authorizedRootDirectory;
    const readPlacement = (): Promise<Placement | null> => readPlacementAt(userDataDirectory);

    try {
      const petPage = await waitForRendererPage(fixture, 'pet');
      // G4 的 player ready 早于 Main 事务落盘；先等初始位置可见，再模拟真实用户移动。
      await expect(petPage.locator('.character-player')).toHaveAttribute(
        'data-status',
        'ready',
        { timeout: 20_000 }
      );
      await expect.poll(readPlacement, { timeout: 20_000 }).not.toBeNull();
      await expect.poll(async () => (await fixture.getMainE2eState()).geometry).toMatchObject({
        scaleTick: 10,
        outOfBounds: false
      });
      const initialPlacement = await readPlacement();
      await petPage.evaluate(({ offsetX, offsetY }) => {
        const currentScreen = window.screen as Screen & {
          availLeft?: number;
          availTop?: number;
        };
        const minX = currentScreen.availLeft ?? 0;
        const minY = currentScreen.availTop ?? 0;
        const maxX = Math.max(minX, minX + currentScreen.availWidth - window.outerWidth);
        const maxY = Math.max(minY, minY + currentScreen.availHeight - window.outerHeight);
        const targetX = window.screenX - minX >= offsetX
          ? window.screenX - offsetX
          : Math.min(maxX, window.screenX + offsetX);
        const targetY = window.screenY - minY >= offsetY
          ? window.screenY - offsetY
          : Math.min(maxY, window.screenY + offsetY);
        window.moveTo(targetX, targetY);
      }, { offsetX: 64, offsetY: 48 });
      await expect.poll(async () => {
        const current = await readPlacement();
        return placementChanged(initialPlacement, current);
      }, { timeout: 20_000 }).toBe(true);
      await expect.poll(async () => (await fixture.getMainE2eState()).geometry).toMatchObject({
        outOfBounds: false
      });
      const movedPlacement = await readPlacement();
      if (!movedPlacement) throw new Error('用户移动后缺少持久位置');
      await expect.poll(() => renderedFootMatchesPlacement(
        petPage,
        movedPlacement
      )).toBe(true);
      const petClosed = petPage.waitForEvent('close');
      await petPage.evaluate(() => {
        void window.myself.quit();
      });
      await petClosed;
      await fixture.restart();
      expect(Boolean(savedPlacementAfterShutdown)).toBe(true);
      const restartedPetPage = await waitForRendererPage(fixture, 'pet');
      await expect(restartedPetPage.locator('.character-player')).toHaveAttribute(
        'data-status',
        'ready',
        { timeout: 20_000 }
      );
      await expect.poll(async () => (await fixture.getMainE2eState()).geometry, {
        timeout: 15_000
      }).toMatchObject({
        scaleTick: 10,
        outOfBounds: false
      });
      const restoredPlacement = await readPlacement();
      expect(sameFoot(restoredPlacement, savedPlacementAfterShutdown)).toBe(true);
      expect(sameScale(restoredPlacement, savedPlacementAfterShutdown)).toBe(true);
      expect(sameDisplay(restoredPlacement, savedPlacementAfterShutdown)).toBe(true);
      if (!savedPlacementAfterShutdown) throw new Error('重启前缺少持久位置');
      await expect.poll(() => renderedFootMatchesPlacement(
        restartedPetPage,
        savedPlacementAfterShutdown
      )).toBe(true);

      const diagnostics = fixture.logs.join('\n');
      expect(diagnostics).not.toMatch(/myself-e2e-[a-f0-9]{48}/u);
      expect(diagnostics).not.toContain(authorizedRootDirectory);
      expect(diagnostics).not.toMatch(/authorization\s*:/iu);
    } finally {
      await fixture.dispose();
      expect(await pathExistsForAssertion(userDataDirectory)).toBe(false);
      expect(await pathExistsForAssertion(authorizedRootDirectory)).toBe(false);
    }
  });
});
