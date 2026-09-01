import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { expect, test as baseTest } from '@playwright/test';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

const REPOSITORY_ROOT = resolve(__dirname, '..', '..');
const STATIC_SERVER_SCRIPT = resolve(REPOSITORY_ROOT, 'tests/serve-website-export.mjs');
const SERVER_READY_PREFIX = 'WEBSITE_SERVER_READY ';
const WEBSITE = '[data-testid="website-experience"]';
const HOME = '[data-testid="home-experience"]';
const SWARM = '[data-active-count]';
const LIQUID_HOME = '[data-testid="liquid-glass-home"]';
const E2E_ADMIN_TOKEN = 'e2e-admin-session';
const SCREENSHOT_DIRECTORY = resolve(
  REPOSITORY_ROOT,
  'tests/.playwright-output/website/screenshots'
);
const CHAPTER_IDS = [
  'home',
  'about',
  'download',
  'community',
  'feedback'
] as const;

type ChapterId = (typeof CHAPTER_IDS)[number];

interface WebsiteServerInfo {
  url: string;
  runId: string;
  buildMarker: string;
}

interface WebsiteServerReadyPayload extends WebsiteServerInfo {
  port: number;
}

interface WebsiteServerReadyWait {
  promise: Promise<WebsiteServerInfo>;
  cancel: (error?: Error) => void;
}

interface E2eReceipt {
  submissionId: string;
  statusToken: string;
  statusPath: '/submission-status/';
  status: 'uploading' | 'manual_review_pending';
}

async function submitFeedbackViaApi(
  request: APIRequestContext,
  content: string,
  kind: 'feedback' | 'suggestion' = 'feedback'
): Promise<E2eReceipt> {
  const response = await request.post('/api/v1/feedback', {
    data: {
      kind,
      authorName: '',
      content
    }
  });
  expect(response.ok()).toBe(true);
  const receipt = (await response.json()).data as E2eReceipt;
  expect(receipt.status).toBe('manual_review_pending');
  const hiddenStatus = await request.post('/api/v1/submission-status', {
    data: { statusToken: receipt.statusToken }
  });
  expect((await hiddenStatus.json()).data.status).toBe('manual_review_pending');
  return receipt;
}

async function submitSharedPackageViaApi(
  request: APIRequestContext,
  title: string,
  packageFileName = 'safe-pet.zip'
): Promise<E2eReceipt> {
  const preparedResponse = await request.post('/api/v1/submissions/prepare', {
    data: {
      kind: 'shared_package',
      title,
      body: `${title} 的 AI Pet 资源说明`,
      coverFile: { fileName: 'cover.png', sizeBytes: 7, contentType: 'image/png' },
      packageFile: { fileName: packageFileName, sizeBytes: 8, contentType: 'application/zip' }
    }
  });
  expect(preparedResponse.ok()).toBe(true);
  const prepared = (await preparedResponse.json()).data;
  for (const [target, body, contentType] of [
    [prepared.coverUpload, Buffer.from('cover!!'), 'image/png'],
    [prepared.packageUpload, Buffer.from('package!'), 'application/zip']
  ] as const) {
    const upload = await request.put(target.url, {
      data: body,
      headers: { 'content-type': contentType }
    });
    expect(upload.ok()).toBe(true);
  }
  const finalized = await request.post(
    `/api/v1/submissions/${encodeURIComponent(prepared.submissionId)}/finalize`,
    { data: {} }
  );
  expect(finalized.ok()).toBe(true);
  expect((await finalized.json()).data).toEqual({ status: 'manual_review_pending' });
  const repeatedFinalize = await request.post(
    `/api/v1/submissions/${encodeURIComponent(prepared.submissionId)}/finalize`,
    { data: {} }
  );
  expect(repeatedFinalize.ok()).toBe(true);
  expect((await repeatedFinalize.json()).data).toEqual({ status: 'manual_review_pending' });
  const pending = (await adminItems(request, 'manual_review_pending'))
    .find(item => item.id === prepared.submissionId);
  expect(pending?.statusVersion).toBe(1);
  const hiddenStatus = await request.post('/api/v1/submission-status', {
    data: { statusToken: prepared.statusToken }
  });
  expect((await hiddenStatus.json()).data.status).toBe('manual_review_pending');
  return prepared as E2eReceipt;
}

async function adminItems(
  request: APIRequestContext,
  status: string
): Promise<Array<Record<string, unknown>>> {
  const response = await request.get(
    `/api/v1/admin/submissions?status=${status}&limit=100`,
    { headers: { 'x-ai-pet-admin-token': E2E_ADMIN_TOKEN } }
  );
  expect(response.ok()).toBe(true);
  return (await response.json()).data.items;
}

async function applyAdminAction(
  request: APIRequestContext,
  item: Record<string, unknown>,
  action: 'approve' | 'force_publish' | 'reject' | 'move_to_manual' | 'delete' | 'restore',
  reason: string
): Promise<void> {
  const response = await request.post(
    `/api/v1/admin/submissions/${encodeURIComponent(String(item.id))}/actions`,
    {
      headers: { 'x-ai-pet-admin-token': E2E_ADMIN_TOKEN },
      data: {
        action,
        version: item.statusVersion,
        reason,
        idempotencyKey: `e2e-${item.id}-${action}-${item.statusVersion}`,
        ...(action === 'force_publish'
          ? { riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED' }
          : {})
      }
    }
  );
  expect(response.ok(), await response.text()).toBe(true);
}

function createWebsiteServerReadyWait(
  stdout: Readable,
  expectedRunId: string,
  timeoutMs = 10_000
): WebsiteServerReadyWait {
  let output = '';
  let settled = false;
  let timeout: NodeJS.Timeout | null = null;
  let resolveReady!: (serverInfo: WebsiteServerInfo) => void;
  let rejectReady!: (error: Error) => void;

  const cleanup = () => {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
    stdout.off('data', handleData);
  };

  const settleResolved = (serverInfo: WebsiteServerInfo) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveReady(serverInfo);
  };

  const settleRejected = (error: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectReady(error);
  };

  const handleData = (chunk: Buffer) => {
    output += chunk.toString('utf8');
    const readyLine = output
      .split(/\r?\n/u)
      .find((line) => line.startsWith(SERVER_READY_PREFIX));
    if (!readyLine) return;

    try {
      const payload = JSON.parse(
        readyLine.slice(SERVER_READY_PREFIX.length)
      ) as WebsiteServerReadyPayload;
      if (
        payload.runId !== expectedRunId
        || !Number.isInteger(payload.port)
        || payload.port <= 0
        || !payload.url
        || !payload.buildMarker
      ) {
        throw new Error(`服务器就绪信息不完整：${readyLine}`);
      }

      settleResolved({
        url: payload.url,
        runId: payload.runId,
        buildMarker: payload.buildMarker
      });
    } catch (error) {
      settleRejected(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  };

  const promise = new Promise<WebsiteServerInfo>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
    stdout.on('data', handleData);
    timeout = setTimeout(() => {
      settleRejected(new Error(
        `静态网站服务器未在 ${timeoutMs} 毫秒内报告隔离端口，当前输出：${output}`
      ));
    }, timeoutMs);
  });

  return {
    promise,
    cancel: (error = new Error('静态网站服务器就绪等待已取消')) => {
      settleRejected(error);
    }
  };
}

