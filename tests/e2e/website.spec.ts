import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { expect, test as baseTest } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const REPOSITORY_ROOT = resolve(__dirname, '..', '..');
const STATIC_SERVER_SCRIPT = resolve(REPOSITORY_ROOT, 'tests/serve-website-export.mjs');
const SERVER_READY_PREFIX = 'WEBSITE_SERVER_READY ';
const WEBSITE = '[data-testid="website-experience"]';
const HOME = '[data-testid="home-experience"]';
const ICON = '[data-testid="file-icon"]';
const PREVIEW = '[data-testid="file-preview"]';
const SWARM = '[data-active-count]';
const CANVAS = '[data-testid="cursor-field"]';
const BRAND = '[data-testid="brand-stage"]';
const DONATION = '[data-testid="donation-chapter"]';
const SCREENSHOT_DIRECTORY = resolve(
  REPOSITORY_ROOT,
  'tests/.playwright-output/website/screenshots'
);
const FILE_ASSET_PATHS = new Set([
  '/TxtIcon.png',
  '/PDFIcon.png',
  '/PPTIcon.png',
  '/XLSIcon.png',
  '/IMGIcon.png',
  '/empty.png',
  '/Noempty.png'
]);
const CHAPTER_IDS = [
  'home',
  'about',
  'download',
  'feedback',
  'donation'
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
  const expectedChapterIds = ['home', 'about', 'download', 'feedback', 'donation'];
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

test('服务器就绪等待在成功、超时和取消路径统一清理资源', async () => {
  const successOutput = new PassThrough();
  const successWait = createWebsiteServerReadyWait(
    successOutput,
    'success-run',
    1_000
  );
  successOutput.write(`${SERVER_READY_PREFIX}${JSON.stringify({
    url: 'http://127.0.0.1:43125',
    port: 43125,
    runId: 'success-run',
    buildMarker: 'success-build'
  })}\n`);
  await expect(successWait.promise).resolves.toEqual({
    url: 'http://127.0.0.1:43125',
    runId: 'success-run',
    buildMarker: 'success-build'
  });
  expect(successOutput.listenerCount('data')).toBe(0);
  successWait.cancel(new Error('成功后重复取消'));
  await expect(successWait.promise).resolves.toMatchObject({
    runId: 'success-run'
  });

  const timeoutOutput = new PassThrough();
  const timeoutWait = createWebsiteServerReadyWait(
    timeoutOutput,
    'timeout-run',
    10
  );
  await expect(timeoutWait.promise).rejects.toThrow('10 毫秒');
  expect(timeoutOutput.listenerCount('data')).toBe(0);

  const cancelledOutput = new PassThrough();
  const cancelledWait = createWebsiteServerReadyWait(
    cancelledOutput,
    'cancelled-run',
    10_000
  );
  expect(cancelledOutput.listenerCount('data')).toBe(1);
  const cancelledAt = Date.now();
  cancelledWait.cancel(new Error('模拟服务器提前退出'));
  cancelledWait.cancel(new Error('重复取消不应再次 settle'));
  await expect(cancelledWait.promise).rejects.toThrow('模拟服务器提前退出');
  expect(cancelledOutput.listenerCount('data')).toBe(0);
  expect(Date.now() - cancelledAt).toBeLessThan(500);
});

async function enterInteractive(page: Page): Promise<void> {
  await page.goto('/?seed=42');
  await expect(page.locator(HOME)).toHaveAttribute('data-phase', /drawing|settling|interactive/);
  await page.mouse.click(12, 12);
  await expect(page.locator(HOME)).toHaveAttribute('data-phase', 'interactive');
}

async function enterChapter(page: Page, chapterId: ChapterId): Promise<void> {
  await expect(page.locator(HOME)).toHaveAttribute('data-phase', 'interactive');
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

async function waitForFile(page: Page): Promise<Locator> {
  await expect.poll(
    () => page.locator(ICON).count(),
    { timeout: 6_000, message: '开场跳过后应生成至少一个文件粒子' }
  ).toBeGreaterThan(0);
  return page.locator(ICON).first();
}

function getBrandHeading(page: Page): Locator {
  return page.locator(BRAND).getByRole('heading', {
    name: 'AI Pet',
    exact: true
  });
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

async function expectNoOverlap(
  first: Locator,
  second: Locator,
  message: string
): Promise<void> {
  const firstBox = await first.boundingBox();
  const secondBox = await second.boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();

  const overlapWidth = Math.max(
    0,
    Math.min(firstBox!.x + firstBox!.width, secondBox!.x + secondBox!.width)
    - Math.max(firstBox!.x, secondBox!.x)
  );
  const overlapHeight = Math.max(
    0,
    Math.min(firstBox!.y + firstBox!.height, secondBox!.y + secondBox!.height)
    - Math.max(firstBox!.y, secondBox!.y)
  );
  expect(
    overlapWidth * overlapHeight,
    `${message}；第一项=${JSON.stringify(firstBox)}；第二项=${JSON.stringify(secondBox)}`
  ).toBe(0);
}

async function expectActiveChapterLayout(
  page: Page,
  chapterId: ChapterId
): Promise<void> {
  const evidence = await page.locator(
    `[data-chapter-id="${chapterId}"]`
  ).evaluate((section) => {
    const navigation = document.querySelector<HTMLElement>(
      'nav[aria-label="章节导航"]'
    );
    const navigationRect = navigation?.checkVisibility({
      checkOpacity: true,
      checkVisibilityCSS: true
    })
      ? navigation.getBoundingClientRect()
      : null;
    const candidates = Array.from(section.querySelectorAll<HTMLElement>(
      [
        'h1',
        'h2',
        'h3',
        'p',
        'button',
        'a',
        'code',
        '[data-platform-id]',
        '[data-payment-id]'
      ].join(',')
    ));
    const outsideViewport: string[] = [];
    const overflowingText: string[] = [];
    const navigationOverlaps: string[] = [];

    for (const element of candidates) {
      if (
        element.closest('[aria-hidden="true"], [inert]')
        || !element.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true
        })
      ) {
        continue;
      }

      const bounds = element.getBoundingClientRect();
      const label = [
        element.tagName.toLowerCase(),
        element.getAttribute('data-platform-id'),
        element.getAttribute('data-payment-id'),
        element.getAttribute('aria-label'),
        element.textContent?.trim().slice(0, 32)
      ].filter(Boolean).join(':');
      if (
        bounds.left < -1
        || bounds.top < -1
        || bounds.right > window.innerWidth + 1
        || bounds.bottom > window.innerHeight + 1
      ) {
        outsideViewport.push(
          `${label}:${Math.round(bounds.left)},${Math.round(bounds.top)}`
          + `-${Math.round(bounds.right)},${Math.round(bounds.bottom)}`
          + `/${window.innerWidth}x${window.innerHeight}`
        );
      }

      const style = getComputedStyle(element);
      const clipsVertically = !['visible', 'unset'].includes(style.overflowY);
      if (
        ['H1', 'H2', 'H3', 'P', 'A', 'CODE'].includes(element.tagName)
        && (
          element.scrollWidth > element.clientWidth + 1
          || (
            clipsVertically
            && element.scrollHeight > element.clientHeight + 1
          )
        )
      ) {
        overflowingText.push(
          `${label}:${element.clientWidth}x${element.clientHeight}`
          + `/${element.scrollWidth}x${element.scrollHeight}`
        );
      }

      if (
        navigationRect
        && navigation
        && !navigation.contains(element)
        && bounds.left < navigationRect.right
        && bounds.right > navigationRect.left
        && bounds.top < navigationRect.bottom
        && bounds.bottom > navigationRect.top
      ) {
        navigationOverlaps.push(label);
      }
    }

    return {
      bodyWidth: document.body.scrollWidth,
      documentWidth: document.documentElement.scrollWidth,
      navigationOverlaps,
      outsideViewport,
      overflowingText,
      sectionWidth: section.scrollWidth,
      viewportWidth: window.innerWidth
    };
  });

  expect(
    evidence.documentWidth,
    `${chapterId} 文档不应横向溢出`
  ).toBeLessThanOrEqual(evidence.viewportWidth);
  expect(
    evidence.bodyWidth,
    `${chapterId} 页面主体不应横向溢出`
  ).toBeLessThanOrEqual(evidence.viewportWidth);
  expect(
    evidence.sectionWidth,
    `${chapterId} 章节不应横向溢出`
  ).toBeLessThanOrEqual(evidence.viewportWidth);
  expect(
    evidence.outsideViewport,
    `${chapterId} 可见内容应完整位于视口内`
  ).toEqual([]);
  expect(
    evidence.overflowingText,
    `${chapterId} 可见文本不应被自身容器裁切`
  ).toEqual([]);
  expect(
    evidence.navigationOverlaps,
    `${chapterId} 可见内容不应被章节导航遮挡`
  ).toEqual([]);
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

interface IntroCrossfadeSample {
  captured: boolean;
  logoOpacity: number;
  visiblePieceCount: number;
  visiblePieceFilters: string[];
  pieceSources: Array<string | null>;
}

/**
 * 逐帧采样开场图层，确保完整 Logo 与至少一个磁吸切片在 drawing 阶段同时可见。
 */
async function sampleIntroCrossfade(
  page: Page,
  timeoutMs = 2_800
): Promise<IntroCrossfadeSample> {
  return page.evaluate((timeout) => new Promise<IntroCrossfadeSample>((resolveSample) => {
    const startedAt = performance.now();

    const sampleFrame = () => {
      const home = document.querySelector<HTMLElement>('[data-testid="home-experience"]');
      const logo = document.querySelector<HTMLElement>('[data-testid="brand-logo"]');
      const pieces = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="magnetic-logo-piece"]')
      );
      const logoOpacity = logo ? Number(getComputedStyle(logo).opacity) : 0;
      const visiblePieces = pieces.filter(
        (piece) => Number(getComputedStyle(piece).opacity) > 0
      );
      const captured = home?.getAttribute('data-phase') === 'drawing'
        && logoOpacity > 0
        && logoOpacity < 1
        && visiblePieces.length > 0;
      const result = {
        captured,
        logoOpacity,
        visiblePieceCount: visiblePieces.length,
        visiblePieceFilters: visiblePieces.map(
          (piece) => getComputedStyle(piece).filter
        ),
        pieceSources: pieces.map((piece) => piece.getAttribute('src'))
      };

      if (captured || performance.now() - startedAt >= timeout) {
        resolveSample(result);
        return;
      }

      requestAnimationFrame(sampleFrame);
    };

    requestAnimationFrame(sampleFrame);
  }), timeoutMs);
}

