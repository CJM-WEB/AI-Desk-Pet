import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { SettingsStore } from '../../apps/desktop/src/main/storage/settings-store';
import { createElectronAppFixture, type ElectronAppFixture } from '../fixtures/electron-app';
import { startProviderServer, type ProviderStep } from '../fixtures/provider-server';

type Observation = {
  at: number;
  kind: 'action' | 'position' | 'viewport';
  actionId?: string;
  moving?: boolean;
  x?: number;
  y?: number;
  targetX?: number;
  targetY?: number;
  contentWidth?: number;
  contentHeight?: number;
  canvasWidth?: number;
  canvasHeight?: number;
  nativeX?: number;
  nativeY?: number;
  hostOffsetX?: number;
  hostOffsetY?: number;
};
type ObservationScope = typeof globalThis & { __motionContinuity?: Observation[] };

/** 只脚本化当前聊天轮的模型建议，真实 Main、Engine、Pixi 和窗口位移完整运行。 */
function movementSteps(mode: 0 | 1 | 2): ProviderStep[] {
  const group = Symbol(`movement-mode-${mode}`);
  return [
    {
      response: { type: 'text', text: `运动模式 ${mode} 已处理。` },
      concurrent: { group, match: request => request.tools.length === 1
        && request.tools[0]?.function.name === 'request_task_authorization'
        && !request.responseFormatWasJsonObject }
    },
    {
      response: { type: 'structured', structured_output: {
        moodUpdate: null, requestKind: 'ambient', explicitPlayback: null,
        backgroundSelection: null, movementControl: { kind: 'set_mode', mode },
        expressionPlan: { states: [{ stateId: 'state', score: 1, activity: 'moving',
          actions: [{ actionId: 'state-action', score: 1 }] }] }
      } },
      concurrent: { group, match: request => request.tools.length === 0
        && request.responseFormatWasJsonObject
        && request.messages.some(message => message.role === 'system'
          && message.content.startsWith('Main公开情境与候选：')
          && JSON.parse(message.content.slice('Main公开情境与候选：'.length)).trigger === 'chat') },
      inspect: request => {
        expect(request.tools).toEqual([]);
        expect(request.toolChoice).toBe('none');
      }
    }
  ];
}

async function renderer(fixture: ElectronAppFixture, view: string): Promise<Page> {
  const find = () => fixture.browser.contexts().flatMap(context => context.pages())
    .find(page => !page.isClosed() && new URL(page.url()).searchParams.get('view') === view);
  await expect.poll(() => Boolean(find()), { timeout: 30_000 }).toBe(true);
  return find()!;
}

async function submit(page: Page, text: string): Promise<void> {
  await page.getByLabel('和我说点什么').fill(text);
  const send = page.getByRole('button', { name: '发送给 AI Pet' });
  await expect(send).toBeEnabled();
  await send.click();
}

async function observations(page: Page): Promise<Observation[]> {
  return page.evaluate(() => (globalThis as ObservationScope).__motionContinuity ?? []);
}

/** 检查途中每个采样，排除空 Canvas 与终点回缩掩盖的假通过。 */
function assertStableViewport(events: Observation[]): void {
  const viewports = events.filter(event => event.kind === 'viewport');
  expect(viewports.length).toBeGreaterThan(30);
  expect([...new Set(viewports.map(event => `${event.contentWidth}x${event.contentHeight}`))],
    '移动全过程客户区必须保持 180×220，不能放大后再由下一轮动作缩回').toEqual(['180x220']);
  expect(viewports.every(event => (event.canvasWidth ?? 0) > 0 && (event.canvasHeight ?? 0) > 0)).toBe(true);
  expect(new Set(viewports.map(event => `${event.canvasWidth}x${event.canvasHeight}`)).size,
    '移动和动作循环均不能重新定义画布尺寸').toBe(1);
  expect(viewports.every(event => event.hostOffsetX === 0 && event.hostOffsetY === 0),
    '原生窗口已经移动，任何绘制帧都不能叠加迟到的角色位置补偿').toBe(true);
}

/** 按同一目标下的真实窗口原点检查回退，不以 Main 内部路程代替显示位置。 */
function assertForwardWindowMotion(events: Observation[]): void {
  const frames = events.filter(event => event.kind === 'viewport' && event.moving);
  let checked = 0;
  const backsteps: number[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1]!, current = frames[index]!;
    if (current.targetX !== previous.targetX || current.targetY !== previous.targetY) continue;
    const dx = previous.targetX! - previous.nativeX!, dy = previous.targetY! - previous.nativeY!;
    const distance = Math.hypot(dx, dy);
    if (distance < 64) continue;
    const progress = ((current.nativeX! - previous.nativeX!) * dx
      + (current.nativeY! - previous.nativeY!) * dy) / distance;
    checked += 1;
    // 高 DPI 原点报告允许 2 DIP 取整；不能容忍旧补偿造成的周期性明显回跳。
    if (progress < -2) backsteps.push(progress);
  }
  expect(checked).toBeGreaterThan(30);
  expect(backsteps).toEqual([]);
}