async function verifyWebsiteServerSource(
  serverInfo: WebsiteServerInfo
): Promise<void> {
  const response = await fetch(serverInfo.url);
  const html = await response.text();
  const expectedChapterIds = [...CHAPTER_IDS];
  const missingChapterIds = expectedChapterIds.filter(
    (chapterId) => !html.includes(`data-chapter-id="${chapterId}"`)
  );

  if (
    !response.ok
    || response.headers.get('x-website-test-run-id') !== serverInfo.runId
    || response.headers.get('x-website-build-marker') !== serverInfo.buildMarker
    || !html.includes('data-testid="website-experience"')
    || missingChapterIds.length > 0
  ) {
    throw new Error(
      `静态网站来源校验失败，缺少章节：${missingChapterIds.join(', ') || '无'}`
    );
  }
}

async function stopWebsiteServer(server: ChildProcess): Promise<void> {
  if (!server.pid || server.exitCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    await new Promise<void>((resolveStop) => {
      const killer = spawn(
        'taskkill',
        ['/pid', String(server.pid), '/T', '/F'],
        { stdio: 'ignore' }
      );
      killer.once('exit', () => resolveStop());
      killer.once('error', () => resolveStop());
    });
    return;
  }

  server.kill('SIGTERM');
  await new Promise<void>((resolveStop) => {
    server.once('exit', () => resolveStop());
    setTimeout(resolveStop, 5_000);
  });
}

const test = baseTest.extend<{}, { websiteServerInfo: WebsiteServerInfo }>({
  websiteServerInfo: [async ({}, use, workerInfo) => {
    await mkdir(SCREENSHOT_DIRECTORY, { recursive: true });
    const runId = [
      process.pid,
      workerInfo.workerIndex,
      Date.now()
    ].join('-');
    const server = spawn(process.execPath, [STATIC_SERVER_SCRIPT], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        PORT: '0',
        WEBSITE_TEST_RUN_ID: runId
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stopping = false;
    let stderr = '';
    const handleStderr = (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    };
    server.stderr?.on('data', handleStderr);
    const readyWait = server.stdout
      ? createWebsiteServerReadyWait(server.stdout, runId)
      : null;
    let serverFailureSettled = false;
    let rejectServerFailure!: (error: Error) => void;
    const serverFailure = new Promise<never>((_, rejectFailure) => {
      rejectServerFailure = rejectFailure;
    });
    const failServer = (error: Error) => {
      if (stopping || serverFailureSettled) return;
      serverFailureSettled = true;
      readyWait?.cancel(error);
      rejectServerFailure(error);
    };
    const handleServerError = (error: Error) => {
      failServer(new Error(`静态网站服务器启动失败：${error.message}`));
    };
    const handleServerExit = (
      code: number | null,
      signal: NodeJS.Signals | null
    ) => {
      failServer(new Error(
        `静态网站服务器意外退出：code=${code}, signal=${signal}, stderr=${stderr}`
      ));
    };
    server.once('error', handleServerError);
    server.once('exit', handleServerExit);

    try {
      if (!readyWait) {
        throw new Error('静态网站服务器缺少标准输出管道');
      }
      const serverInfo = await Promise.race([
        readyWait.promise,
        serverFailure
      ]);
      await Promise.race([
        verifyWebsiteServerSource(serverInfo),
        serverFailure
      ]);
      await Promise.race([
        use(serverInfo),
        serverFailure
      ]);
    } finally {
      stopping = true;
      readyWait?.cancel();
      server.off('error', handleServerError);
      server.off('exit', handleServerExit);
      server.stderr?.off('data', handleStderr);
      await stopWebsiteServer(server);
    }
  }, { scope: 'worker' }],
  baseURL: async ({ websiteServerInfo }, use) => {
    await use(websiteServerInfo.url);
  }
});

test.beforeEach(async ({ request }) => {
  const response = await request.post('/__e2e/reset');
  expect(response.ok()).toBe(true);
});

test('官方下载点击仅由管理员工作台显示累计值', async ({ page, request }) => {
  for (let click = 0; click < 2; click += 1) {
    const response = await request.post('/api/v1/official-downloads/windows/click', {
      data: {},
    });
    expect(response.ok()).toBe(true);
    expect((await response.json()).data).toEqual({});
  }

  await enterInteractive(page);
  await expect(page.getByText('官方安装包下载点击')).toHaveCount(0);

  await page.goto('/admin/');
  const metric = page.getByLabel('官方安装包下载点击');
  await expect(metric).toContainText('2');
});

async function enterInteractive(page: Page): Promise<void> {
  await page.goto('/?seed=42');
  await expect(page.locator(HOME)).toHaveAttribute('data-phase', 'interactive');
}

async function enterChapter(page: Page, chapterId: ChapterId): Promise<void> {
  const activeChapter = await page.locator(WEBSITE).getAttribute('data-active-chapter');
  if (activeChapter === 'home') {
    await expect(page.locator(HOME)).toHaveAttribute('data-phase', 'interactive');
  }
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  const targetIndex = CHAPTER_IDS.indexOf(chapterId);
  for (let attempt = 0; attempt < CHAPTER_IDS.length; attempt += 1) {
    const currentId = await page.locator(WEBSITE).getAttribute(
      'data-active-chapter'
    ) as ChapterId | null;
    if (currentId === chapterId) return;

    const currentIndex = currentId ? CHAPTER_IDS.indexOf(currentId) : -1;
    if (currentIndex < 0) {
      throw new Error(`无法识别当前章节：${currentId ?? 'null'}`);
    }

    const direction = targetIndex > currentIndex ? 1 : -1;
    const adjacentId = CHAPTER_IDS[currentIndex + direction];
    if (!adjacentId) {
      throw new Error(`章节 ${currentId} 已到达边界`);
    }

    await page.keyboard.press(direction > 0 ? 'PageDown' : 'PageUp');
    await expect(page.locator(WEBSITE)).toHaveAttribute(
      'data-active-chapter',
      adjacentId
    );
  }

  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    chapterId
  );
}