async function readProgress(page: Page): Promise<number> {
  return Number(await page.locator(HOME).getAttribute('data-progress'));
}

async function countCanvasAlphaPixels(canvas: Locator): Promise<number> {
  return canvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) {
      throw new Error('光标场不是 Canvas 元素');
    }

    const context = element.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('无法读取 Canvas 2D 像素');
    }
    if (element.width === 0 || element.height === 0) {
      return 0;
    }

    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let alphaPixelCount = 0;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] !== 0) {
        alphaPixelCount += 1;
      }
    }
    return alphaPixelCount;
  });
}

interface CanvasColorEvidence {
  alphaPixels: number;
  balancedPixels: number;
  yellowPixels: number;
}

async function readCanvasColorEvidence(
  canvas: Locator
): Promise<CanvasColorEvidence> {
  return canvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) {
      throw new Error('光标场不是 Canvas 元素');
    }

    const context = element.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('无法读取 Canvas 2D 像素');
    }
    if (element.width === 0 || element.height === 0) {
      return { alphaPixels: 0, balancedPixels: 0, yellowPixels: 0 };
    }

    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let alphaPixels = 0;
    let balancedPixels = 0;
    let yellowPixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 16) {
      const red = pixels[offset] ?? 0;
      const green = pixels[offset + 1] ?? 0;
      const blue = pixels[offset + 2] ?? 0;
      const alpha = pixels[offset + 3] ?? 0;
      if (alpha === 0) continue;

      alphaPixels += 1;
      if (Math.max(red, green, blue) - Math.min(red, green, blue) <= 8) {
        balancedPixels += 1;
      }
      if (red > blue + 40 && green > blue + 40) {
        yellowPixels += 1;
      }
    }

    return { alphaPixels, balancedPixels, yellowPixels };
  });
}

test('五章节按确认顺序注册且两个占位章节具有明确状态', async ({ page }) => {
  await page.goto('/?seed=42');
  const sections = page.locator('[data-chapter-id]');

  await expect(sections).toHaveCount(5);
  expect(await sections.evaluateAll((nodes) => nodes.map(
    (node) => node.getAttribute('data-chapter-id')
  ))).toEqual(CHAPTER_IDS);
  await expect(page.locator('[data-chapter-id="home"]')).toHaveAttribute(
    'aria-hidden',
    'false'
  );

  for (const chapterId of CHAPTER_IDS.slice(1)) {
    const chapter = page.locator(`[data-chapter-id="${chapterId}"]`);
    await expect(chapter).toHaveAttribute('inert', '');
    await expect(chapter).toHaveAttribute('data-interactive', 'false');
  }

  await expect(
    page.locator('[data-chapter-id="about"]').getByRole('heading', {
      name: 'AI Pet',
      exact: true
    })
  ).toBeAttached();
  await expect(
    page.locator('[data-chapter-id="feedback"] h2')
  ).toHaveText('倾听你的声音，打造属于你的 Pet');
  await expect(page.locator('[data-testid="about-chapter"]')).toBeAttached();
  await expect(page.locator('[data-testid="feedback-chapter"]')).toBeAttached();
});

test('介绍章节桌面悬停与键盘预览不被鼠标点击锁定', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await enterInteractive(page);
  await enterChapter(page, 'about');

  const about = page.locator('[data-testid="about-chapter"]');
  const security = page.locator('[data-about-feature="security"]');
  const safeZone = page.locator('[data-about-safe-zone]');
  const title = page.locator('[data-about-title] [data-testid="pointer-tilt-text"]');

  await expect(about.locator('[data-about-feature]')).toHaveCount(5);
  await security.hover();
  await expect(about).toHaveAttribute('data-active-feature', 'security');
  await expect(page.getByRole('tooltip')).toBeVisible();

  await security.click();
  const safeBounds = await safeZone.boundingBox();
  expect(safeBounds).not.toBeNull();
  await page.mouse.move(
    safeBounds!.x + safeBounds!.width / 2,
    safeBounds!.y + safeBounds!.height / 2
  );
  await expect(about).toHaveAttribute('data-active-feature', 'none');

  const initialTilt = await title.evaluate((element) => (
    getComputedStyle(element).getPropertyValue('--pointer-tilt-rotate-y')
  ));
  await page.mouse.move(safeBounds!.x + safeBounds!.width * 0.78, safeBounds!.y + 20);
  await expect.poll(() => title.evaluate((element) => (
    getComputedStyle(element).getPropertyValue('--pointer-tilt-rotate-y')
  ))).not.toBe(initialTilt);

  await security.focus();
  await expect(about).toHaveAttribute('data-active-feature', 'security');
  await expect(security).toHaveAttribute(
    'aria-describedby',
    'about-feature-preview-security'
  );
  expect(runtimeErrors).toEqual([]);
});

test('568x320 介绍章节紧凑布局可读且移动空白点击解除锁定', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 568, height: 320 });
  await enterInteractive(page);
  await enterChapter(page, 'about');

  const about = page.locator('[data-testid="about-chapter"]');
  const panels = about.locator('[data-about-feature]');
  await expect(about).toHaveAttribute('data-layout', 'compact-landscape');
  await expect(about).toHaveAttribute('data-entrance-state', 'visible');
  await expect(panels).toHaveCount(5);
  expect(await panels.evaluateAll((nodes) => nodes.every((node) => {
    const element = node as HTMLElement;
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0
      && bounds.top >= 0
      && bounds.right <= window.innerWidth
      && bounds.bottom <= window.innerHeight
      && element.scrollWidth <= element.clientWidth + 1
      && element.scrollHeight <= element.clientHeight + 1;
  }))).toBe(true);

  await page.locator('[data-about-feature="text-editor"]').click();
  await expect(about).toHaveAttribute('data-active-feature', 'text-editor');
  await page.locator('[data-about-safe-zone]').click();
  await expect(about).toHaveAttribute('data-active-feature', 'none');
  expect(runtimeErrors).toEqual([]);
});

test('反馈章节展示排序列表并支持点赞、取消与建议滚筒', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await enterInteractive(page);
  await enterChapter(page, 'feedback');

  const roller = page.getByRole('group', { name: '选择反馈操作' });
  await expect(roller).toHaveAttribute('data-active-action', 'feedback');
  await page.getByRole('button', { name: '查看用户反馈' }).click();

  const feedbackDialog = page.getByRole('dialog', { name: '用户反馈' });
  await expect(feedbackDialog).toBeVisible();
  const rows = feedbackDialog.locator('[data-testid="feedback-row"]');
  await expect(rows).toHaveCount(6);
  await expect(rows.first()).toContainText('林间用户');

  const like = feedbackDialog.getByRole('button', {
    name: '点赞林间用户的反馈'
  });
  await expect(like).toHaveAttribute('aria-pressed', 'false');
  await expect(like).toContainText('28');
  await like.click();
  await expect(like).toHaveAttribute('aria-pressed', 'true');
  await expect(like).toContainText('29');
  await like.click();
  await expect(like).toHaveAttribute('aria-pressed', 'false');
  await expect(like).toContainText('28');

  await page.getByRole('button', { name: '关闭用户反馈' }).click();
  await expect(feedbackDialog).toHaveCount(0);
  await roller.hover();
  await page.mouse.wheel(0, 160);
  await expect(roller).toHaveAttribute('data-active-action', 'suggestion');
  await page.getByRole('button', { name: '查看更新建议' }).click();
  const suggestionDialog = page.getByRole('dialog', { name: '更新建议' });
  await expect(suggestionDialog).toBeVisible();
  await expect(suggestionDialog.locator('[data-testid="feedback-row"]').first())
    .toContainText('柏舟');
  expect(runtimeErrors).toEqual([]);
});

