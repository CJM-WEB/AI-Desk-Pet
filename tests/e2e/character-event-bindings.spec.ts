import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import type { ModelResponse } from '@myself/agent-core';
import type { CharacterBehaviorBindings } from '../../apps/desktop/src/main/characters/character-behavior-bindings';
import { SettingsStore } from '../../apps/desktop/src/main/storage/settings-store';
import { createElectronAppFixture, type ElectronAppFixture } from '../fixtures/electron-app';
import { codingResponse, createProviderResponseGate, startProviderServer,
  type ProviderInspectionRequest, type ProviderStep } from '../fixtures/provider-server';
import { raiseWindowsProcessWindow, readWindowsCursor, readWindowsPointerTarget, readWindowsProcessWindowRect,
  setWindowsCursor, setWindowsLeftButton, type WindowsCursorSnapshot } from '../fixtures/windows-pointer';

// 模型只解释默认作者素材的用途；实际活动、权限、结果及播放均走正式 Main 和 Renderer。
const bindings: CharacterBehaviorBindings = {
  chatting: { stateId: 'state-7', actionId: 'state-7-action' },
  taskRunning: { stateId: 'state-6', actionId: 'state-6-action' },
  awaitingConfirmation: { stateId: 'state-7', actionId: 'state-7-action' },
  moving: { stateId: 'state', actionId: 'state-action' },
  success: { stateId: 'state-8', actionId: 'state-8-action' },
  error: { stateId: 'state-5', actionId: 'state-5-action' },
  praise: { stateId: 'state-8', actionId: 'state-8-action' },
  boredom: { stateId: 'state-3', actionId: 'state-3-action' },
  rest: { stateId: 'state-2', actionId: 'state-2-action' }
};
const none = { kind: 'none', choice: null, mode: 'keep', target: null, distance: null } as const;
type TimelineEvent = { at: number; kind: 'action' | 'motion'; actionId?: string; stateId?: string;
  playbackToken?: string; moving?: boolean; x?: number; y?: number };
type Probe = Awaited<ReturnType<ElectronAppFixture['getCharacterBehaviorProbe']>>;
type Recorder = typeof globalThis & { __eventBindings?: { timeline: TimelineEvent[]; probes: Array<Probe & { at: number }> } };
type Stage = { name: string; at: number; probe: Probe; dragging?: boolean;
  window?: { x: number; y: number; width: number; height: number } };

function isExpression(request: ProviderInspectionRequest): boolean {
  return request.tools.length === 0 && request.responseFormatWasJsonObject
    && request.messages.some(message => message.role === 'system' && message.content.startsWith('Main公开情境与候选：'));
}

function chatSteps(response: ModelResponse, choice: Record<string, unknown> = none, gate?: ProviderStep['gate']): ProviderStep[] {
  const group = Symbol('本轮正文和表现');
  return [
    { response, ...(gate ? { gate } : {}), concurrent: { group, match: request => request.tools.length === 1
      && request.tools[0]?.function.name === 'request_task_authorization' && !request.responseFormatWasJsonObject } },
    { response: { type: 'structured', structured_output: choice }, concurrent: { group, match: isExpression },
      inspect: request => { expect(request.tools).toEqual([]); expect(request.toolChoice).toBe('none'); } }
  ];
}

async function pageFor(fixture: ElectronAppFixture, view: string): Promise<Page> {
  const find = () => (fixture.browser as Browser).contexts().flatMap(context => context.pages())
    .find(page => !page.isClosed() && new URL(page.url()).searchParams.get('view') === view);
  await expect.poll(() => !!find(), { timeout: 20_000 }).toBe(true);
  return find()!;
}