async function expectInsideViewport(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();

  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

const WINDOW_BUBBLE_EVENT_TYPES = [
  'wheel',
  'pointerdown',
  'pointermove',
  'pointerup',
  'keydown'
] as const;

type WindowBubbleEventType = (typeof WINDOW_BUBBLE_EVENT_TYPES)[number];
type WindowBubbleCounts = Record<WindowBubbleEventType, number>;

async function installWindowBubbleProbe(page: Page): Promise<void> {
  await page.evaluate((eventTypes) => {
    type ProbeEventType = (typeof eventTypes)[number];
    type ProbeWindow = typeof window & {
      __task10WindowBubbleProbe?: {
        counts: Record<ProbeEventType, number>;
        reset: () => void;
      };
    };

    const probeWindow = window as ProbeWindow;
    if (probeWindow.__task10WindowBubbleProbe) {
      throw new Error('Task 10 window 冒泡探针不能重复安装');
    }

    const counts = Object.fromEntries(
      eventTypes.map((eventType) => [eventType, 0])
    ) as Record<ProbeEventType, number>;
    const reset = () => {
      for (const eventType of eventTypes) {
        counts[eventType] = 0;
      }
    };

    probeWindow.__task10WindowBubbleProbe = { counts, reset };
    // 不传 capture 参数，只统计未被局部控件阻止的冒泡事件。
    for (const eventType of eventTypes) {
      window.addEventListener(eventType, () => {
        counts[eventType] += 1;
      });
    }
  }, WINDOW_BUBBLE_EVENT_TYPES);
}

async function resetWindowBubbleProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probeWindow = window as typeof window & {
      __task10WindowBubbleProbe?: {
        reset: () => void;
      };
    };
    const probe = probeWindow.__task10WindowBubbleProbe;
    if (!probe) {
      throw new Error('Task 10 window 冒泡探针尚未安装');
    }
    probe.reset();
  });
}

async function expectNoWindowBubble(
  page: Page,
  eventTypes: readonly WindowBubbleEventType[],
  actionLabel: string
): Promise<void> {
  const counts = await page.evaluate(() => {
    const probeWindow = window as typeof window & {
      __task10WindowBubbleProbe?: {
        counts: WindowBubbleCounts;
      };
    };
    const probe = probeWindow.__task10WindowBubbleProbe;
    if (!probe) {
      throw new Error('Task 10 window 冒泡探针尚未安装');
    }
    return { ...probe.counts };
  });

  for (const eventType of eventTypes) {
    expect.soft(
      counts[eventType],
      `${actionLabel} 的 ${eventType} 不应冒泡到 window`
    ).toBe(0);
  }
}

async function readProgress(page: Page): Promise<number> {
  return Number(await page.locator(HOME).getAttribute('data-progress'));
}