test('反馈投稿可持久化，放弃草稿需确认并恢复入口焦点', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.goto('/?seed=42');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await page.setViewportSize({ width: 1440, height: 900 });
  await enterInteractive(page);
  await enterChapter(page, 'feedback');

  const roller = page.getByRole('group', { name: '选择反馈操作' });
  await page.getByRole('button', { name: '选择新建投稿' }).click();
  const create = page.getByRole('button', { name: '新建投稿' });
  await create.click();
  await page.getByLabel('昵称（可选）').fill('持久化用户');
  await page.getByLabel('正文').fill('这是一条需要在刷新后继续显示的投稿内容。');
  await page.getByRole('button', { name: '发布投稿' }).click();
  const feedbackDialog = page.getByRole('dialog', { name: '用户反馈' });
  await expect(feedbackDialog).toContainText('持久化用户');

  await page.reload();
  await enterInteractive(page);
  await enterChapter(page, 'feedback');
  await page.getByRole('button', { name: '查看用户反馈' }).click();
  await expect(page.getByRole('dialog', { name: '用户反馈' })).toContainText('持久化用户');
  await page.getByRole('button', { name: '关闭用户反馈' }).click();

  await roller.hover();
  await page.mouse.wheel(0, 160);
  await expect(roller).toHaveAttribute('data-active-action', 'suggestion');
  await page.getByRole('button', { name: '选择新建投稿' }).click();
  await expect(roller).toHaveAttribute('data-active-action', 'create');
  await create.click();
  await page.getByLabel('正文').fill('这是一条应该由放弃确认保护的草稿内容。');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  const discardDialog = page.getByRole('dialog', { name: '放弃未发布内容？' });
  await expect(discardDialog).toBeVisible();
  await page.getByTestId('discard-draft-backdrop').click({ position: { x: 4, y: 4 } });
  await expect(discardDialog).toBeVisible();
  await page.getByRole('button', { name: '继续编辑' }).click();
  await expect(page.getByRole('dialog', { name: '新建投稿' })).toBeVisible();
  await expect(page.getByLabel('正文')).toHaveValue(
    '这是一条应该由放弃确认保护的草稿内容。'
  );
  await expect(page.getByLabel('正文')).toBeFocused();
  await page.getByRole('button', { name: '取消投稿' }).click();
  await expect(discardDialog).toBeVisible();
  await page.getByRole('button', { name: '确认放弃' }).click();
  await expect(discardDialog).toHaveCount(0);
  await expect(create).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

test('568x320 投稿编辑器可滚动到底部且所有操作按钮满足触控尺寸', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 568, height: 320 });
  await enterInteractive(page);
  await enterChapter(page, 'feedback');

  await page.getByRole('button', { name: '选择新建投稿' }).click();
  await page.getByRole('button', { name: '新建投稿' }).click();

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

test('逐章节推拉且快速输入不能跳过占位章节', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await enterInteractive(page);

  await page.mouse.wheel(0, 360);
  await expect.poll(async () => page.locator(WEBSITE).evaluate((experience) => {
    const home = experience.querySelector<HTMLElement>(
      '[data-chapter-id="home"]'
    );
    const about = experience.querySelector<HTMLElement>(
      '[data-chapter-id="about"]'
    );
    if (!home || !about) return false;

    const homeStyle = getComputedStyle(home);
    const aboutStyle = getComputedStyle(about);
    const homeOpacity = Number(homeStyle.opacity);
    const aboutOpacity = Number(aboutStyle.opacity);
    return homeOpacity > 0
      && homeOpacity < 1
      && aboutOpacity > 0
      && aboutOpacity < 1
      && homeStyle.transform !== 'none'
      && aboutStyle.transform !== 'none';
  }), {
    message: '首页与介绍章节应出现缩放渐隐交接帧'
  }).toBe(true);
  await page.screenshot({
    path: resolve(SCREENSHOT_DIRECTORY, 'chapter-transition-1440.png')
  });
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'home'
  );

  await page.mouse.wheel(0, 5_000);
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'about'
  );

  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press('PageDown');
  }
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'download'
  );
  await page.keyboard.press('PageUp');
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'about'
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(runtimeErrors).toEqual([]);
});

test('普通鼠标滚轮按真实刻度突发累积并在结束后进入介绍章', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await enterInteractive(page);
  await page.mouse.move(720, 450);

  for (let index = 0; index < 4; index += 1) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(70);
  }

  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'about'
  );
  expect(runtimeErrors).toEqual([]);
});

test('多指触屏不会覆盖首个章节拖动手势', async ({ page }) => {
  await enterInteractive(page);

  await page.evaluate(() => {
    const dispatchPointer = (
      type: 'pointerdown' | 'pointerup',
      pointerId: number,
      clientY: number,
      isPrimary: boolean
    ) => {
      document.body.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientY,
        isPrimary,
        pointerId,
        pointerType: 'touch'
      }));
    };

    dispatchPointer('pointerdown', 41, 650, true);
    dispatchPointer('pointerdown', 42, 500, false);
    dispatchPointer('pointerup', 42, 500, false);
    dispatchPointer('pointerup', 41, 100, true);
  });

  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'about'
  );
});

test('暂停期间结束的触屏不会锁死后续章节手势', async ({ page }) => {
  await enterInteractive(page);

  await page.evaluate(() => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientY: 640,
      isPrimary: true,
      pointerId: 43,
      pointerType: 'touch'
    }));
    window.dispatchEvent(new Event('blur'));
    document.body.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      clientY: 120,
      isPrimary: true,
      pointerId: 43,
      pointerType: 'touch'
    }));
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.locator(SWARM)).toHaveAttribute('data-paused', 'false');

  await page.evaluate(() => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientY: 640,
      isPrimary: true,
      pointerId: 44,
      pointerType: 'touch'
    }));
    document.body.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      clientY: 120,
      isPrimary: true,
      pointerId: 44,
      pointerType: 'touch'
    }));
  });

  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'about'
  );
});

test('下载平台滚筒消费局部滚轮和触屏拖动并保留当前章节', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await enterInteractive(page);
  await enterChapter(page, 'download');

  const stack = page.locator('[data-testid="download-platform-stack"]');
  await installWindowBubbleProbe(page);
  await expect(stack).toHaveAttribute('data-active-platform', 'windows-x64');
  await stack.hover();
  await resetWindowBubbleProbe(page);
  await page.mouse.wheel(0, 160);
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'download'
  );
  await expect(stack).toHaveAttribute('data-active-platform', 'macos');
  await expect(page.getByRole('button', { name: '即将支持' })).toBeDisabled();
  await expect(
    page.locator('[data-platform-id="macos"] a')
  ).toHaveCount(0);
  await expectNoWindowBubble(page, ['wheel'], '下载平台滚轮');

  await resetWindowBubbleProbe(page);
  await stack.dispatchEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    clientY: 520,
    isPrimary: true,
    pointerId: 51,
    pointerType: 'touch'
  });
  await stack.dispatchEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    clientY: 450,
    isPrimary: true,
    pointerId: 51,
    pointerType: 'touch'
  });
  await stack.dispatchEvent('pointerup', {
    bubbles: true,
    cancelable: true,
    clientY: 450,
    isPrimary: true,
    pointerId: 51,
    pointerType: 'touch'
  });
  await expect(stack).toHaveAttribute('data-active-platform', 'windows-x64');
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'download'
  );
  await expectNoWindowBubble(
    page,
    ['pointerdown', 'pointermove', 'pointerup'],
    '下载平台触屏手势'
  );

  await stack.focus();
  await expect(stack).toBeFocused();
  await resetWindowBubbleProbe(page);
  await page.keyboard.press('ArrowDown');
  await expect(stack).toHaveAttribute('data-active-platform', 'macos');
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'download'
  );
  await expectNoWindowBubble(page, ['keydown'], '下载平台 ArrowDown');
  await resetWindowBubbleProbe(page);
  await page.keyboard.press('ArrowUp');
  await expect(stack).toHaveAttribute('data-active-platform', 'windows-x64');
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'download'
  );
  await expectNoWindowBubble(page, ['keydown'], '下载平台 ArrowUp');
  await resetWindowBubbleProbe(page);
  await page.keyboard.press('Escape');
  await expect.poll(
    () => stack.evaluate((element) => (
      !element.contains(element.ownerDocument.activeElement)
    )),
    { message: 'Escape 后焦点应退出下载平台局部控件' }
  ).toBe(true);
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'download'
  );
  await expectNoWindowBubble(page, ['keydown'], '下载平台 Escape');
  expect(runtimeErrors).toEqual([]);
});

test('下载侧栏仅在桌面悬停或焦点期间展开，并保留真实 Windows 链接', async ({
  page
}) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await enterInteractive(page);
  await enterChapter(page, 'download');

  const download = page.locator('[data-testid="download-chapter"]');
  const faqTrigger = page.getByRole('button', { name: '显示常见问题' });
  const faqPanel = page.getByRole('complementary', { name: '常见问题' });
  const windowsLink = page.getByRole('link', { name: '下载 Windows' });

  expect(await download.evaluate((element) => getComputedStyle(element).backgroundImage))
    .toBe('none');
  await expect(faqTrigger).not.toHaveAttribute('aria-pressed');
  await expect(faqTrigger.locator('svg')).toHaveCount(0);

  await faqTrigger.hover();
  await expect(download).toHaveAttribute('data-visible-side', 'faq');
  await expect(faqPanel).toBeVisible();
  await page.mouse.move(720, 450);
  await expect(download).toHaveAttribute('data-visible-side', 'none');

  await faqTrigger.focus();
  await expect(download).toHaveAttribute('data-visible-side', 'faq');
  await faqTrigger.click();
  await faqTrigger.blur();
  await page.mouse.move(720, 450);
  await expect(download).toHaveAttribute('data-visible-side', 'none');

  await expect(windowsLink).toHaveAttribute('href', /\.exe$/u);
  await expect(windowsLink).not.toHaveAttribute('download');
  await expect(page.locator('[data-platform-id="windows-x64"] code'))
    .toHaveText(/^[a-f0-9]{64}$/u);
  expect(runtimeErrors).toEqual([]);
});