async function record(pet: Page): Promise<void> {
  await pet.evaluate(async () => {
    const scope = globalThis as Recorder;
    scope.__eventBindings = { timeline: [], probes: [] };
    const origin = (await window.myself.getCharacterMotionSnapshot()).position;
    window.myself.subscribeCharacterMotion(event => {
      if (event.type === 'behavior-action') scope.__eventBindings!.timeline.push({ at: Date.now(), kind: 'action',
        stateId: event.stateId, actionId: event.actionId, playbackToken: event.playbackToken });
      if (event.type === 'snapshot') scope.__eventBindings!.timeline.push({ at: Date.now(), kind: 'motion', moving: event.snapshot.moving,
        x: event.snapshot.position.x - origin.x, y: event.snapshot.position.y - origin.y });
    });
    // 独立读取 Main 已接纳的首帧状态；Renderer 的 action 事件本身不等于真实 started。
    setInterval(() => {
      void window.myself.getCharacterBehaviorProbe?.().then(probe => {
        const previous = scope.__eventBindings!.probes.at(-1);
        if (probe && (probe.revision !== previous?.revision || probe.playbackStatus !== previous?.playbackStatus))
          scope.__eventBindings!.probes.push({ at: Date.now(), ...probe });
      }).catch(() => undefined);
    }, 100);
  });
}

async function timeline(pet: Page): Promise<TimelineEvent[]> {
  return pet.evaluate(() => (globalThis as Recorder).__eventBindings?.timeline ?? []);
}

async function waitForStartup(provider: Awaited<ReturnType<typeof startProviderServer>>, gate: NonNullable<ProviderStep['gate']>): Promise<void> {
  await expect.poll(() => ({ waiting: gate.isWaiting(), requests: provider.requests.length, errors: provider.inspectionErrors }))
    .toEqual({ waiting: true, requests: 1, errors: [] });
}

/** 正文通过正式菜单进入历史，授权操作独立从气泡点击，保持原业务判定。 */
async function showHistory(chat: Page): Promise<void> {
  const history = chat.getByRole('region', { name: '历史对话', exact: true });
  if (!(await history.isVisible())) {
    await chat.getByRole('button', { name: '选项', exact: true }).click();
    await chat.getByRole('menuitem', { name: '历史', exact: true }).click();
    await chat.getByRole('button', { name: '选项', exact: true }).click();
  }
  await expect(history).toBeVisible();
}

async function submit(chat: Page, text: string): Promise<void> {
  await showHistory(chat);
  await chat.getByLabel('和我说点什么').fill(text);
  const send = chat.getByRole('button', { name: '发送给 AI Pet' });
  await expect(send).toBeEnabled(); await send.click();
}

/** 只初始化和重启自己创建的临时实例，使正式冷启动时已经具备模型设置和加密测试密钥。 */
async function coldStart(provider: Awaited<ReturnType<typeof startProviderServer>>, mode: 0 | 1 | 2, logSentinels: string[] = []) {
  const fixture = await createElectronAppFixture({ workspaceRoot: resolve(process.cwd()), apiKey: provider.apiKey,
    launchTimeoutMs: 25_000, enableSoftwareRasterizer: true, logSentinels,
    prepareUserData: async ({ userDataDirectory }) => {
      const settings = new SettingsStore(join(userDataDirectory, 'settings.json'), async () => false);
      await settings.saveMovementMode(mode);
      await settings.savePrivacySettings({ dataCategories: { memory: false }, longTermMemory: false,
        autonomousMoodEnabled: false, proactivityMode: 'passive' });
    } });
  try {
    const setupPet = await pageFor(fixture, 'pet');
    // 首个无模型实例先完成正常启动；否则保存设置可能赶上其启动请求并被 restart 正确取消。
    await expect.poll(() => fixture.getCharacterBehaviorProbe(), { timeout: 15_000 })
      .toMatchObject({ actionId: 'idle-action', playbackStatus: 'started' });
    // 播放快照只含运行所需字段；名称由正式角色摘要补齐，明确每例都使用内置默认角色。
    const defaultIdentity = await setupPet.evaluate(async () => {
      const snapshot = await window.myself.getCharacterRuntimeSnapshot();
      const characters = await window.myself.listCharacters();
      return { activeCharacterId: snapshot?.activeCharacterId, manifestId: snapshot?.manifest.id,
        name: characters.find(character => character.id === snapshot?.activeCharacterId)?.name };
    });
    expect(defaultIdentity).toEqual({ activeCharacterId: 'builtin-default', manifestId: 'builtin-default', name: 'AI Pet默认角色' });
    await test.info().attach('默认角色身份', { body: JSON.stringify(defaultIdentity), contentType: 'application/json' });
    await setupPet.evaluate(async ({ baseUrl, apiKey }) => {
      await window.myself.saveProviderProfile({ profile: { id: 'bindings-e2e', displayName: '用途生命周期隔离验收',
        mode: 'custom', protocol: 'openai-compatible', baseUrl, modelId: 'bindings-e2e', additionalParameters: {}, capabilities: ['chat', 'tools'] },
        secret: apiKey, persistSecret: true });
      await window.myself.saveModelRoute({ primaryProfileId: 'bindings-e2e', chatProfileId: 'bindings-e2e', agentProfileId: 'bindings-e2e',
        visionProfileId: null, fallbackProfileIds: [], allowCrossProviderFallback: false });
      await window.myself.chooseAuthorizedRoot();
    }, { baseUrl: provider.baseUrl, apiKey: provider.apiKey });
    expect(provider.requests).toHaveLength(0);
    const restartAt = Date.now(); await fixture.restart();
    const pet = await pageFor(fixture, 'pet'); const chat = await pageFor(fixture, 'chat');
    await record(pet);
    return { fixture, pet, chat, bubble: await pageFor(fixture, 'bubble'), restartAt };
  } catch (error) {
    try { await test.info().attach('准备实例启动失败日志', { body: fixture.logs.join('\n'), contentType: 'text/plain' }); }
    finally { await fixture.dispose(); }
    throw error;
  }
}