test('法律页面公开披露匿名投稿边界并提供站内投诉入口', async ({ page }) => {
  for (const [path, heading] of [
    ['/legal/privacy.html', '隐私政策'],
    ['/legal/terms.html', '用户协议'],
    ['/legal/content-policy.html', '内容规则']
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    const legalNavigation = page.getByRole('navigation', { name: '法律页面导航' });
    await expect(
      legalNavigation.getByRole('link', { name: '返回首页' })
    ).toHaveAttribute('href', '/');
    await expect(
      legalNavigation.getByRole('link', { name: '反馈与建议' })
    ).toHaveAttribute('href', '/');
    await expect(page.locator('main')).not.toContainText(/ICP备\d+号|已经满足全部实名合规要求/u);
  }
});

test('新共享包直入人工队列并经两步强制发布后在卡片、详情和下载入口披露风险', async ({ page, request }) => {
  const title = 'E2E 管理员人工放行共享包';
  const receipt = await submitSharedPackageViaApi(
    request,
    title,
    'manual-review.zip'
  );
  const pending = (await adminItems(request, 'manual_review_pending'))
    .find(item => item.id === receipt.submissionId)!;
  for (const field of [
    'moderationLeaseUntil',
    'moderationAttempts',
    'moderationNextRetryAt',
    'moderationLastError',
    'moderationAlertedAt'
  ]) {
    expect(pending).not.toHaveProperty(field);
  }
  expect(pending).not.toHaveProperty('packageDownload');
  const pendingDetailResponse = await request.get(
    `/api/v1/admin/submissions/${encodeURIComponent(receipt.submissionId)}`,
    { headers: { 'x-ai-pet-admin-token': E2E_ADMIN_TOKEN } }
  );
  expect(pendingDetailResponse.ok(), await pendingDetailResponse.text()).toBe(true);
  const pendingDetail = (await pendingDetailResponse.json()).data;
  expect(pendingDetail.packageDownload).toMatchObject({
    url: expect.any(String),
    expiresAt: expect.any(String)
  });
  const packageDownload = await request.get(pendingDetail.packageDownload.url);
  expect(packageDownload.status(), await packageDownload.text()).toBe(200);
  expect(packageDownload.headers()['content-type']).toContain('application/zip');
  const actionUrl = `/api/v1/admin/submissions/${encodeURIComponent(receipt.submissionId)}/actions`;
  const ordinaryApprove = await request.post(actionUrl, {
    headers: { 'x-ai-pet-admin-token': E2E_ADMIN_TOKEN },
    data: {
      action: 'approve',
      version: pending.statusVersion,
      reason: '不得绕过技术证据',
      idempotencyKey: `e2e-ordinary-${receipt.submissionId}`
    }
  });
  expect(ordinaryApprove.status()).toBe(409);
  expect((await ordinaryApprove.json()).error.code).toBe('TECHNICAL_SCAN_REQUIRED');

  const overrideRequest = {
    action: 'force_publish',
    version: pending.statusVersion,
    reason: '管理员已接受下载危险文件风险',
    idempotencyKey: `e2e-override-${receipt.submissionId}`,
    riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED'
  };
  const first = await request.post(actionUrl, {
    headers: { 'x-ai-pet-admin-token': E2E_ADMIN_TOKEN },
    data: overrideRequest
  });
  expect(first.ok(), await first.text()).toBe(true);
  const firstResult = (await first.json()).data;
  expect(Object.keys(firstResult.submission).sort()).toEqual([
    'createdAt',
    'id',
    'kind',
    'publicReason',
    'publicationBasis',
    'publishedAt',
    'quarantinedAt',
    'rejectedAt',
    'status',
    'statusVersion',
    'updatedAt'
  ]);
  expect(firstResult).toMatchObject({
    submission: {
      status: 'published',
      statusVersion: Number(pending.statusVersion) + 1,
      publicationBasis: 'admin_override'
    },
    replayed: false
  });

  const replay = await request.post(actionUrl, {
    headers: { 'x-ai-pet-admin-token': E2E_ADMIN_TOKEN },
    data: overrideRequest
  });
  expect(replay.ok()).toBe(true);
  expect((await replay.json()).data).toEqual({ ...firstResult, replayed: true });
  const conflict = await request.post(actionUrl, {
    headers: { 'x-ai-pet-admin-token': E2E_ADMIN_TOKEN },
    data: { ...overrideRequest, reason: '同键异参' }
  });
  expect(conflict.status()).toBe(409);
  expect((await conflict.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');

  const publicList = await request.get('/api/v1/community?limit=100');
  const publicItem = (await publicList.json()).data.items
    .find((item: { id: string }) => item.id === receipt.submissionId);
  expect(publicItem).toEqual(expect.objectContaining({
    id: receipt.submissionId,
    publicationBasis: 'admin_override',
    downloadCount: 0
  }));
  expect(publicItem).not.toHaveProperty('packageDownload');
  const download = await request.post(
    `/api/v1/community/${encodeURIComponent(receipt.submissionId)}/download`,
    { data: { operationId: 'a5e6612a-73ce-4ed9-8930-f8b4ddcb44d8' } }
  );
  expect(download.ok()).toBe(true);
  expect((await download.json()).data).toEqual(expect.objectContaining({
    url: expect.any(String),
    expiresAt: expect.any(String),
    publicationBasis: 'admin_override'
  }));

  await page.goto('/?seed=42');
  await enterChapter(page, 'community');
  const card = page.locator('article').filter({ hasText: title });
  await expect(card.getByRole('note', { name: '共享包风险提示' }))
    .toContainText('管理员人工放行，未通过系统安全验证');
  const detailButton = card.getByRole('button', { name: `打开 ${title} 的详情` });
  await detailButton.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog.getByRole('note', { name: '详情风险提示' }))
    .toContainText('管理员人工放行，未通过系统安全验证');
  await expect(dialog.getByRole('note', { name: '下载风险提示' }))
    .toContainText('管理员人工放行，未通过系统安全验证');

  const invalidFinalize = await request.post(
    `/api/v1/submissions/${encodeURIComponent(receipt.submissionId)}/finalize`,
    { data: {} }
  );
  expect(invalidFinalize.status()).toBe(404);
  expect((await invalidFinalize.json()).error.code).toBe('NOT_FOUND');
});

test('真实管理员页面忽略长按重复 Enter，非重复二次确认与双击各只发送一次', async ({ page, request }) => {
  const firstReceipt = await submitSharedPackageViaApi(
    request,
    'E2E 键盘强制发布',
    'manual-keyboard.zip'
  );
  let actionRequests = 0;
  page.on('request', browserRequest => {
    if (
      browserRequest.method() === 'POST'
      && browserRequest.url().includes(`/admin/submissions/${firstReceipt.submissionId}/actions`)
    ) actionRequests += 1;
  });

  await page.goto('/admin/');
  await page.getByRole('button', { name: /E2E 键盘强制发布/u }).click();
  await page.getByLabel('审核理由').fill('管理员接受键盘确认风险');
  await page.getByRole('button', { name: '强制发布', exact: true }).focus();
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');

  await expect(page.getByRole('alertdialog', { name: '确认强制发布风险' })).toBeVisible();
  expect(actionRequests).toBe(0);
  await expect(page.getByText('该文件未通过安全扫描，发布后用户可能下载危险文件'))
    .toBeFocused();
  expect(await page.getByText('该文件未通过安全扫描，发布后用户可能下载危险文件')
    .evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');

  await page.getByRole('button', { name: '确认强制发布' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => actionRequests).toBe(1);

  const secondReceipt = await submitSharedPackageViaApi(
    request,
    'E2E 双击强制发布',
    'manual-double.zip'
  );
  let doubleClickRequests = 0;
  page.on('request', browserRequest => {
    if (
      browserRequest.method() === 'POST'
      && browserRequest.url().includes(`/admin/submissions/${secondReceipt.submissionId}/actions`)
    ) doubleClickRequests += 1;
  });
  await page.reload();
  await page.getByRole('button', { name: /E2E 双击强制发布/u }).click();
  await page.getByLabel('审核理由').fill('管理员接受双击确认风险');
  await page.getByRole('button', { name: '强制发布', exact: true }).click();
  await page.getByRole('button', { name: '确认强制发布' }).dblclick();
  await expect.poll(() => doubleClickRequests).toBe(1);
});

test('管理员幂等回放返回首次结果快照且拒绝同 key 异参', async ({ request }) => {
  const receipt = await submitFeedbackViaApi(request, 'E2E 管理员幂等回放验证。');
  const pending = (await adminItems(request, 'manual_review_pending'))
    .find(item => item.id === receipt.submissionId)!;
  const approveRequest = {
    action: 'approve',
    version: pending.statusVersion,
    reason: '首次批准',
    idempotencyKey: `e2e-replay-${receipt.submissionId}`
  };
  const actionUrl = `/api/v1/admin/submissions/${encodeURIComponent(receipt.submissionId)}/actions`;
  const first = await request.post(actionUrl, {
    headers: { 'x-ai-pet-admin-token': E2E_ADMIN_TOKEN },
    data: approveRequest
  });
  expect(first.ok()).toBe(true);
  const firstResult = (await first.json()).data;
  expect(firstResult).toMatchObject({
    submission: { status: 'published' },
    replayed: false
  });

  const published = (await adminItems(request, 'published'))
    .find(item => item.id === receipt.submissionId)!;
  await applyAdminAction(request, published, 'delete', '随后隔离');

  const replay = await request.post(actionUrl, {
    headers: { 'x-ai-pet-admin-token': E2E_ADMIN_TOKEN },
    data: approveRequest
  });
  expect(replay.ok()).toBe(true);
  expect((await replay.json()).data).toEqual({
    ...firstResult,
    replayed: true
  });

  const conflict = await request.post(actionUrl, {
    headers: { 'x-ai-pet-admin-token': E2E_ADMIN_TOKEN },
    data: { ...approveRequest, reason: '复用 key 改写理由' }
  });
  expect(conflict.status()).toBe(409);
  expect((await conflict.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');
});

test('管理员幂等键跨投稿全局唯一，严格 Schema 拒绝越界和额外字段', async ({ request }) => {
  const first = await submitFeedbackViaApi(request, 'E2E 全局幂等投稿一。');
  const second = await submitFeedbackViaApi(request, 'E2E 全局幂等投稿二。');
  const firstPending = (await adminItems(request, 'manual_review_pending'))
    .find(item => item.id === first.submissionId)!;
  const secondPending = (await adminItems(request, 'manual_review_pending'))
    .find(item => item.id === second.submissionId)!;
  const sharedKey = 'e2e-global-idempotency-key';
  const firstResponse = await request.post(
    `/api/v1/admin/submissions/${encodeURIComponent(first.submissionId)}/actions`,
    {
      headers: { 'x-ai-pet-admin-token': E2E_ADMIN_TOKEN },
      data: {
        action: 'approve',
        version: firstPending.statusVersion,
        reason: '全局幂等首次请求',
        idempotencyKey: sharedKey
      }
    }
  );
  expect(firstResponse.ok()).toBe(true);
  const crossSubmission = await request.post(
    `/api/v1/admin/submissions/${encodeURIComponent(second.submissionId)}/actions`,
    {
      headers: { 'x-ai-pet-admin-token': E2E_ADMIN_TOKEN },
      data: {
        action: 'approve',
        version: secondPending.statusVersion,
        reason: '全局幂等首次请求',
        idempotencyKey: sharedKey
      }
    }
  );
  expect(crossSubmission.status()).toBe(409);
  expect((await crossSubmission.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');

  for (const [label, mutate] of [
    ['reason', (body: Record<string, unknown>) => ({ ...body, reason: '理'.repeat(501) })],
    ['idempotencyKey', (body: Record<string, unknown>) => ({ ...body, idempotencyKey: 'k'.repeat(129) })],
    ['version', (body: Record<string, unknown>) => ({ ...body, version: 1.5 })],
    ['extra', (body: Record<string, unknown>) => ({ ...body, extra: true })]
  ] as const) {
    const receipt = await submitFeedbackViaApi(request, `E2E Schema ${label}。`);
    const pending = (await adminItems(request, 'manual_review_pending'))
      .find(item => item.id === receipt.submissionId)!;
    const response = await request.post(
      `/api/v1/admin/submissions/${encodeURIComponent(receipt.submissionId)}/actions`,
      {
        headers: { 'x-ai-pet-admin-token': E2E_ADMIN_TOKEN },
        data: mutate({
          action: 'approve',
          version: pending.statusVersion,
          reason: '合法理由',
          idempotencyKey: `e2e-schema-${label}`
        })
      }
    );
    expect(response.status(), label).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_REQUEST');
  }
});

test('反馈恢复保留 standard，共享包恢复回人工并保留风险与审计事实', async ({ request }) => {
  const feedback = await submitFeedbackViaApi(request, 'E2E 恢复已发布反馈。');
  const pendingFeedback = (await adminItems(request, 'manual_review_pending'))
    .find(item => item.id === feedback.submissionId)!;
  await applyAdminAction(request, pendingFeedback, 'approve', '批准反馈');
  const publishedFeedback = (await adminItems(request, 'published'))
    .find(item => item.id === feedback.submissionId)!;
  await applyAdminAction(request, publishedFeedback, 'delete', '隔离反馈');
  const quarantinedFeedback = (await adminItems(request, 'deleted_quarantined'))
    .find(item => item.id === feedback.submissionId)!;
  await applyAdminAction(request, quarantinedFeedback, 'restore', '恢复反馈');
  const restoredFeedback = (await adminItems(request, 'published'))
    .find(item => item.id === feedback.submissionId)!;
  expect(restoredFeedback.publicationBasis).toBe('standard');

  const shared = await submitSharedPackageViaApi(
    request,
    'E2E 精确快照共享包',
    'manual-snapshot.zip'
  );
  const pending = (await adminItems(request, 'manual_review_pending'))
    .find(item => item.id === shared.submissionId)!;
  const response = await request.post(
    `/api/v1/admin/submissions/${encodeURIComponent(shared.submissionId)}/actions`,
    {
      headers: { 'x-ai-pet-admin-token': E2E_ADMIN_TOKEN },
      data: {
        action: 'force_publish',
        version: pending.statusVersion,
        reason: '接受精确快照风险',
        idempotencyKey: `e2e-exact-${shared.submissionId}`,
        riskAcknowledgement: 'ADMIN_OVERRIDE_ACCEPTED'
      }
    }
  );
  expect(response.ok(), await response.text()).toBe(true);
  const result = (await response.json()).data;
  expect(result).toEqual({
    submission: {
      id: shared.submissionId,
      kind: 'shared_package',
      status: 'published',
      statusVersion: Number(pending.statusVersion) + 1,
      publicationBasis: 'admin_override',
      publicReason: null,
      publishedAt: expect.any(String),
      rejectedAt: null,
      quarantinedAt: null,
      createdAt: pending.createdAt,
      updatedAt: expect.any(String)
    },
    replayed: false
  });
  const publishedShared = (await adminItems(request, 'published'))
    .find(item => item.id === shared.submissionId)!;
  await applyAdminAction(request, publishedShared, 'delete', '隔离共享包');
  const quarantinedShared = (await adminItems(request, 'deleted_quarantined'))
    .find(item => item.id === shared.submissionId)!;
  await applyAdminAction(request, quarantinedShared, 'restore', '恢复后人工复核');
  const restoredShared = (await adminItems(request, 'manual_review_pending'))
    .find(item => item.id === shared.submissionId)!;
  expect(restoredShared).toMatchObject({
    publicationBasis: null,
    riskSummary: pending.riskSummary,
    autoRejectionReason: pending.autoRejectionReason
  });
  const restoredDetailResponse = await request.get(
    `/api/v1/admin/submissions/${encodeURIComponent(shared.submissionId)}`,
    { headers: { 'x-ai-pet-admin-token': E2E_ADMIN_TOKEN } }
  );
  expect(restoredDetailResponse.ok(), await restoredDetailResponse.text()).toBe(true);
  const restoredDetail = (await restoredDetailResponse.json()).data;
  expect(restoredDetail.auditLogs.slice(-2)).toEqual([
    expect.objectContaining({
      action: 'delete',
      beforeStatus: 'published',
      afterStatus: 'deleted_quarantined'
    }),
    expect.objectContaining({
      action: 'restore',
      beforeStatus: 'deleted_quarantined',
      afterStatus: 'manual_review_pending'
    })
  ]);
});

test('匿名反馈批准前隐藏且批准后进入真实网页列表', async ({ page, request }) => {
  const content = 'E2E 反馈批准后才允许在 AI Pet 页面公开展示。';
  const receipt = await submitFeedbackViaApi(request, content);
  const hidden = await request.get('/api/v1/feedback?kind=feedback&limit=100');
  expect((await hidden.json()).data.items).not.toContainEqual(
    expect.objectContaining({ id: receipt.submissionId })
  );

  const pending = (await adminItems(request, 'manual_review_pending'))
    .find(item => item.id === receipt.submissionId)!;
  await applyAdminAction(request, pending, 'approve', 'E2E 反馈内容审核通过');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?seed=42');
  await enterChapter(page, 'feedback');
  const feedbackTrigger = page.getByRole('button', { name: '查看用户反馈' });
  await feedbackTrigger.click();
  await feedbackTrigger.click();
  await expect(page.getByRole('dialog', { name: '用户反馈' })).toContainText(content);
});

test('状态令牌只从 Fragment 查询并立即从真实页面地址栏清除', async ({ page, request }) => {
  const receipt = await submitFeedbackViaApi(
    request,
    'E2E 状态 Fragment 查询的 AI Pet 反馈。',
    'suggestion'
  );
  await page.goto(`${receipt.statusPath}#${receipt.statusToken}`);
  await expect(page).toHaveURL(/\/submission-status\/$/u);
  await expect(page.getByRole('status')).toContainText('等待管理员审核');
  expect(await page.content()).not.toContain(receipt.statusToken);
});

test('568x320 投稿编辑器可滚动到底部且所有操作按钮满足触控尺寸', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 568, height: 320 });
  await enterInteractive(page);
  await enterChapter(page, 'feedback');

  const create = page.getByRole('button', { name: '新建投稿' });
  await create.click();
  await create.click();

  const composer = page.getByRole('dialog', { name: '新建投稿' });
  const composerPanel = page.getByTestId('feedback-composer-panel');
  await expect(composer).toBeVisible();
  const panelBounds = await composerPanel.boundingBox();
  expect(panelBounds).not.toBeNull();
  expect(panelBounds!.x).toBeGreaterThanOrEqual(0);
  expect(panelBounds!.y).toBeGreaterThanOrEqual(0);
  expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(568);
  expect(panelBounds!.y + panelBounds!.height).toBeLessThanOrEqual(320);

  const overflowState = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth
  }));
  expect(overflowState.documentWidth).toBeLessThanOrEqual(overflowState.viewportWidth);
  expect(overflowState.bodyWidth).toBeLessThanOrEqual(overflowState.viewportWidth);

  const scrollState = await composerPanel.evaluate((panel) => ({
    clientHeight: panel.clientHeight,
    scrollHeight: panel.scrollHeight,
    scrollTop: panel.scrollTop
  }));
  expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);

  const composerButtonSizes = await composer.locator('button').evaluateAll((buttons) => (
    buttons.map((button) => {
      const bounds = button.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    })
  ));
  expect(composerButtonSizes.length).toBeGreaterThan(0);
  for (const size of composerButtonSizes) {
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
  }

  await composerPanel.hover();
  await page.mouse.wheel(0, 900);
  await expect.poll(() => composerPanel.evaluate((panel) => panel.scrollTop))
    .toBeGreaterThan(0);
  const publish = composer.getByRole('button', { name: '发布投稿' });
  await publish.scrollIntoViewIfNeeded();
  const publishBounds = await publish.boundingBox();
  expect(publishBounds).not.toBeNull();
  expect(publishBounds!.y + publishBounds!.height).toBeLessThanOrEqual(320);

  await composer.getByLabel('正文').fill('这是一条用于验证短屏滚动的投稿内容。');
  await composer.getByRole('button', { name: '取消', exact: true }).click();
  const discardDialog = page.getByRole('dialog', { name: '放弃未发布内容？' });
  await expect(discardDialog).toBeVisible();
  const discardPanel = page.getByTestId('discard-draft-backdrop').locator('[role="dialog"]');
  const discardButtonSizes = await discardDialog.locator('button').evaluateAll((buttons) => (
    buttons.map((button) => {
      const bounds = button.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    })
  ));
  expect(discardButtonSizes).toHaveLength(2);
  for (const size of discardButtonSizes) {
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
  }
  const discardBounds = await discardPanel.boundingBox();
  expect(discardBounds).not.toBeNull();
  expect(discardBounds!.y).toBeGreaterThanOrEqual(0);
  expect(discardBounds!.y + discardBounds!.height).toBeLessThanOrEqual(320);
  expect(runtimeErrors).toEqual([]);
});

test('支付滚筒消费局部滚轮与键盘输入并显示映射正确的真实付款码', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await enterInteractive(page);
  await enterChapter(page, 'feedback');

  const roller = page.locator('[data-testid="payment-roller"]');
  await installWindowBubbleProbe(page);
  await expect(roller).toHaveAttribute('data-active-payment', 'wechat');
  await page.getByRole('button', { name: '打开微信付款码' }).click();
  const wechatDialog = page.getByRole('dialog', { name: '微信付款码' });
  await expect(wechatDialog).toBeVisible();
  const wechatImage = wechatDialog.getByRole('img', { name: '微信付款码' });
  await expect(wechatImage).toHaveAttribute('src', '/WechatPay.jpg');
  await expect.poll(
    () => wechatImage.evaluate((image) => (
      image instanceof HTMLImageElement ? image.naturalWidth : 0
    )),
    { message: '微信付款码应成功解码' }
  ).toBeGreaterThan(0);
  await wechatImage.click();
  await expect(wechatDialog).toBeVisible();
  await wechatDialog.click({ position: { x: 8, y: 8 } });
  await expect(wechatDialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '打开微信付款码' })
  ).toBeFocused();

  await roller.hover();
  await resetWindowBubbleProbe(page);
  await page.mouse.wheel(0, -160);
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'feedback'
  );
  await expect(roller).toHaveAttribute('data-active-payment', 'paypal');
  await expectNoWindowBubble(page, ['wheel'], '支付方式滚轮');

  await roller.focus();
  await expect(roller).toBeFocused();
  await resetWindowBubbleProbe(page);
  await page.keyboard.press('ArrowUp');
  await expect(roller).toHaveAttribute('data-active-payment', 'alipay');
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'feedback'
  );
  await expectNoWindowBubble(page, ['keydown'], '支付方式 ArrowUp');

  await expect(roller).toHaveAttribute('data-active-payment', 'alipay');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const alipayButton = page.getByRole('button', { name: '打开支付宝付款码' });
  await alipayButton.click();
  const alipayDialog = page.getByRole('dialog', { name: '支付宝付款码' });
  const alipayImage = alipayDialog.getByRole('img', { name: '支付宝付款码' });
  await expect(alipayImage).toHaveAttribute('src', '/Alipay.jpg');
  await expect.poll(
    () => alipayImage.evaluate((image) => (
      image instanceof HTMLImageElement ? image.naturalWidth : 0
    )),
    { message: '支付宝付款码应成功解码' }
  ).toBeGreaterThan(0);
  await expect(alipayImage).toHaveCSS('object-fit', 'contain');
  await page.keyboard.press('Escape');
  await expect(alipayDialog).toHaveCount(0);
  await expect(alipayButton).toBeFocused();

  await roller.hover();
  await page.mouse.wheel(0, 160);
  await expect(roller).toHaveAttribute('data-active-payment', 'paypal');
  const paypalButton = page.getByRole('button', { name: '打开PayPal付款码' });
  await paypalButton.click();
  const paypalDialog = page.getByRole('dialog', { name: 'PayPal付款码' });
  const paypalImage = paypalDialog.getByRole('img', { name: 'PayPal付款码' });
  await expect(paypalImage).toHaveAttribute('src', '/Paypal.png');
  await expect.poll(
    () => paypalImage.evaluate((image) => (
      image instanceof HTMLImageElement ? image.naturalWidth : 0
    )),
    { message: 'PayPal 付款码应成功解码' }
  ).toBeGreaterThan(0);
  await expect(paypalImage).toHaveCSS('object-fit', 'contain');
  await page.keyboard.press('Escape');
  await expect(paypalDialog).toHaveCount(0);
  await expect(paypalButton).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