/** 只累计真实 snapshot 的相对路程，往返移动不能被末位置抵消。 */
function pathLength(events: Observation[]): number {
  const positions = events.filter(event => event.kind === 'position');
  return positions.slice(1).reduce((total, point, index) => {
    const previous = positions[index]!;
    return total + Math.hypot(point.x! - previous.x!, point.y! - previous.y!);
  }, 0);
}

/** 到达旧目标附近后改采明显不同的新目标，排除镜像重排造成的细小目标修正。 */
function arrivalContinuations(events: Observation[]): number {
  const positions = events.filter(event => event.kind === 'position');
  return positions.slice(1).filter((point, index) => {
    const previous = positions[index]!;
    return point.moving && Math.hypot(point.targetX! - previous.targetX!, point.targetY! - previous.targetY!) > 64
      && Math.hypot(point.x! - previous.targetX!, point.y! - previous.targetY!) <= 40;
  }).length;
}

test('默认跑步有限动画在真实三档运动中持续接续、静止停止、间歇按时再动', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const provider = await startProviderServer([
    ...movementSteps(1), ...movementSteps(0), ...movementSteps(2)
  ]);
  let fixture: ElectronAppFixture | undefined;
  let pet: Page | undefined;
  try {
    fixture = await createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()), apiKey: provider.apiKey,
      launchTimeoutMs: 30_000, enableSoftwareRasterizer: true,
      prepareUserData: async ({ userDataDirectory }) => {
        const settings = new SettingsStore(join(userDataDirectory, 'settings.json'));
        await settings.saveMovementMode(0);
        await settings.savePrivacySettings({ dataCategories: { memory: false },
          longTermMemory: false, autonomousMoodEnabled: false, proactivityMode: 'passive' });
      }
    });
    pet = await renderer(fixture, 'pet');
    const chat = await renderer(fixture, 'chat');
    await expect.poll(() => fixture!.getCharacterBehaviorProbe(), { timeout: 15_000 })
      .toMatchObject({ actionId: 'idle-action', playbackStatus: 'started' });
    await pet.evaluate(async ({ baseUrl, apiKey }) => {
      await window.myself.saveProviderProfile({ profile: {
        id: 'motion-continuity', displayName: '运动连续性验证', mode: 'custom',
        protocol: 'openai-compatible', baseUrl, modelId: 'motion-continuity',
        additionalParameters: {}, capabilities: ['chat', 'tools']
      }, secret: apiKey, persistSecret: false });
      await window.myself.saveModelRoute({ primaryProfileId: 'motion-continuity',
        chatProfileId: 'motion-continuity', agentProfileId: 'motion-continuity',
        visionProfileId: null, fallbackProfileIds: [], allowCrossProviderFallback: false });
      const baseline = (await window.myself.getCharacterMotionSnapshot()).position;
      const scope = globalThis as ObservationScope;
      scope.__motionContinuity = [];
      let latestMotion = await window.myself.getCharacterMotionSnapshot();
      // 同时捕获原生 resize 与绘制帧，防止只验停止后的尺寸而漏掉移动途中放大再缩回。
      const sampleViewport = () => {
        const canvas = document.querySelector('canvas');
        const host = document.querySelector('.character-player-host');
        const matrix = host ? new DOMMatrixReadOnly(getComputedStyle(host).transform) : null;
        scope.__motionContinuity?.push({ at: Date.now(), kind: 'viewport',
          contentWidth: window.innerWidth, contentHeight: window.innerHeight,
          canvasWidth: canvas?.width, canvasHeight: canvas?.height,
          nativeX: window.screenX, nativeY: window.screenY,
          hostOffsetX: matrix?.m41, hostOffsetY: matrix?.m42,
          moving: latestMotion.moving, targetX: latestMotion.target.x, targetY: latestMotion.target.y });
      };
      window.addEventListener('resize', sampleViewport);
      const sampleFrame = () => { sampleViewport(); requestAnimationFrame(sampleFrame); };
      requestAnimationFrame(sampleFrame);
      window.myself.subscribeCharacterMotion(event => {
        const at = Date.now();
        if (event.type === 'behavior-action') scope.__motionContinuity?.push({
          at, kind: 'action', actionId: event.actionId
        });
        if (event.type === 'snapshot') latestMotion = event.snapshot;
        if (event.type === 'snapshot') scope.__motionContinuity?.push({
          at, kind: 'position', moving: event.snapshot.moving,
          x: event.snapshot.position.x - baseline.x, y: event.snapshot.position.y - baseline.y,
          targetX: event.snapshot.target.x - baseline.x, targetY: event.snapshot.target.y - baseline.y
        });
      });
      await window.myself.openChat();
    }, { baseUrl: provider.baseUrl, apiKey: provider.apiKey });
    const mode = async () => (JSON.parse(await readFile(join(fixture!.userDataDirectory,
      'settings.json'), 'utf8')) as { movementMode: number }).movementMode;

    await submit(chat, '保持运动');
    await expect.poll(mode).toBe(1);
    await expect.poll(async () => (await observations(pet!))
      .some(event => event.kind === 'position' && event.moving)).toBe(true);
    await expect.poll(() => fixture!.getCharacterBehaviorProbe())
      .toMatchObject({ actionId: 'state-action', playbackStatus: 'started' });
    const runningStart = (await observations(pet)).find(event => event.kind === 'position' && event.moving)!.at;
    // 默认跑步为 11 帧、8 fps、1.25 倍速；真实经过十余轮，禁止替换主进程时钟。
    await pet.waitForTimeout(14_000);
    await expect.poll(async () => arrivalContinuations((await observations(pet!))
      .filter(event => event.at >= runningStart)), { timeout: 12_000 }).toBeGreaterThanOrEqual(1);
    const continuous = (await observations(pet)).filter(event => event.at >= runningStart);
    assertStableViewport(continuous);
    assertForwardWindowMotion(continuous);
    const actions = continuous.filter(event => event.kind === 'action');
    expect(actions.length).toBeGreaterThanOrEqual(2);
    expect(actions.every(event => event.actionId === 'state-action')).toBe(true);
    for (let second = 1; second < 13; second += 1) {
      const segment = continuous.filter(event => event.at >= runningStart + second * 1_000
        && event.at < runningStart + (second + 1) * 1_000);
      expect(pathLength(segment), `持续模式第 ${second + 1} 秒必须有真实位移`).toBeGreaterThan(5);
    }
    const firstRun = (await observations(pet)).find(event => event.kind === 'action' && event.actionId === 'state-action')!;
    expect(runningStart - firstRun.at, '首个动作调度到真实位移必须在首帧准备期限内').toBeGreaterThanOrEqual(0);
    expect(runningStart - firstRun.at).toBeLessThan(1_500);

    await submit(chat, '停止不动');
    await expect.poll(mode).toBe(0);
    await expect.poll(async () => (await pet!.evaluate(() => window.myself.getCharacterMotionSnapshot())).moving).toBe(false);
    await pet.waitForTimeout(300);
    const stoppedAt = Date.now();
    await pet.waitForTimeout(3_000);
    expect(pathLength((await observations(pet)).filter(event => event.at >= stoppedAt))).toBe(0);
    expect((await observations(pet)).filter(event => event.at >= stoppedAt && event.kind === 'action')
      .every(event => event.actionId !== 'state-action')).toBe(true);

    const intermittentRequestedAt = Date.now();
    await submit(chat, '时不时动一下');
    await expect.poll(mode).toBe(2);
    await expect(chat.getByText('运动模式 2 已处理。')).toBeVisible();
    await expect.poll(async () => (await observations(pet!)).some(event => event.at >= intermittentRequestedAt
      && event.kind === 'position' && event.moving), { timeout: 35_000, intervals: [100, 250, 500] }).toBe(true);
    const intermittentStart = (await observations(pet)).find(event => event.at >= intermittentRequestedAt
      && event.kind === 'position' && event.moving)!;
    expect(intermittentStart.at - intermittentRequestedAt).toBeGreaterThanOrEqual(9_500);
    expect(intermittentStart.at - intermittentRequestedAt).toBeLessThan(33_000);
    await expect.poll(async () => (await observations(pet!)).some(event => event.at > intermittentStart.at
      && event.kind === 'position' && event.moving === false), { timeout: 20_000 }).toBe(true);
    const intermittentStop = (await observations(pet)).find(event => event.at > intermittentStart.at
      && event.kind === 'position' && event.moving === false)!;
    expect(pathLength((await observations(pet)).filter(event => event.at >= intermittentStart.at
      && event.at <= intermittentStop.at))).toBeGreaterThan(2);
    await pet.waitForTimeout(3_000);
    expect(pathLength((await observations(pet)).filter(event => event.at > intermittentStop.at + 200))).toBe(0);
    expect((await observations(pet)).filter(event => event.at > intermittentStop.at + 200 && event.kind === 'action')
      .every(event => event.actionId !== 'state-action')).toBe(true);
    assertStableViewport((await observations(pet)).filter(event => event.at >= runningStart));
    assertForwardWindowMotion((await observations(pet)).filter(event => event.at >= runningStart));
    provider.assertComplete();
    expect(provider.inspectionErrors).toEqual([]);
    expect(fixture.logs.join('\n')).not.toContain('CHARACTER_PLAYBACK_UNAUTHORIZED');
  } finally {
    try {
      if (pet && !pet.isClosed()) {
        const evidence = testInfo.outputPath('motion-observations.json');
        await writeFile(evidence, JSON.stringify(await observations(pet)), 'utf8');
        await testInfo.attach('运动模式相对坐标与动作时序', { path: evidence, contentType: 'application/json' });
      }
    } finally {
      try { await fixture?.dispose(); } finally { await provider.close(); }
    }
  }
});