function startupStep(gate: NonNullable<ProviderStep['gate']>): ProviderStep {
  return { response: { type: 'structured', structured_output: bindings }, gate,
    inspect: request => {
      expect(request.tools).toEqual([]); expect(request.toolChoice).toBe('none');
      const author = JSON.parse(request.messages.find(message => message.role === 'user')!.content) as { authorStates: Array<{ stateId: string }> };
      expect(author.authorStates.map(state => state.stateId)).toEqual(expect.arrayContaining(['state', 'state-3', 'state-5', 'state-6', 'state-7', 'state-8']));
      expect(JSON.stringify(request.messages)).not.toContain('本轮用户正文');
    } };
}

async function started(fixture: ElectronAppFixture, actionId: string, name: string, stages: Stage[]): Promise<void> {
  await expect.poll(() => fixture.getCharacterBehaviorProbe(), { timeout: 12_000, intervals: [100, 200] })
    .toMatchObject({ actionId, playbackStatus: 'started' });
  stages.push({ name, at: Date.now(), probe: await fixture.getCharacterBehaviorProbe() });
}

/** 证据只保存隔离播放时序、阶段及脱敏 fixture 日志，不复制聊天或工具正文。 */
async function attachEvidence(testInfo: TestInfo, pet: Page | undefined, stages: Stage[], fixture?: ElectronAppFixture): Promise<void> {
  const events = pet && !pet.isClosed() ? await timeline(pet) : [];
  const probes = pet && !pet.isClosed() ? await pet.evaluate(() => (globalThis as Recorder).__eventBindings?.probes ?? []) : [];
  const path = testInfo.outputPath('event-bindings-evidence.json');
  await writeFile(path, JSON.stringify({ stages, events, probes, logs: fixture?.logs ?? [] }, null, 2), 'utf8');
  await testInfo.attach('默认素材真实首帧和阶段证据', { path, contentType: 'application/json' });
}