test('支付滚筒消费局部输入并显示映射正确的真实付款码', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await enterInteractive(page);
  await enterChapter(page, 'donation');

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
    'donation'
  );
  await expect(roller).toHaveAttribute('data-active-payment', 'paypal');
  await expectNoWindowBubble(page, ['wheel'], '支付方式滚轮');

  await resetWindowBubbleProbe(page);
  await roller.dispatchEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    clientY: 450,
    isPrimary: true,
    pointerId: 61,
    pointerType: 'touch'
  });
  await roller.dispatchEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    clientY: 520,
    isPrimary: true,
    pointerId: 61,
    pointerType: 'touch'
  });
  await roller.dispatchEvent('pointerup', {
    bubbles: true,
    cancelable: true,
    clientY: 520,
    isPrimary: true,
    pointerId: 61,
    pointerType: 'touch'
  });
  await expect(roller).toHaveAttribute('data-active-payment', 'alipay');
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'donation'
  );
  await expectNoWindowBubble(
    page,
    ['pointerdown', 'pointermove', 'pointerup'],
    '支付方式触屏手势'
  );

  await roller.focus();
  await expect(roller).toBeFocused();
  await resetWindowBubbleProbe(page);
  await page.keyboard.press('ArrowDown');
  await expect(roller).toHaveAttribute('data-active-payment', 'paypal');
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'donation'
  );
  await expectNoWindowBubble(page, ['keydown'], '支付方式 ArrowDown');
  await resetWindowBubbleProbe(page);
  await page.keyboard.press('ArrowUp');
  await expect(roller).toHaveAttribute('data-active-payment', 'alipay');
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'donation'
  );
  await expectNoWindowBubble(page, ['keydown'], '支付方式 ArrowUp');
  await resetWindowBubbleProbe(page);
  await page.keyboard.press('Escape');
  await expect.poll(
    () => roller.evaluate((element) => (
      !element.contains(element.ownerDocument.activeElement)
    )),
    { message: 'Escape 后焦点应退出支付方式局部控件' }
  ).toBe(true);
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'donation'
  );
  await expectNoWindowBubble(page, ['keydown'], '支付方式 Escape');

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
  await expect(paypalImage).toHaveAttribute('src', '/Paypal.jpg');
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
  await enterChapter(page, 'donation');

  await page.getByRole('button', { name: '打开微信付款码' }).click();
  const dialog = page.getByRole('dialog', { name: '微信付款码' });
  await expect(dialog).toHaveAttribute('data-input-scope', 'local');

  await page.keyboard.press('PageUp');
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'donation'
  );

  await dialog.hover();
  await page.mouse.wheel(0, -800);
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'donation'
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
    'donation'
  );

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test('付款码资源加载失败时显示稳定回退并保持关闭行为', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.route('**/WechatPay.jpg', (route) => route.abort());
  await enterInteractive(page);
  await enterChapter(page, 'donation');

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

test('捐款章节不显示黄色 Canvas 光场并保留共享文件预览', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await enterInteractive(page);
  await enterChapter(page, 'donation');

  const canvas = page.locator(CANVAS);
  await expect(canvas).toHaveCount(0);
  await expect(page.locator('[data-layer="file"]')).toHaveAttribute(
    'data-profile-id',
    'donation'
  );

  const icon = await waitForFile(page);
  await icon.hover();
  await expect(page.locator(PREVIEW)).toBeVisible();
  await expectInsideViewport(page, page.locator(PREVIEW));
  expect(runtimeErrors).toEqual([]);
});

test('390 付款码弹层保持安全边距并完整显示真实图片', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await enterInteractive(page);
  await enterChapter(page, 'donation');

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
    path: resolve(SCREENSHOT_DIRECTORY, 'donation-dialog-390.png')
  });

  await page.getByRole('button', { name: '关闭付款码' }).click();
  await expect(dialog).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test('390 首屏 drawing 阶段点击下一章节一次即可进入介绍章', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?seed=42');

  await expect(page.locator(HOME)).toHaveAttribute(
    'data-phase',
    /drawing|settling/
  );
  await page.getByRole('button', { name: '下一章节' }).click();

  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'about'
  );
  await expect(page.locator(HOME)).toHaveAttribute('data-phase', 'exiting');
  expect(runtimeErrors).toEqual([]);
});

test('窗口 blur 和 focus 会同步下载与捐款章节暂停状态', async ({ page }) => {
  await enterInteractive(page);
  await enterChapter(page, 'download');
  const download = page.locator('[data-testid="download-chapter"]');

  await expect(download).toHaveAttribute('data-paused', 'false');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(download).toHaveAttribute('data-paused', 'true');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(download).toHaveAttribute('data-paused', 'false');

  await page.keyboard.press('PageDown');
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'feedback'
  );
  await page.keyboard.press('PageDown');
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'donation'
  );
  const donation = page.locator(DONATION);
  await expect(donation).toHaveAttribute('data-paused', 'false');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(donation).toHaveAttribute('data-paused', 'true');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(donation).toHaveAttribute('data-paused', 'false');
});

test('目标视口五章节无溢出遮挡且减少动态效果保持完整导航', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const viewports = [
    { width: 390, height: 844 },
    { width: 568, height: 320 },
    { width: 768, height: 900 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 }
  ];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto('/?seed=42');

    const experience = page.locator(WEBSITE);
    const canvas = page.locator(CANVAS);
    const next = page.getByRole('button', { name: '下一章节' });
    await expect(experience).toHaveAttribute('data-reduced-motion', 'true');
    await expect(page.locator(HOME)).toHaveAttribute(
      'data-phase',
      'interactive'
    );
    await expect(canvas).toBeHidden();
    expect(await countCanvasAlphaPixels(canvas)).toBe(0);

    if (viewport.width === 1920) {
      await page.screenshot({
        path: resolve(
          SCREENSHOT_DIRECTORY,
          'website-reduced-motion-1920.png'
        )
      });
    }

    for (const [index, chapterId] of CHAPTER_IDS.entries()) {
      await expect(experience).toHaveAttribute(
        'data-active-chapter',
        chapterId
      );
      const section = page.locator(`[data-chapter-id="${chapterId}"]`);
      await expect.poll(
        () => section.evaluate((element) => Number(
          getComputedStyle(element).opacity
        )),
        { message: `${viewport.width}x${viewport.height} ${chapterId} 应完成交叉渐隐` }
      ).toBeGreaterThanOrEqual(0.99);
      await expect(section).toHaveCSS('transform', 'none');
      await expectActiveChapterLayout(page, chapterId);
      if (
        viewport.width === 568
        && viewport.height === 320
        && chapterId === 'download'
      ) {
        const heading = section.getByRole('heading', {
          name: '选择你的平台',
          exact: true
        });
        for (const card of await section.locator('[data-platform-id]').all()) {
          await expectNoOverlap(
            heading,
            card,
            '低高度横屏的平台卡不应遮挡章节标题'
          );
        }
        await page.screenshot({
          path: resolve(SCREENSHOT_DIRECTORY, 'download-568x320.png')
        });
      }

      if (index === CHAPTER_IDS.length - 1) continue;
      if (viewport.width <= 760) {
        await next.click();
      } else {
        await page.keyboard.press('PageDown');
      }
      await expect(experience).toHaveAttribute(
        'data-active-chapter',
        CHAPTER_IDS[index + 1]!
      );
    }
  }

  expect(runtimeErrors).toEqual([]);
});

test('matchMedia 初始化异常时进入静态回退且不出现黑屏', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => {
        throw new Error('matchMedia 初始化失败');
      }
    });
  });

  await page.goto('/');
  const experience = page.locator(WEBSITE);
  const home = page.locator(HOME);
  const overlay = page.locator('[data-layer="intro"]');

  await expect(home).toHaveAttribute('data-phase', 'interactive');
  await expect(experience).toHaveAttribute('data-initialization-failed', 'true');
  await expect(overlay).toHaveAttribute('data-active', 'false');
  await expect(overlay).toBeHidden();
  await expect(getBrandHeading(page)).toBeVisible();
  await expect(page.locator('[data-testid="cursor-field"]')).toHaveCount(0);
  await expect(page.locator(SWARM)).toHaveCount(0);
});

test('AP Logo 素材加载失败时进入静态回退并保留品牌标题', async ({ page }) => {
  await page.route('**/AP.png', (route) => route.abort());

  await page.goto('/');
  const experience = page.locator(WEBSITE);
  const home = page.locator(HOME);
  const overlay = page.locator('[data-layer="intro"]');

  await expect(experience).toHaveAttribute('data-initialization-failed', 'true');
  await expect(home).toHaveAttribute('data-phase', 'interactive');
  await expect(overlay).toHaveAttribute('data-active', 'false');
  await expect(overlay).toBeHidden();
  await expect(getBrandHeading(page)).toBeVisible();
});