test('付款码弹层隔离翻页、滚轮与触屏章节输入并由 Escape 关闭', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await enterInteractive(page);
  await enterChapter(page, 'feedback');

  await page.getByRole('button', { name: '打开微信付款码' }).click();
  const dialog = page.getByRole('dialog', { name: '微信付款码' });
  await expect(dialog).toHaveAttribute('data-input-scope', 'local');

  await page.keyboard.press('PageUp');
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'feedback'
  );

  await dialog.hover();
  await page.mouse.wheel(0, -800);
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'feedback'
  );

  await dialog.dispatchEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    clientY: 620,
    isPrimary: true,
    pointerId: 71,
    pointerType: 'touch'
  });
  await dialog.dispatchEvent('pointerup', {
    bubbles: true,
    cancelable: true,
    clientY: 120,
    isPrimary: true,
    pointerId: 71,
    pointerType: 'touch'
  });
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'feedback'
  );

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test('付款码资源加载失败时显示稳定回退并保持关闭行为', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.route('**/WechatPay.jpg', (route) => route.abort());
  await enterInteractive(page);
  await enterChapter(page, 'feedback');

  const paymentButton = page.getByRole('button', { name: '打开微信付款码' });
  await paymentButton.click();
  const dialog = page.getByRole('dialog', { name: '微信付款码' });
  await expect(dialog.getByRole('status')).toHaveText('付款码暂未配置');
  await page.getByRole('button', { name: '关闭付款码' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(paymentButton).toBeFocused();
  expect(runtimeErrors).toHaveLength(1);
  expect(runtimeErrors[0]).toContain('Failed to load resource');
});

test('390 付款码弹层保持安全边距并完整显示真实图片', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await enterInteractive(page);
  await enterChapter(page, 'feedback');

  await page.getByRole('button', { name: '打开微信付款码' }).click();
  const dialog = page.getByRole('dialog', { name: '微信付款码' });
  const panel = page.locator('[data-testid="qr-panel"]');
  const image = dialog.getByRole('img', { name: '微信付款码' });
  await expect(dialog).toBeVisible();
  await expect(image).toHaveAttribute('src', '/WechatPay.jpg');
  await expect.poll(
    () => image.evaluate((node) => (
      node instanceof HTMLImageElement ? node.naturalWidth : 0
    )),
    { message: '移动端付款码应成功解码' }
  ).toBeGreaterThan(0);
  await expect(image).toHaveCSS('object-fit', 'contain');
  await expectInsideViewport(page, panel);
  await expectInsideViewport(page, image);

  const imageEvidence = await image.evaluate((node) => {
    if (!(node instanceof HTMLImageElement) || !node.parentElement) {
      throw new Error('付款码图片结构不完整');
    }
    const imageBounds = node.getBoundingClientRect();
    const mediaBounds = node.parentElement.getBoundingClientRect();
    return {
      imageBottom: imageBounds.bottom,
      imageLeft: imageBounds.left,
      imageRight: imageBounds.right,
      imageTop: imageBounds.top,
      mediaBottom: mediaBounds.bottom,
      mediaLeft: mediaBounds.left,
      mediaRight: mediaBounds.right,
      mediaTop: mediaBounds.top,
      naturalHeight: node.naturalHeight,
      naturalWidth: node.naturalWidth
    };
  });
  expect(imageEvidence.naturalWidth).toBeGreaterThan(0);
  expect(imageEvidence.naturalHeight).toBeGreaterThan(0);
  expect(imageEvidence.imageLeft).toBeGreaterThanOrEqual(imageEvidence.mediaLeft);
  expect(imageEvidence.imageTop).toBeGreaterThanOrEqual(imageEvidence.mediaTop);
  expect(imageEvidence.imageRight).toBeLessThanOrEqual(imageEvidence.mediaRight);
  expect(imageEvidence.imageBottom).toBeLessThanOrEqual(imageEvidence.mediaBottom);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await page.screenshot({
    path: resolve(SCREENSHOT_DIRECTORY, 'support-dialog-390.png')
  });

  await page.getByRole('button', { name: '关闭付款码' }).click();
  await expect(dialog).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test('390 离开再返回首页后液态画布缓冲区保持可用', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?seed=42');

  const canvas = page.locator(`${LIQUID_HOME} canvas`);
  await expect(canvas).toBeVisible();
  const initialBuffer = await canvas.evaluate((element) => ({
    width: element instanceof HTMLCanvasElement ? element.width : 0,
    height: element instanceof HTMLCanvasElement ? element.height : 0
  }));
  expect(initialBuffer.width).toBeGreaterThan(0);
  expect(initialBuffer.height).toBeGreaterThan(0);

  await page.getByRole('button', { name: '下一章节' }).click();
  await expect(page.locator(WEBSITE)).toHaveAttribute('data-active-chapter', 'about');
  await page.getByRole('button', { name: '上一章节' }).click();
  await expect(page.locator(WEBSITE)).toHaveAttribute('data-active-chapter', 'home');
  await expect(page.locator(LIQUID_HOME)).toHaveAttribute('data-active', 'true');
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((element) => ({
    width: element instanceof HTMLCanvasElement ? element.width : 0,
    height: element instanceof HTMLCanvasElement ? element.height : 0
  }))).toEqual(initialBuffer);
  expect(runtimeErrors).toEqual([]);
});