test('冷启动用途让慢正文前保持思考，夸赞只进入一段有界反应后退出', async ({}, testInfo) => {
  test.setTimeout(85_000);
  const startup = createProviderResponseGate(); const main = createProviderResponseGate();
  const provider = await startProviderServer([startupStep(startup), ...chatSteps({ type: 'text', text: '谢谢夸奖，我很开心。' },
    { ...none, kind: 'reaction', choice: bindings.praise }, main)]);
  let app: Awaited<ReturnType<typeof coldStart>> | undefined; const stages: Stage[] = [];
  try {
    app = await coldStart(provider, 0); await waitForStartup(provider, startup);
    startup.release(); await provider.waitForCompletedResponses(1);
    await app.pet.evaluate(() => window.myself.openChat());
    await submit(app.chat, '你刚才表现得特别棒，我很喜欢你');
    await expect.poll(() => main.isWaiting()).toBe(true);
    await started(app.fixture, 'state-7-action', '主正文仍挂起时思考已首帧', stages);
    const thoughtStart = Date.now(); await app.pet.waitForTimeout(5_100);
    const processing = (await timeline(app.pet)).filter(event => event.kind === 'action' && event.at >= thoughtStart);
    expect(processing.length).toBeGreaterThanOrEqual(2); expect(processing.every(event => event.actionId === 'state-7-action')).toBe(true);
    await expect(app.chat.getByText('谢谢夸奖，我很开心。', { exact: true })).toHaveCount(0);
    main.release(); await expect(app.chat.getByText('谢谢夸奖，我很开心。', { exact: true })).toBeVisible();
    await started(app.fixture, 'state-8-action', '正文结束后夸赞反应已首帧', stages);
    await started(app.fixture, 'idle-action', '单段夸赞结束回到有效待机', stages);
    const exitAt = Date.now();
    const reaction = (await timeline(app.pet)).filter(event => event.kind === 'action' && event.actionId === 'state-8-action');
    // 状态按作者时长驻留，期间允许素材自然续播；退出后不能冷却一会儿再次进入开心。
    expect(reaction.length).toBeGreaterThanOrEqual(1);
    expect(exitAt - reaction[0]!.at).toBeGreaterThanOrEqual(2_000);
    expect(exitAt - reaction[0]!.at).toBeLessThan(6_000);
    await app.pet.waitForTimeout(20_000);
    expect((await timeline(app.pet)).filter(event => event.kind === 'action' && event.actionId === 'state-8-action' && event.at >= exitAt)).toEqual([]);
    provider.assertComplete(); expect(provider.inspectionErrors).toEqual([]);
    expect(app.fixture.logs.join('\n')).not.toContain('CHARACTER_PLAYBACK_UNAUTHORIZED');
  } finally {
    startup.release(); main.release();
    try { await attachEvidence(testInfo, app?.pet, stages, app?.fixture); }
    finally { try { await app?.fixture.dispose(); } finally { await provider.close(); } }
  }
});