test('Canvas 尺寸观察器初始化异常时进入静态回退', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: class {
        constructor() {
          throw new Error('ResizeObserver 初始化失败');
        }
      }
    });
  });

  await page.goto('/');
  const experience = page.locator(WEBSITE);
  const home = page.locator(HOME);
  await expect(experience).toHaveAttribute('data-initialization-failed', 'true');
  await expect(home).toHaveAttribute('data-phase', 'interactive');
  await expect(getBrandHeading(page)).toBeVisible();
  await expect(page.locator(CANVAS)).toHaveCount(0);
  await expect(page.locator(SWARM)).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test('Canvas 2D 上下文不可用时进入静态回退', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = () => null;
  });

  await page.goto('/');
  const experience = page.locator(WEBSITE);
  const home = page.locator(HOME);
  await expect(experience).toHaveAttribute('data-initialization-failed', 'true');
  await expect(home).toHaveAttribute('data-phase', 'interactive');
  await expect(getBrandHeading(page)).toBeVisible();
  await expect(page.locator(CANVAS)).toHaveCount(0);
  await expect(page.locator(SWARM)).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test('随机源初始化异常时进入静态回退', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'getRandomValues', {
      configurable: true,
      value: () => {
        throw new Error('随机源初始化失败');
      }
    });
  });

  await page.goto('/');
  await page.mouse.click(12, 12);
  const experience = page.locator(WEBSITE);
  const home = page.locator(HOME);
  await expect(experience).toHaveAttribute('data-initialization-failed', 'true');
  await expect(home).toHaveAttribute('data-phase', 'interactive');
  await expect(getBrandHeading(page)).toBeVisible();
  await expect(page.locator(CANVAS)).toHaveCount(0);
  await expect(page.locator(SWARM)).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test('静态回退通过运行时属性关闭章节与付款码动效', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => {
        throw new Error('测试 matchMedia 初始化失败');
      }
    });
  });
  await page.goto('/?seed=42');

  const experience = page.locator('[data-testid="website-experience"]');
  const next = page.getByRole('button', { name: '下一章节' });
  await expect(experience).toHaveAttribute('data-static-fallback', 'active');
  await next.click();
  await next.click();
  await expect(experience).toHaveAttribute('data-active-chapter', 'download');

  const download = page.locator('[data-testid="download-chapter"]');
  const faqTrigger = page.getByRole('button', { name: '显示常见问题' });
  await expect(download).toHaveAttribute('data-motion-disabled', 'true');
  await faqTrigger.hover();
  await expect(download).toHaveAttribute('data-visible-side', 'faq');
  const downloadMotion = await download.evaluate((root) => {
    const trigger = root.querySelector('button[aria-label="显示常见问题"]');
    const panel = root.querySelector('[data-side-panel="faq"]');
    const card = root.querySelector('[data-platform-id]');
    return {
      triggerTransition: trigger
        ? getComputedStyle(trigger).transitionDuration
        : null,
      panelTransition: panel ? getComputedStyle(panel).transitionDuration : null,
      cardTransition: card ? getComputedStyle(card).transitionDuration : null
    };
  });
  expect(downloadMotion).toEqual({
    triggerTransition: '0s',
    panelTransition: '0s',
    cardTransition: '0s'
  });
  expect(
    await page.getByRole('link', { name: '下载 Windows' }).getAttribute('href')
  ).toContain('.exe');

  await next.click();
  await next.click();
  await expect(experience).toHaveAttribute('data-active-chapter', 'donation');
  const donation = page.locator(DONATION);
  await expect(donation).toHaveAttribute('data-motion-disabled', 'true');
  const payment = page.getByRole('button', { name: '打开微信付款码' });
  await expect(payment).toBeEnabled();
  expect(await payment.evaluate((button) => (
    getComputedStyle(button).transitionDuration
  ))).toBe('0s');
  await payment.click();

  const dialog = page.getByRole('dialog', { name: '微信付款码' });
  await expect(dialog).toHaveAttribute('data-motion-disabled', 'true');
  const dialogMotion = await dialog.evaluate((backdrop) => {
    const panel = backdrop.querySelector('[data-testid="qr-panel"]');
    return {
      backdropAnimation: getComputedStyle(backdrop).animationName,
      panelAnimation: panel ? getComputedStyle(panel).animationName : null
    };
  });
  expect(dialogMotion).toEqual({
    backdropAnimation: 'none',
    panelAnimation: 'none'
  });
  expect(runtimeErrors).toEqual([]);
});

test('减少动态效果时文件保持分离可聚焦且预览立即定位', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await enterInteractive(page);
  await expect.poll(() => page.locator(ICON).count(), { timeout: 6_000 }).toBeGreaterThanOrEqual(2);

  const firstIcon = page.locator(ICON).nth(0);
  const secondIcon = page.locator(ICON).nth(1);
  await expect(firstIcon).toHaveAttribute('data-phase', 'floating');
  const visibleState = await firstIcon.locator('span').evaluate((motion) => {
    const style = getComputedStyle(motion);
    return {
      opacity: style.opacity,
      visibility: style.visibility
    };
  });
  expect(visibleState).toEqual({
    opacity: '1',
    visibility: 'visible'
  });
  const firstBox = await firstIcon.boundingBox();
  const secondBox = await secondIcon.boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(
    Math.abs(firstBox!.x - secondBox!.x) + Math.abs(firstBox!.y - secondBox!.y)
  ).toBeGreaterThan(8);

  const initialPosition = await firstIcon.evaluate((icon) => {
    const rect = icon.getBoundingClientRect();
    const style = getComputedStyle(icon);
    return {
      left: rect.left,
      top: rect.top,
      transform: style.transform,
      x: style.getPropertyValue('--file-x'),
      y: style.getPropertyValue('--file-y')
    };
  });
  await page.waitForTimeout(700);
  const settledPosition = await firstIcon.evaluate((icon) => {
    const rect = icon.getBoundingClientRect();
    const style = getComputedStyle(icon);
    return {
      left: rect.left,
      top: rect.top,
      transform: style.transform,
      x: style.getPropertyValue('--file-x'),
      y: style.getPropertyValue('--file-y')
    };
  });
  expect(settledPosition).toEqual(initialPosition);

  await firstIcon.hover();
  await expect(page.locator(PREVIEW)).toBeVisible();
  await page.mouse.move(720, 450);
  await expect(page.locator(PREVIEW)).toHaveCount(0);

  await page.keyboard.press('Tab');
  await expect(firstIcon).toBeFocused();
  await expect(page.locator(PREVIEW)).toBeVisible();
  await expect(page.locator(PREVIEW)).toHaveAttribute('data-motion-state', 'inactive');
  await expect(page.locator(SWARM)).toHaveAttribute('data-preview-tween-state', 'inactive');
  await expectInsideViewport(page, page.locator(PREVIEW));
});