test('390 宽度液态玻璃首页无横向溢出', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await enterInteractive(page);

  const viewportWidths = await page.locator(HOME).evaluate((home) => ({
    client: home.clientWidth,
    scroll: home.scrollWidth
  }));
  expect(viewportWidths.scroll).toBeLessThanOrEqual(viewportWidths.client);
  await expect(page.locator(LIQUID_HOME)).toHaveAttribute('data-active', 'true');
  await expect(page.locator(LIQUID_HOME).locator('canvas')).toBeVisible();
  await expect(page.locator(SWARM)).toHaveCount(0);

  const scrollEvidence = await page.locator(WEBSITE).evaluate((experience) => {
    const home = experience.querySelector<HTMLElement>(
      '[data-testid="home-experience"]'
    );
    if (!home) throw new Error('缺少首页章节');

    return {
      experienceOverflowY: getComputedStyle(experience).overflowY,
      homeOverflowY: getComputedStyle(home).overflowY,
      position: getComputedStyle(experience).position,
      scrollY: window.scrollY
    };
  });
  expect(scrollEvidence.experienceOverflowY).toBe('hidden');
  expect(scrollEvidence.homeOverflowY).toBe('hidden');
  expect(scrollEvidence.position).toBe('fixed');
  expect(scrollEvidence.scrollY).toBe(0);

  await page.screenshot({
    path: resolve(SCREENSHOT_DIRECTORY, 'narrow-390-fallback.png')
  });
  expect(runtimeErrors).toEqual([]);
});