for (const result of ['success', 'error'] as const) {
  test(`真实${result === 'success' ? '读取成功' : '命令失败'}按授权等待、工作和工具终态立即切换表现`, async ({}, testInfo) => {
    test.setTimeout(80_000);
    const startup = createProviderResponseGate(); const core = createProviderResponseGate();
    const nonce = `隔离文件-${randomBytes(12).toString('hex')}`;
    const command = 'exit 7'; const finalText = result === 'success' ? '已经读取隔离文件。' : '命令实际退出码为7。';
    const provider = await startProviderServer([startupStep(startup), ...chatSteps({ type: 'tool_request', request: {
      requestId: 'scope', toolName: 'request_task_authorization', arguments: {}
    } }), { gate: core, response: codingResponse(result === 'success'
      ? [{ name: 'read', args: { path: 'note.txt' }, id: 'actual-tool' }]
      : [{ name: 'bash', args: { command, cwd: '.' }, id: 'actual-tool' }]) },
    { response: request => {
      const messages = request.messages as Array<{ role: string; tool_call_id?: string; content: string }>;
      const tool = messages.find(message => message.tool_call_id === 'actual-tool');
      expect(tool, '必须先有正式 Core 工具结果，才能提供总结').toBeDefined();
      if (result === 'success') expect(tool!.content).toContain(nonce);
      else expect(tool!.content).toContain('7');
      return codingResponse(finalText);
    } }]);
    let app: Awaited<ReturnType<typeof coldStart>> | undefined; const stages: Stage[] = [];
    try {
      app = await coldStart(provider, result === 'success' ? 1 : 2, [nonce]);
      await writeFile(join(app.fixture.authorizedRootDirectory, 'note.txt'), nonce, 'utf8');
      await waitForStartup(provider, startup); startup.release(); await provider.waitForCompletedResponses(1);
      await app.pet.evaluate(() => window.myself.openChat());
      await submit(app.chat, result === 'success' ? '请读取 note.txt 的实际内容' : `请执行 PowerShell 命令 ${command}`);
      const scope = app.bubble.getByRole('article', { name: '本地任务授权' }); await expect(scope).toBeVisible();
      await started(app.fixture, 'state-7-action', '范围未授权时等待已首帧', stages);
      expect(provider.requests.filter(request => request.toolCount > 1)).toHaveLength(0);
      await scope.getByRole('button', { name: '授权并开始任务' }).click();
      await expect.poll(() => core.isWaiting()).toBe(true);
      await started(app.fixture, 'state-6-action', '真实 Core 首请求挂起时工作已首帧', stages);
      const workStart = Date.now(); await app.pet.waitForTimeout(3_600);
      const processing = (await timeline(app.pet)).filter(event => event.kind === 'action' && event.at >= workStart);
      expect(processing.length).toBeGreaterThanOrEqual(1);
      expect(processing.every(event => event.actionId === 'state-6-action')).toBe(true);
      await expect(app.chat.getByText(finalText, { exact: true })).toHaveCount(0); core.release();
      if (result === 'error') {
        const permission = app.bubble.getByRole('region', { name: '具体操作许可' });
        await expect(permission).toBeVisible(); await permission.locator('.bubble-summary').click();
        await expect(permission).toContainText(command);
        await started(app.fixture, 'state-7-action', '真实命令等待具体许可时工作退出', stages);
        await permission.getByRole('button', { name: '确认运行命令' }).click();
      }
      await expect(app.chat.getByText(finalText, { exact: true })).toBeVisible();
      await expect(app.chat.locator('.phase-pill')).toHaveClass(result === 'success' ? /phase-success/u : /phase-error/u);
      await started(app.fixture, result === 'success' ? 'state-8-action' : 'state-5-action', '真实工具终态已触发结果首帧', stages);
      await started(app.fixture, result === 'success' ? 'state-action' : 'idle-action', '有界结果反应结束后恢复运动模式', stages);
      expect(await readFile(join(app.fixture.authorizedRootDirectory, 'note.txt'), 'utf8')).toBe(nonce);
      provider.assertComplete(); expect(provider.inspectionErrors).toEqual([]);
      expect(provider.requests.filter(request => request.toolCount > 1)).toHaveLength(2);
      expect(app.fixture.logs.join('\n')).not.toContain('CHARACTER_PLAYBACK_UNAUTHORIZED');
      expect(app.fixture.capturedLogEvidence).toEqual({ apiKey: false, authorizedRoot: false, authorizationHeader: false, sentinels: [false] });
    } finally {
      startup.release(); core.release();
      try { await attachEvidence(testInfo, app?.pet, stages, app?.fixture); }
      finally { try { await app?.fixture.dispose(); } finally { await provider.close(); } }
    }
  });
}

for (const mode of [0, 1, 2] as const) {
  test(`真实默认素材冷启动运动模式${mode}，完整用途准备后遵守首帧与模式`, async ({}, testInfo) => {
    test.setTimeout(mode === 2 ? 85_000 : 65_000);
    const startup = createProviderResponseGate(); const provider = await startProviderServer([startupStep(startup)]);
    let app: Awaited<ReturnType<typeof coldStart>> | undefined; const stages: Stage[] = [];
    try {
      app = await coldStart(provider, mode); await waitForStartup(provider, startup);
      const before = await app.pet.evaluate(() => window.myself.getCharacterMotionSnapshot());
      expect(before.moving).toBe(false);
      startup.release(); await provider.waitForCompletedResponses(1);
      if (mode === 0) {
        await app.pet.waitForTimeout(2_500);
        expect((await timeline(app.pet)).filter(event => event.kind === 'motion').every(event => !event.moving)).toBe(true);
        expect((await app.pet.evaluate(() => window.myself.getCharacterMotionSnapshot())).position).toEqual(before.position);
        await started(app.fixture, 'idle-action', '静止模式保持待机且无自主位移', stages);
      } else {
        await expect.poll(async () => (await timeline(app!.pet)).some(event => event.kind === 'motion' && event.moving),
          { timeout: mode === 2 ? 35_000 : 12_000, intervals: [100, 200] }).toBe(true);
        await started(app.fixture, 'state-action', '真实运动已等待跑步首帧', stages);
        const firstMove = (await timeline(app.pet)).find(event => event.kind === 'motion' && event.moving)!;
        const firstAction = (await timeline(app.pet)).filter(event => event.kind === 'action'
          && event.actionId === 'state-action' && event.at <= firstMove.at).at(-1)!;
        expect(firstAction).toBeDefined(); expect(firstMove.at - firstAction.at).toBeGreaterThanOrEqual(0);
        expect(firstMove.at - firstAction.at).toBeLessThan(1_500);
        if (mode === 2) expect(firstMove.at - app.restartAt).toBeGreaterThanOrEqual(9_000);
        await app.pet.waitForTimeout(2_500);
        const positions = (await timeline(app.pet)).filter(event => event.kind === 'motion' && event.at >= firstMove.at);
        expect(positions.some(event => Math.hypot(event.x! - firstMove.x!, event.y! - firstMove.y!) > 5)).toBe(true);
      }
      expect(provider.requests).toHaveLength(1); provider.assertComplete(); expect(provider.inspectionErrors).toEqual([]);
      expect(app.fixture.logs.join('\n')).not.toContain('CHARACTER_PLAYBACK_UNAUTHORIZED');
    } finally {
      startup.release();
      try { await attachEvidence(testInfo, app?.pet, stages, app?.fixture); }
      finally { try { await app?.fixture.dispose(); } finally { await provider.close(); } }
    }
  });
}