test('390 宽度无横向溢出且隐藏 Canvas 并最多显示四个图标', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await enterInteractive(page);
  await waitForFile(page);

  const viewportWidths = await page.locator(HOME).evaluate((home) => ({
    client: home.clientWidth,
    scroll: home.scrollWidth
  }));
  expect(viewportWidths.scroll).toBeLessThanOrEqual(viewportWidths.client);
  await expect(page.locator(CANVAS)).toBeHidden();
  expect(await page.locator(`${ICON}:visible`).count()).toBeLessThanOrEqual(4);
  await expect(getBrandHeading(page)).toBeVisible();

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

  for (const chapterId of ['home', 'about', 'download', 'feedback', 'donation']) {
    await expect(experience).toHaveAttribute('data-active-chapter', chapterId);
    const activeSection = page.locator(`[data-chapter-id="${chapterId}"]`);
    await expect(activeSection).toHaveAttribute('data-interactive', 'true');

    const widths = await activeSection.evaluate((section) => ({
      client: section.clientWidth,
      scroll: section.scrollWidth
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);

    if (chapterId !== 'donation') {
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

test('文件预览挂载在预览层并位于品牌层之上', async ({ page }) => {
  await enterInteractive(page);
  const icon = await waitForFile(page);
  await icon.hover();

  const preview = page.locator(PREVIEW);
  await expect(preview).toBeVisible();
  const layerEvidence = await preview.evaluate((node) => {
    const previewLayer = node.parentElement;
    const brandLayer = document.querySelector('[data-layer="brand"]');
    return {
      parentLayer: previewLayer?.getAttribute('data-layer'),
      previewZ: Number(previewLayer ? getComputedStyle(previewLayer).zIndex : -1),
      brandZ: Number(brandLayer ? getComputedStyle(brandLayer).zIndex : -1)
    };
  });

  expect(layerEvidence.parentLayer).toBe('preview');
  expect(layerEvidence.previewZ).toBeGreaterThan(layerEvidence.brandZ);
});

test('开场跳过后生成文件且活动数始终不超过 10', async ({ page }) => {
  await enterInteractive(page);
  await waitForFile(page);

  await page.evaluate((selector) => {
    const swarm = document.querySelector(selector);
    if (!swarm) {
      throw new Error('缺少文件队列根层');
    }

    const recordCount = () => {
      const current = Number(swarm.getAttribute('data-active-count') ?? 0);
      const previous = Number(Reflect.get(window, '__websiteMaxFileCount') ?? 0);
      Reflect.set(window, '__websiteMaxFileCount', Math.max(previous, current));
    };
    recordCount();
    const observer = new MutationObserver(recordCount);
    observer.observe(swarm, {
      attributes: true,
      attributeFilter: ['data-active-count']
    });
    Reflect.set(window, '__websiteCountObserver', observer);
  }, SWARM);

  await page.waitForTimeout(12_000);
  const maximumCount = await page.evaluate(
    () => Number(Reflect.get(window, '__websiteMaxFileCount') ?? 0)
  );

  expect(maximumCount).toBeGreaterThan(0);
  expect(maximumCount).toBeLessThanOrEqual(10);
  await expect(page.locator(SWARM)).toHaveAttribute('data-active-count', /^\d+$/);
});

test('七类素材全部失败后逐步禁用并停止生成', async ({ page }) => {
  await page.route('**/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (FILE_ASSET_PATHS.has(pathname)) {
      await route.abort();
      return;
    }
    await route.continue();
  });

  await enterInteractive(page);
  await expect(page.locator(SWARM)).toHaveAttribute('data-disabled-count', '0');
  await page.evaluate((selectors) => {
    const swarm = document.querySelector(selectors.swarm);
    if (!swarm) {
      throw new Error('缺少文件队列根层');
    }

    Reflect.set(window, '__disabledCountHistory', []);
    Reflect.set(window, '__sawLeavingParticle', false);
    const recordState = () => {
      const history = Reflect.get(window, '__disabledCountHistory') as number[];
      const count = Number(swarm.getAttribute('data-disabled-count') ?? 0);
      if (history.at(-1) !== count) {
        history.push(count);
      }
      if (swarm.querySelector(`${selectors.icon}[data-phase="leaving"]`)) {
        Reflect.set(window, '__sawLeavingParticle', true);
      }
    };
    recordState();
    const observer = new MutationObserver(recordState);
    observer.observe(swarm, {
      attributes: true,
      attributeFilter: ['data-disabled-count'],
      childList: true,
      subtree: true
    });
    Reflect.set(window, '__disabledCountObserver', observer);
  }, { swarm: SWARM, icon: ICON });

  await expect(page.locator(SWARM)).toHaveAttribute(
    'data-disabled-count',
    '7',
    { timeout: 15_000 }
  );
  await expect(page.locator(SWARM)).toHaveAttribute('data-active-count', '0');
  await expect(page.locator(ICON)).toHaveCount(0);

  const failureEvidence = await page.evaluate(() => ({
    disabledCounts: Reflect.get(window, '__disabledCountHistory') as number[],
    sawLeavingParticle: Boolean(Reflect.get(window, '__sawLeavingParticle'))
  }));
  expect(failureEvidence.disabledCounts).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(failureEvidence.sawLeavingParticle).toBe(true);

  await page.waitForTimeout(2_000);
  await expect(page.locator(SWARM)).toHaveAttribute('data-active-count', '0');
  await expect(page.locator(ICON)).toHaveCount(0);
});

test('预览保持单例并在键鼠模式间转移后正确关闭', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await enterInteractive(page);
  await expect(page.locator(SWARM)).toHaveAttribute(
    'data-preview-tween-state',
    'inactive'
  );
  const icon = await waitForFile(page);
  const iconBox = await icon.boundingBox();
  expect(iconBox).not.toBeNull();

  await icon.hover();
  await expect(page.locator(PREVIEW)).toHaveCount(1);
  await expect(page.locator(PREVIEW)).toBeVisible();
  await expect(page.locator(SWARM)).toHaveAttribute(
    'data-preview-tween-state',
    'active'
  );
  const firstPreviewBox = await page.locator(PREVIEW).boundingBox();
  expect(firstPreviewBox).not.toBeNull();

  await page.mouse.move(
    iconBox!.x + (iconBox!.width * 0.65),
    iconBox!.y + (iconBox!.height * 0.65)
  );
  let followedPreviewBox = await page.locator(PREVIEW).boundingBox();
  await expect.poll(async () => {
    followedPreviewBox = await page.locator(PREVIEW).boundingBox();
    if (!followedPreviewBox) return 0;
    return Math.abs(followedPreviewBox.x - firstPreviewBox!.x)
      + Math.abs(followedPreviewBox.y - firstPreviewBox!.y);
  }, {
    message: '指针移动后预览应跟随到新位置'
  }).toBeGreaterThan(2);
  expect(followedPreviewBox).not.toBeNull();
  expect(Math.abs(followedPreviewBox!.x - firstPreviewBox!.x)
    + Math.abs(followedPreviewBox!.y - firstPreviewBox!.y)).toBeGreaterThan(2);

  await page.mouse.down();
  await page.mouse.up();
  await expect(icon).toBeFocused();
  await page.mouse.move(4, 4);

  const focusedIconBox = await icon.boundingBox();
  let keyboardPreviewBox = await page.locator(PREVIEW).boundingBox();
  expect(focusedIconBox).not.toBeNull();
  const keyboardTargetX = focusedIconBox!.x + focusedIconBox!.width;
  const keyboardTargetY = focusedIconBox!.y + (focusedIconBox!.height / 2);
  await expect.poll(async () => {
    keyboardPreviewBox = await page.locator(PREVIEW).boundingBox();
    if (!keyboardPreviewBox) return Number.POSITIVE_INFINITY;
    const horizontalGap = Math.min(
      Math.abs(keyboardPreviewBox.x - keyboardTargetX),
      Math.abs(
        keyboardPreviewBox.x
        + keyboardPreviewBox.width
        - keyboardTargetX
      )
    );
    const verticalGap = Math.min(
      Math.abs(keyboardPreviewBox.y - keyboardTargetY),
      Math.abs(
        keyboardPreviewBox.y
        + keyboardPreviewBox.height
        - keyboardTargetY
      )
    );
    return Math.min(horizontalGap, verticalGap);
  }, {
    message: '键盘聚焦后预览应贴近文件图标'
  }).toBeLessThanOrEqual(20);
  expect(keyboardPreviewBox).not.toBeNull();
  await expectInsideViewport(page, page.locator(PREVIEW));

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(page.locator(PREVIEW)).toHaveCount(0);
  await expect(page.locator(SWARM)).toHaveAttribute(
    'data-preview-tween-state',
    'inactive'
  );

  for (let index = 0; index < 3; index += 1) {
    await icon.hover();
    await expect(page.locator(PREVIEW)).toHaveCount(1);
    await expect(page.locator(SWARM)).toHaveAttribute(
      'data-preview-tween-state',
      'active'
    );
    await page.mouse.move(4, 4);
    await expect(page.locator(PREVIEW)).toHaveCount(0);
    await expect(page.locator(SWARM)).toHaveAttribute(
      'data-preview-tween-state',
      'inactive'
    );
  }

  expect(consoleErrors).toEqual([]);
});

test('完整退场卸载预览前会清理 quickTo 动画', async ({ page }) => {
  await enterInteractive(page);
  const icon = await waitForFile(page);

  await icon.hover();
  await expect(page.locator(PREVIEW)).toHaveAttribute(
    'data-motion-state',
    'active'
  );
  await page.locator(WEBSITE).evaluate((experience, previewSelector) => {
    const preview = experience.querySelector(previewSelector);
    if (!preview) {
      throw new Error('缺少活动文件预览');
    }

    const history = [preview.getAttribute('data-motion-state') ?? 'missing'];
    Reflect.set(experience, '__previewMotionHistory', history);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target === preview) {
          const state = preview.getAttribute('data-motion-state') ?? 'missing';
          if (history.at(-1) !== state) {
            history.push(state);
          }
        }

        if (record.type === 'childList') {
          const previewWasRemoved = Array.from(record.removedNodes).some(
            (node) => node === preview
              || (node instanceof Element && node.contains(preview))
          );
          if (previewWasRemoved && history.at(-1) !== 'removed') {
            history.push('removed');
          }
        }
      }
    });
    observer.observe(experience, {
      attributes: true,
      attributeFilter: ['data-motion-state'],
      childList: true,
      subtree: true
    });
    Reflect.set(experience, '__previewMotionObserver', observer);
  }, PREVIEW);

  for (let index = 0; index < 9; index += 1) {
    await page.keyboard.press('PageDown');
  }

  await expect(page.locator(HOME)).toHaveAttribute('data-progress', '1.0000');
  await expect(page.locator(PREVIEW)).toHaveCount(0);
  await expect(page.locator(SWARM)).toHaveCount(0);
  await expect.poll(
    () => page.locator(WEBSITE).evaluate(
      (experience) => Reflect.get(
        experience,
        '__previewMotionHistory'
      ) as string[]
    )
  ).toEqual(['active', 'inactive', 'removed']);
});

test('进入 exiting 后不再增加粒子', async ({ page }) => {
  await enterInteractive(page);
  await waitForFile(page);
  await expect.poll(() => page.locator(ICON).count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(2);

  for (let index = 0; index < 7; index += 1) {
    await page.keyboard.press('PageDown');
  }
  await expect(page.locator(HOME)).toHaveAttribute('data-phase', 'exiting');

  const countAtExit = await page.locator(ICON).count();
  await page.waitForTimeout(2_000);
  expect(await page.locator(ICON).count()).toBeLessThanOrEqual(countAtExit);
});

test('暂停恢复不会让现有粒子瞬间过期', async ({ page }) => {
  await enterInteractive(page);
  const icon = await waitForFile(page);
  const iconHandle = await icon.elementHandle();
  expect(iconHandle).not.toBeNull();

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.locator(SWARM)).toHaveAttribute('data-paused', 'true');
  await page.waitForTimeout(7_000);
  expect(await iconHandle!.evaluate((element) => element.isConnected)).toBe(true);

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator(SWARM)).toHaveAttribute('data-paused', 'false');
  await page.waitForTimeout(150);
  expect(await iconHandle!.evaluate((element) => element.isConnected)).toBe(true);
});

test('开场暂停恢复会冻结 drawing 时间线并在 focus 后完成', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  const home = page.locator(HOME);

  await page.goto('/?seed=42');
  await expect(home).toHaveAttribute('data-phase', 'drawing');
  const crossfadeSample = await sampleIntroCrossfade(page);
  expect(crossfadeSample.captured).toBe(true);

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(1_200);
  await expect(home).toHaveAttribute('data-phase', 'drawing');

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(home).toHaveAttribute('data-phase', 'interactive', { timeout: 3_000 });
  expect(runtimeErrors).toEqual([]);
});