test('760/761 断点提供移动章节导航且五章节不横向溢出', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto('/?seed=42');

  const experience = page.locator('[data-testid="website-experience"]');
  const chapterNavigation = page.getByRole('navigation', { name: '章节导航' });
  const previous = page.getByRole('button', { name: '上一章节' });
  const next = page.getByRole('button', { name: '下一章节' });

  await expect(experience).toHaveAttribute('data-reduced-motion', 'true');
  await expect(chapterNavigation).toBeVisible();
  await expect(previous).toBeDisabled();

  for (const control of [previous, next]) {
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
  }

  for (const chapterId of CHAPTER_IDS) {
    await expect(experience).toHaveAttribute('data-active-chapter', chapterId);
    const activeSection = page.locator(`[data-chapter-id="${chapterId}"]`);
    await expect(activeSection).toHaveAttribute('data-interactive', 'true');

    const widths = await activeSection.evaluate((section) => ({
      client: section.clientWidth,
      scroll: section.scrollWidth
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);

    if (chapterId !== 'feedback') {
      await next.click();
    }
  }

  await expect(next).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(760);

  await page.setViewportSize({ width: 761, height: 900 });
  await expect(chapterNavigation).toBeHidden();
  expect(runtimeErrors).toEqual([]);
});

test('568x320 五章节主内容避让移动导航且保持完整可见', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 568, height: 320 });
  await page.goto('/?seed=42');

  const experience = page.locator('[data-testid="website-experience"]');
  const navigation = page.getByRole('navigation', { name: '章节导航' });
  const next = page.getByRole('button', { name: '下一章节' });
  const primaryByChapter = new Map([
    [
      'home',
      page.locator(LIQUID_HOME)
    ],
    ['about', page.locator('[data-glass-id="editor"]')],
    ['download', page.getByRole('group', { name: '选择下载平台' })],
    ['community', page.getByRole('button', { name: '分享您的 AI Pet' })],
    ['feedback', page.getByRole('group', { name: '选择付款方式' })]
  ]);

  await expect(navigation).toBeVisible();
  const navigationBounds = await navigation.boundingBox();
  expect(navigationBounds).not.toBeNull();

  for (const chapterId of primaryByChapter.keys()) {
    await expect(experience).toHaveAttribute('data-active-chapter', chapterId);
    const primary = primaryByChapter.get(chapterId)!;
    await expect(primary).toBeVisible();

    const primaryBounds = await primary.boundingBox();
    expect(primaryBounds).not.toBeNull();
    expect(primaryBounds!.x, `${chapterId} 左边界`).toBeGreaterThanOrEqual(-1);
    expect(primaryBounds!.y, `${chapterId} 上边界`).toBeGreaterThanOrEqual(-1);
    expect(primaryBounds!.x + primaryBounds!.width, `${chapterId} 右边界`)
      .toBeLessThanOrEqual(569);
    expect(primaryBounds!.y + primaryBounds!.height, `${chapterId} 下边界`)
      .toBeLessThanOrEqual(321);
    if (chapterId !== 'home') {
      const overlapsNavigation = !(
        primaryBounds!.x + primaryBounds!.width <= navigationBounds!.x
        || navigationBounds!.x + navigationBounds!.width <= primaryBounds!.x
        || primaryBounds!.y + primaryBounds!.height <= navigationBounds!.y
        || navigationBounds!.y + navigationBounds!.height <= primaryBounds!.y
      );
      expect(overlapsNavigation, `${chapterId} 主内容不应被章节导航遮挡`)
        .toBe(false);
    }

    if (chapterId !== 'feedback') {
      await next.click();
    }
  }

  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(568);
  expect(runtimeErrors).toEqual([]);
});

test('减少动态效果直接进入稳定首页', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?seed=42');

  await expect(page.locator(HOME)).toHaveAttribute('data-phase', 'interactive');
  await expect(page.locator(LIQUID_HOME)).toHaveAttribute('data-active', 'true');
  await expect(page.locator(LIQUID_HOME).locator('canvas')).toBeAttached();
  await expect(page.locator(SWARM)).toHaveCount(0);
  await expect(page.locator('[data-testid="brand-stage"]')).toHaveCount(0);
  await page.mouse.wheel(0, 360);
  await expect(page.locator(WEBSITE)).toHaveAttribute('data-active-chapter', 'about');
  expect(runtimeErrors).toEqual([]);
});