test('真实拖拽与挂起聊天重叠，释放后继续思考并在回复后恢复持续运动', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', '本用例需要真实 Win32 光标和按钮链。');
  test.setTimeout(90_000);
  const startup = createProviderResponseGate(); const main = createProviderResponseGate();
  const reply = '拖拽结束后继续回复。';
  const provider = await startProviderServer([startupStep(startup), ...chatSteps({ type: 'text', text: reply }, none, main)]);
  let app: Awaited<ReturnType<typeof coldStart>> | undefined;
  let originalCursor: WindowsCursorSnapshot | undefined; let ownsButton = false;
  const stages: Stage[] = [];
  const stage = async (name: string) => {
    const state = await app!.fixture.getMainE2eState();
    stages.push({ name, at: Date.now(), probe: await app!.fixture.getCharacterBehaviorProbe(),
      dragging: state.petNativeDragging, window: state.petWindowBoundsDip });
  };
  try {
    app = await coldStart(provider, 1); await waitForStartup(provider, startup);
    startup.release(); await provider.waitForCompletedResponses(1);
    await started(app.fixture, 'state-action', '聊天前持续运动已首帧', stages);
    await app.pet.evaluate(() => window.myself.openChat());
    await submit(app.chat, '稍等一下，我想一边拖动你一边聊聊天');
    await expect.poll(() => main.isWaiting()).toBe(true);
    await started(app.fixture, 'state-7-action', '拖拽前正文挂起且思考已首帧', stages);
    expect((await app.pet.evaluate(() => window.myself.getCharacterMotionSnapshot())).moving).toBe(false);
    // 等自己的聊天收起动画结束并保持请求在途，使 Win32 主窗口查询准确落在自己的桌宠上。
    await app.chat.evaluate(() => window.myself.hideChat());
    await expect(app.chat.locator('.chat-island-stage')).toHaveAttribute('data-island-mode', 'hidden');
    const shell = app.pet.getByRole('main', { name: 'AI Pet 桌宠' });
    const candidates = [{ x: 90, y: 110 }, ...Array.from({ length: 42 }, (_, index) => ({
      x: 18 + (index % 6) * 24, y: 18 + Math.floor(index / 6) * 24
    }))];
    let hit: { x: number; y: number } | undefined;
    for (const point of candidates) {
      await shell.evaluate((element, value) => element.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, clientX: value.x, clientY: value.y, pointerId: 73
      })), point);
      if (!(await app.fixture.getPetInteractionProbe()).passthrough) { hit = point; break; }
    }
    expect(hit, '必须命中实际角色像素才允许系统左键按下').toBeDefined();
    if (!hit) throw new Error('VISIBLE_CHARACTER_PIXEL_MISSING');
    originalCursor = await readWindowsCursor();
    expect((await readWindowsPointerTarget()).leftButtonDown, '不接管用户正在按住的左键').toBe(false);
    await raiseWindowsProcessWindow(app.fixture.processId);
    const bounds = (await app.fixture.getMainE2eState()).petWindowBoundsDip;
    const rect = await readWindowsProcessWindowRect(app.fixture.processId);
    const scaleX = (rect.right - rect.left) / bounds.width, scaleY = (rect.bottom - rect.top) / bounds.height;
    expect(Math.abs(scaleX / scaleY - 1), '确认查询到的是桌宠尺寸，不能误选同进程的聊天窗口').toBeLessThan(0.1);
    const point = { x: rect.left + Math.round(hit.x * scaleX), y: rect.top + Math.round(hit.y * scaleY) };
    await setWindowsCursor(point);
    await expect.poll(() => app!.fixture.getPetInteractionProbe()).toMatchObject({ passthrough: false });
    expect(await readWindowsPointerTarget()).toEqual({ processId: app.fixture.processId, leftButtonDown: false });
    const workArea = await app.pet.evaluate(() => ({ left: (screen as Screen & { availLeft?: number }).availLeft ?? 0, width: screen.availWidth }));
    const direction = bounds.x < workArea.left + workArea.width / 2 ? 1 : -1;
    ownsButton = true; await setWindowsLeftButton(true);
    for (const offset of [2, 6, 12]) {
      await setWindowsCursor({ x: point.x + Math.round(direction * offset * scaleX), y: point.y });
      if ((await app.fixture.getMainE2eState()).petNativeDragging) break;
    }
    await expect.poll(() => app!.fixture.getPetInteractionProbe()).toMatchObject({ dragging: true });
    await expect.poll(async () => (await app!.fixture.getMainE2eState()).petNativeDragging).toBe(true);
    await stage('真实左键拖拽已开始，聊天请求仍挂起');
    const anchorCursor = await readWindowsCursor(); const anchor = (await app.fixture.getMainE2eState()).petWindowBoundsDip;
    await app.pet.waitForTimeout(1_200);
    expect((await app.fixture.getMainE2eState()).petWindowBoundsDip).toEqual(anchor);
    expect(main.isWaiting()).toBe(true);
    expect((await app.pet.evaluate(() => window.myself.getCharacterMotionSnapshot())).moving).toBe(false);
    await setWindowsCursor({ x: anchorCursor.x + Math.round(direction * 24 * scaleX), y: anchorCursor.y });
    await expect.poll(async () => Math.abs((await app!.fixture.getMainE2eState()).petWindowBoundsDip.x - (anchor.x + direction * 24)))
      .toBeLessThanOrEqual(2);
    expect((await app.fixture.getMainE2eState()).petWindowBoundsDip).toMatchObject({ y: anchor.y, width: anchor.width, height: anchor.height });
    await stage('拖拽只跟随受控系统光标位移');
    await setWindowsLeftButton(false); ownsButton = false;
    await expect.poll(async () => (await app!.fixture.getMainE2eState()).petNativeDragging).toBe(false);
    await expect.poll(() => app!.fixture.getPetInteractionProbe()).toMatchObject({ dragging: false });
    await started(app.fixture, 'state-7-action', '释放拖拽后尚未回复，继续思考', stages);
    expect((await app.pet.evaluate(() => window.myself.getCharacterMotionSnapshot())).moving).toBe(false);
    expect(main.isWaiting()).toBe(true); await stage('释放后聊天仍占用，不能提前恢复运动');
    main.release(); await app.pet.evaluate(() => window.myself.openChat());
    await showHistory(app.chat);
    await expect(app.chat.getByText(reply, { exact: true })).toBeVisible();
    await started(app.fixture, 'state-action', '聊天结束后恢复持续运动首帧', stages);
    await expect.poll(async () => (await app!.pet.evaluate(() => window.myself.getCharacterMotionSnapshot())).moving).toBe(true);
    provider.assertComplete(); expect(provider.requests).toHaveLength(3); expect(provider.inspectionErrors).toEqual([]);
    expect(app.fixture.logs.join('\n')).not.toContain('CHARACTER_PLAYBACK_UNAUTHORIZED');
  } finally {
    startup.release(); main.release();
    try { if (ownsButton) await setWindowsLeftButton(false); }
    finally {
      try { if (originalCursor) await setWindowsCursor(originalCursor); }
      finally {
        try { await attachEvidence(testInfo, app?.pet, stages, app?.fixture); }
        finally { try { await app?.fixture.dispose(); } finally { await provider.close(); } }
      }
    }
  }
});