test('自动开场在约三秒内完成磁吸归位并保持最终 Logo 与 1440 安全布局', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // 在页面内记录阶段切换时刻，避免把 Playwright 轮询开销计入动画耗时。
  await page.addInitScript((homeSelector) => {
    Reflect.set(window, '__introStartedAt', null);
    Reflect.set(window, '__introInteractiveAt', null);
    Reflect.set(window, '__introPhaseHistory', []);
    const recordPhase = () => {
      const phase = document.querySelector(homeSelector)?.getAttribute('data-phase');
      const history = Reflect.get(window, '__introPhaseHistory') as string[];
      if (phase && history.at(-1) !== phase) {
        history.push(phase);
      }
      if (phase === 'drawing' && Reflect.get(window, '__introStartedAt') === null) {
        Reflect.set(window, '__introStartedAt', performance.now());
      }
      if (phase === 'interactive' && Reflect.get(window, '__introInteractiveAt') === null) {
        Reflect.set(window, '__introInteractiveAt', performance.now());
      }
    };
    const observer = new MutationObserver(recordPhase);
    observer.observe(document, {
      attributes: true,
      attributeFilter: ['data-phase'],
      childList: true,
      subtree: true
    });
    Reflect.set(window, '__introPhaseObserver', observer);
  }, HOME);

  await page.goto('/?seed=42');
  await expect(page.locator(HOME)).toHaveAttribute('data-phase', /drawing|settling/);
  const pieces = page.locator('[data-testid="magnetic-logo-piece"]');
  await expect(pieces).toHaveCount(6);
  await expect(pieces.first()).toHaveAttribute('src', '/AP.png');
  const magneticLayers = await sampleIntroCrossfade(page);
  expect(magneticLayers.captured).toBe(true);
  expect(magneticLayers.logoOpacity).toBeGreaterThan(0);
  expect(magneticLayers.logoOpacity).toBeLessThan(1);
  expect(magneticLayers.visiblePieceCount).toBeGreaterThan(0);
  expect(
    magneticLayers.visiblePieceFilters.every((filter) => filter.includes('invert(1)'))
  ).toBe(true);
  expect(new Set(magneticLayers.pieceSources)).toEqual(new Set(['/AP.png']));
  await page.screenshot({
    path: resolve(SCREENSHOT_DIRECTORY, 'desktop-1440-magnetic.png'),
    fullPage: true
  });
  await expect(page.locator(HOME)).toHaveAttribute(
    'data-phase',
    'interactive',
    { timeout: 5_000 }
  );

  const introEvidence = await page.evaluate(() => {
    const startedAt = Reflect.get(window, '__introStartedAt');
    const interactiveAt = Reflect.get(window, '__introInteractiveAt');
    return {
      startedAt,
      interactiveAt,
      elapsedMs: Number(interactiveAt) - Number(startedAt),
      phases: Reflect.get(window, '__introPhaseHistory') as string[]
    };
  });
  expect(introEvidence.startedAt).toEqual(expect.any(Number));
  expect(introEvidence.interactiveAt).toEqual(expect.any(Number));
  expect(introEvidence.elapsedMs).toBeLessThanOrEqual(3_300);
  expect(introEvidence.phases).toContain('drawing');
  expect(introEvidence.phases).toContain('settling');
  expect(introEvidence.phases.at(-1)).toBe('interactive');
  await expect(page.locator('[data-layer="intro"]')).toHaveAttribute('data-active', 'false');
  await expect(page.locator('[data-layer="intro"]')).toBeHidden();
  await expect(getBrandHeading(page)).toHaveCSS('color', 'rgb(28, 28, 28)');

  await expect(page.locator('[data-testid="brand-logo"]')).toBeVisible();
  await expect(page.locator('[data-testid="brand-logo"]')).toHaveCSS('filter', 'none');
  for (const piece of await pieces.all()) {
    await expect(piece).toBeHidden();
  }

  await expect.poll(() => page.locator(ICON).count(), { timeout: 6_000 }).toBeGreaterThanOrEqual(2);
  await page.mouse.move(720, 450);

  const brandTransform = getBrandHeading(page).locator('..');
  let brandBox = await brandTransform.boundingBox();
  await expect.poll(async () => {
    brandBox = await brandTransform.boundingBox();
    if (!brandBox) return Number.POSITIVE_INFINITY;
    return Math.max(
      Math.abs(brandBox.x + brandBox.width / 2 - 720),
      Math.abs(brandBox.y + brandBox.height / 2 - 450)
    );
  }, {
    message: '品牌层应跟随指针稳定到中心附近'
  }).toBeLessThanOrEqual(28);
  expect(brandBox).not.toBeNull();

  const fileBoxes = await page.locator(`${ICON}:visible`).evaluateAll((icons) => (
    icons.map((icon) => {
      const bounds = icon.getBoundingClientRect();
      return {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom
      };
    })
  ));
  const safeZone = {
    left: 1440 * 0.35,
    top: 900 * 0.35,
    right: 1440 * 0.65,
    bottom: 900 * 0.65
  };
  expect(fileBoxes.length).toBeGreaterThanOrEqual(2);
  for (const box of fileBoxes) {
    expect(box.left).toBeGreaterThanOrEqual(23);
    expect(box.top).toBeGreaterThanOrEqual(23);
    expect(box.right).toBeLessThanOrEqual(1417);
    expect(box.bottom).toBeLessThanOrEqual(877);
    expect(
      box.right <= safeZone.left
      || box.left >= safeZone.right
      || box.bottom <= safeZone.top
      || box.top >= safeZone.bottom
    ).toBe(true);
  }

  await page.screenshot({
    path: resolve(SCREENSHOT_DIRECTORY, 'desktop-1440-home.png')
  });
  expect(runtimeErrors).toEqual([]);
});

const introSkipCases: ReadonlyArray<{
  label: string;
  skip: (page: Page) => Promise<void>;
}> = [
  {
    label: '滚轮',
    skip: async (page) => page.mouse.wheel(0, 160)
  },
  {
    label: '点击',
    skip: async (page) => page.mouse.click(12, 12)
  },
  {
    label: '方向键',
    skip: async (page) => page.keyboard.press('ArrowDown')
  }
];

for (const skipCase of introSkipCases) {
  test(`新页面首次${skipCase.label}输入跳过开场且不增加章节进度`, async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);
    await page.goto('/?seed=42');
    await expect(page.locator(HOME)).toHaveAttribute('data-phase', /drawing|settling/);

    await skipCase.skip(page);

    await expect(page.locator(HOME)).toHaveAttribute('data-phase', 'interactive');
    await expect(page.locator(HOME)).toHaveAttribute('data-progress', '0.0000');
    await expect(page.locator('[data-testid="brand-logo"]')).toBeVisible();
    for (const piece of await page.locator('[data-testid="magnetic-logo-piece"]').all()) {
      await expect(piece).toBeHidden();
    }
    expect(runtimeErrors).toEqual([]);
  });
}

test('PageDown 以缩放和透明度推进非纵向滚动章节并在终点卸载文件体验', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await enterInteractive(page);
  const icon = await waitForFile(page);
  await icon.hover();
  await expect(page.locator(PREVIEW)).toBeVisible();

  const initialVisual = await page.locator(BRAND).evaluate((brand) => {
    const style = getComputedStyle(brand);
    return { opacity: style.opacity, transform: style.transform };
  });
  await page.keyboard.press('PageDown');
  await expect.poll(() => readProgress(page)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press('PageDown');
  }
  await expect(page.locator(HOME)).toHaveAttribute('data-phase', 'exiting');
  const exitingVisual = await page.locator(BRAND).evaluate((brand) => {
    const style = getComputedStyle(brand);
    return { opacity: style.opacity, transform: style.transform };
  });
  expect(exitingVisual.opacity).not.toBe(initialVisual.opacity);
  expect(exitingVisual.transform).not.toBe(initialVisual.transform);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await page.screenshot({
    path: resolve(SCREENSHOT_DIRECTORY, 'desktop-1440-exiting.png')
  });

  await page.keyboard.press('PageDown');
  await page.keyboard.press('PageDown');
  await expect(page.locator(HOME)).toHaveAttribute('data-progress', '1.0000');
  await expect(page.locator(SWARM)).toHaveCount(0);
  await expect(page.locator(PREVIEW)).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(runtimeErrors).toEqual([]);
});

test('568x320 窄横屏捐款滚筒保持在视口内且页面无横向溢出', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 568, height: 320 });
  await enterInteractive(page);
  await expect(page.locator('[data-chapter-id]')).toHaveCount(5);
  await enterChapter(page, 'donation');

  const donationSection = page.locator('[data-chapter-id="donation"]');
  await expect(donationSection).toHaveAttribute('data-interactive', 'true');

  const donation = page.locator(DONATION);
  const roller = donation.getByRole('group', { name: '选择付款方式' });
  await expect(roller).toBeVisible();
  await expectInsideViewport(page, roller);

  const cardBounds = await donation.locator('[data-payment-id]').evaluateAll(
    (cards) => cards.map((card) => {
      const bounds = card.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        height: bounds.height
      };
    })
  );
  for (const bounds of cardBounds) {
    expect(bounds.left).toBeGreaterThanOrEqual(-1);
    expect(bounds.right).toBeLessThanOrEqual(569);
    expect(bounds.top).toBeGreaterThanOrEqual(-1);
    expect(bounds.bottom).toBeLessThanOrEqual(321);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
  }

  const layoutState = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth
  }));
  expect(layoutState.documentWidth).toBeLessThanOrEqual(layoutState.viewportWidth);
  expect(layoutState.bodyWidth).toBeLessThanOrEqual(layoutState.viewportWidth);
  await page.screenshot({
    path: resolve(SCREENSHOT_DIRECTORY, 'donation-568x320.png')
  });
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
      page.locator('[data-chapter-id="home"]')
        .getByRole('heading', { name: 'AI Pet', exact: true })
        .locator('..')
    ],
    ['about', page.locator('[data-chapter-id="about"] h2')],
    ['download', page.getByRole('group', { name: '选择下载平台' })],
    ['feedback', page.locator('[data-chapter-id="feedback"] h2')],
    ['donation', page.getByRole('group', { name: '选择付款方式' })]
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
    const overlapsNavigation = !(
      primaryBounds!.x + primaryBounds!.width <= navigationBounds!.x
      || navigationBounds!.x + navigationBounds!.width <= primaryBounds!.x
      || primaryBounds!.y + primaryBounds!.height <= navigationBounds!.y
      || navigationBounds!.y + navigationBounds!.height <= primaryBounds!.y
    );
    expect(overlapsNavigation, `${chapterId} 主内容不应被章节导航遮挡`)
      .toBe(false);

    if (chapterId !== 'donation') {
      await next.click();
    }
  }

  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(568);
  expect(runtimeErrors).toEqual([]);
});

test('移动下载抽屉的可见文本避让章节导航', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const viewports = [
    { width: 390, height: 844 },
    { width: 375, height: 667 },
    { width: 568, height: 320 }
  ];
  const sides = [
    { id: 'faq', trigger: '显示常见问题' },
    { id: 'notice', trigger: '显示安装前须知' }
  ] as const;

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto('/?seed=42');

    const experience = page.locator('[data-testid="website-experience"]');
    const download = page.locator('[data-testid="download-chapter"]');
    const next = page.getByRole('button', { name: '下一章节' });
    await next.click();
    await next.click();
    await expect(experience).toHaveAttribute('data-active-chapter', 'download');

    for (const side of sides) {
      const trigger = page.getByRole('button', { name: side.trigger });
      const triggerBounds = await trigger.boundingBox();
      expect(triggerBounds).not.toBeNull();
      expect(triggerBounds!.width).toBeGreaterThanOrEqual(44);
      expect(triggerBounds!.height).toBeGreaterThanOrEqual(44);
      await trigger.click();
      await expect(download).toHaveAttribute('data-visible-side', side.id);

      const panel = download.locator(`[data-side-panel="${side.id}"]`);
      await expect(panel).toHaveAttribute('aria-hidden', 'false');
      await expect(panel.locator('[data-panel-item]').first()).toBeVisible();
      await expectInsideViewport(page, panel);

      const overlappingTexts = await panel.evaluate((panelNode) => {
        const navigation = document.querySelector(
          'nav[aria-label="章节导航"]'
        );
        if (!navigation) return ['章节导航不存在'];

        const panelRect = panelNode.getBoundingClientRect();
        const navigationRect = navigation.getBoundingClientRect();
        return Array.from(panelNode.querySelectorAll<HTMLElement>('h2, h3, p'))
          .filter((textNode) => {
            const style = getComputedStyle(textNode);
            return style.display !== 'none'
              && style.visibility !== 'hidden'
              && Number(style.opacity) > 0;
          })
          .filter((textNode) => {
            const textRect = textNode.getBoundingClientRect();
            const visibleRect = {
              left: Math.max(0, panelRect.left, textRect.left),
              right: Math.min(window.innerWidth, panelRect.right, textRect.right),
              top: Math.max(0, panelRect.top, textRect.top),
              bottom: Math.min(window.innerHeight, panelRect.bottom, textRect.bottom)
            };
            if (
              visibleRect.right <= visibleRect.left
              || visibleRect.bottom <= visibleRect.top
            ) {
              return false;
            }

            return visibleRect.left < navigationRect.right
              && visibleRect.right > navigationRect.left
              && visibleRect.top < navigationRect.bottom
              && visibleRect.bottom > navigationRect.top;
          })
          .map((textNode) => textNode.textContent?.trim() ?? '');
      });
      expect(
        overlappingTexts,
        `${viewport.width}x${viewport.height} ${side.id} 可见文本不应与章节导航相交`
      ).toEqual([]);
    }

    const widths = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      viewport: window.innerWidth
    }));
    expect(widths.document).toBeLessThanOrEqual(widths.viewport);
    expect(widths.body).toBeLessThanOrEqual(widths.viewport);
  }

  expect(runtimeErrors).toEqual([]);
});

test('Canvas 轨迹产生真实像素、旧轨迹衰减且缓冲区 DPR 上限为 1.75', async ({
  browser,
  baseURL
}) => {
  if (!baseURL) throw new Error('缺少隔离网站地址');

  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2
  });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);

  try {
    await enterInteractive(page);
    const canvas = page.locator(CANVAS);
    await expect(canvas).toHaveAttribute('aria-hidden', 'true');
    await expect(canvas).toBeVisible();

    const trailPoints = [
      [180, 180],
      [420, 240],
      [700, 330],
      [980, 440],
      [1180, 620]
    ] as const;
    for (const [x, y] of trailPoints) {
      await page.mouse.move(x, y);
      await page.waitForTimeout(70);
    }
    await page.waitForTimeout(120);

    const canvasEvidence = await canvas.evaluate((element) => {
      if (!(element instanceof HTMLCanvasElement)) {
        throw new Error('光标场不是 Canvas 元素');
      }
      const bounds = element.getBoundingClientRect();
      return {
        cssWidth: bounds.width,
        cssHeight: bounds.height,
        bufferWidth: element.width,
        bufferHeight: element.height,
        browserDpr: window.devicePixelRatio
      };
    });
    expect(canvasEvidence.browserDpr).toBe(2);
    expect(canvasEvidence.bufferWidth).toBe(Math.round(canvasEvidence.cssWidth * 1.75));
    expect(canvasEvidence.bufferHeight).toBe(Math.round(canvasEvidence.cssHeight * 1.75));

    const trailPixelCount = await countCanvasAlphaPixels(canvas);
    expect(trailPixelCount).toBeGreaterThan(0);
    const homeColorEvidence = await readCanvasColorEvidence(canvas);
    expect(homeColorEvidence.alphaPixels).toBeGreaterThan(0);
    expect(
      homeColorEvidence.balancedPixels / homeColorEvidence.alphaPixels
    ).toBeGreaterThan(0.9);
    expect(homeColorEvidence.yellowPixels).toBe(0);
    await page.waitForTimeout(1_350);
    const decayedPixelCount = await countCanvasAlphaPixels(canvas);
    expect(decayedPixelCount).toBeGreaterThan(0);
    expect(decayedPixelCount).toBeLessThan(trailPixelCount);
    expect(runtimeErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('减少动态效果直接进入稳定交互并保留品牌与文件语义', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?seed=42');

  await expect(page.locator(HOME)).toHaveAttribute('data-phase', 'interactive');
  await expect(page.locator(CANVAS)).toBeHidden();
  await expect(getBrandHeading(page)).toBeVisible();
  const icon = await waitForFile(page);
  await expect(icon).toHaveAccessibleName(/^预览 /);

  const reducedMotionEvidence = await page.locator(BRAND).evaluate((brand) => {
    const transformNode = brand.firstElementChild;
    const magneticMark = brand.querySelector('[data-testid="magnetic-ap-mark"]');
    const pieces = Array.from(
      brand.querySelectorAll<HTMLElement>('[data-testid="magnetic-logo-piece"]')
    );
    const logo = brand.querySelector('img[src="/AP.png"]');
    const fileIcon = document.querySelector('[data-testid="file-icon"] img');
    return {
      brandTransform: getComputedStyle(brand).transform,
      innerTransform: transformNode ? getComputedStyle(transformNode).transform : null,
      magneticDisplay: magneticMark ? getComputedStyle(magneticMark).display : null,
      pieceTransitions: pieces.map((piece) => getComputedStyle(piece).transitionDuration),
      logoTransitionDuration: logo ? getComputedStyle(logo).transitionDuration : null,
      fileAnimation: fileIcon ? getComputedStyle(fileIcon).animationName : null
    };
  });
  expect(reducedMotionEvidence.brandTransform).toBe('none');
  expect(reducedMotionEvidence.innerTransform).toBe('none');
  expect(reducedMotionEvidence.magneticDisplay).toBe('none');
  expect(
    reducedMotionEvidence.pieceTransitions.every((duration) => duration === '0s')
  ).toBe(true);
  expect(reducedMotionEvidence.logoTransitionDuration).toBe('0s');
  expect(reducedMotionEvidence.fileAnimation).toBe('none');
  expect(runtimeErrors).toEqual([]);
});

test('1920 预览保持在视口内且所有文本不溢出', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await enterInteractive(page);
  const icon = await waitForFile(page);
  await page.mouse.move(1660, 220);
  await expect.poll(
    () => countCanvasAlphaPixels(page.locator(CANVAS)),
    { message: '1920 首页截图前灰色光场应产生非空像素' }
  ).toBeGreaterThan(0);
  await page.screenshot({
    path: resolve(SCREENSHOT_DIRECTORY, 'website-1920.png')
  });
  await icon.hover();

  const preview = page.locator(PREVIEW);
  await expect(preview).toBeVisible();
  await expectInsideViewport(page, preview);
  const overflowingText = await preview.locator('*').evaluateAll((nodes) => (
    nodes
      .filter((node) => (
        (node.textContent?.trim().length ?? 0) > 0
        && (
          node.scrollWidth > node.clientWidth + 1
          || node.scrollHeight > node.clientHeight + 1
        )
      ))
      .map((node) => node.tagName)
  ));
  expect(overflowingText).toEqual([]);

  await page.screenshot({
    path: resolve(SCREENSHOT_DIRECTORY, 'desktop-1920-preview.png')
  });
  expect(runtimeErrors).toEqual([]);
});
