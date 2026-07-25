import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const WEBSITE_URL = 'http://127.0.0.1:4173';
const REPOSITORY_ROOT = resolve(__dirname, '..', '..');
const STATIC_SERVER_SCRIPT = resolve(REPOSITORY_ROOT, 'tests/serve-website-export.mjs');
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
let websiteServer: ChildProcess | null = null;

async function waitForWebsite(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(WEBSITE_URL);
      if (response.ok) {
        return;
      }
    } catch {
      // 静态服务器尚未开始监听时继续等待。
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  throw new Error('静态网站未在 30 秒内启动');
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

test.beforeAll(async () => {
  await mkdir(SCREENSHOT_DIRECTORY, { recursive: true });
  websiteServer = spawn(process.execPath, [STATIC_SERVER_SCRIPT], {
    cwd: REPOSITORY_ROOT,
    stdio: 'ignore'
  });
  await waitForWebsite();
});

test.afterAll(async () => {
  if (websiteServer) {
    await stopWebsiteServer(websiteServer);
    websiteServer = null;
  }
});

async function enterInteractive(page: Page): Promise<void> {
  await page.goto('/?seed=42');
  await expect(page.locator(HOME)).toHaveAttribute('data-phase', /drawing|settling|interactive/);
  await page.mouse.click(12, 12);
  await expect(page.locator(HOME)).toHaveAttribute('data-phase', 'interactive');
}

async function waitForFile(page: Page): Promise<Locator> {
  await expect.poll(
    () => page.locator(ICON).count(),
    { timeout: 6_000, message: '开场跳过后应生成至少一个文件粒子' }
  ).toBeGreaterThan(0);
  return page.locator(ICON).first();
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
  const home = page.locator(HOME);
  const overlay = page.locator('[data-layer="intro"]');

  await expect(home).toHaveAttribute('data-phase', 'interactive');
  await expect(home).toHaveAttribute('data-initialization-failed', 'true');
  await expect(overlay).toHaveAttribute('data-active', 'false');
  await expect(overlay).toBeHidden();
  await expect(page.getByRole('heading', { name: 'AI Pet' })).toBeVisible();
  await expect(page.locator('[data-testid="cursor-field"]')).toHaveCount(0);
  await expect(page.locator(SWARM)).toHaveCount(0);
});

test('AP Logo 素材加载失败时进入静态回退并保留品牌标题', async ({ page }) => {
  await page.route('**/AP.png', (route) => route.abort());

  await page.goto('/');
  const home = page.locator(HOME);
  const overlay = page.locator('[data-layer="intro"]');

  await expect(home).toHaveAttribute('data-initialization-failed', 'true');
  await expect(home).toHaveAttribute('data-phase', 'interactive');
  await expect(overlay).toHaveAttribute('data-active', 'false');
  await expect(overlay).toBeHidden();
  await expect(page.getByRole('heading', { name: 'AI Pet' })).toBeVisible();
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
  const home = page.locator(HOME);
  await expect(home).toHaveAttribute('data-initialization-failed', 'true');
  await expect(home).toHaveAttribute('data-phase', 'interactive');
  await expect(page.getByRole('heading', { name: 'AI Pet' })).toBeVisible();
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
  const home = page.locator(HOME);
  await expect(home).toHaveAttribute('data-initialization-failed', 'true');
  await expect(home).toHaveAttribute('data-phase', 'interactive');
  await expect(page.getByRole('heading', { name: 'AI Pet' })).toBeVisible();
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
  const home = page.locator(HOME);
  await expect(home).toHaveAttribute('data-initialization-failed', 'true');
  await expect(home).toHaveAttribute('data-phase', 'interactive');
  await expect(page.getByRole('heading', { name: 'AI Pet' })).toBeVisible();
  await expect(page.locator(CANVAS)).toHaveCount(0);
  await expect(page.locator(SWARM)).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test('减少动态效果时文件保持分离可聚焦且预览立即定位', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await enterInteractive(page);
  await expect.poll(() => page.locator(ICON).count(), { timeout: 6_000 }).toBeGreaterThanOrEqual(2);

  const firstIcon = page.locator(ICON).nth(0);
  const secondIcon = page.locator(ICON).nth(1);
  const firstBox = await firstIcon.boundingBox();
  const secondBox = await secondIcon.boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(
    Math.abs(firstBox!.x - secondBox!.x) + Math.abs(firstBox!.y - secondBox!.y)
  ).toBeGreaterThan(8);

  await firstIcon.focus();
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
  await page.waitForTimeout(4_000);

  const viewportWidths = await page.locator(HOME).evaluate((home) => ({
    client: home.clientWidth,
    scroll: home.scrollWidth
  }));
  expect(viewportWidths.scroll).toBeLessThanOrEqual(viewportWidths.client);
  await expect(page.locator(CANVAS)).toBeHidden();
  expect(await page.locator(`${ICON}:visible`).count()).toBeLessThanOrEqual(4);
  await expect(page.getByRole('heading', { name: 'AI Pet' })).toBeVisible();

  const scrollEvidence = await page.locator(HOME).evaluate((home) => ({
    homeOverflowY: getComputedStyle(home).overflowY,
    bodyOverflowY: getComputedStyle(document.body).overflowY,
    position: getComputedStyle(home).position
  }));
  expect(scrollEvidence.homeOverflowY).not.toBe('hidden');
  expect(scrollEvidence.bodyOverflowY).not.toBe('hidden');
  expect(scrollEvidence.position).toBe('relative');

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
  await page.waitForTimeout(260);
  const firstPreviewBox = await page.locator(PREVIEW).boundingBox();
  expect(firstPreviewBox).not.toBeNull();

  await page.mouse.move(
    iconBox!.x + (iconBox!.width * 0.65),
    iconBox!.y + (iconBox!.height * 0.65)
  );
  await page.waitForTimeout(260);
  const followedPreviewBox = await page.locator(PREVIEW).boundingBox();
  expect(followedPreviewBox).not.toBeNull();
  expect(Math.abs(followedPreviewBox!.x - firstPreviewBox!.x)
    + Math.abs(followedPreviewBox!.y - firstPreviewBox!.y)).toBeGreaterThan(2);

  await page.mouse.down();
  await page.mouse.up();
  await expect(icon).toBeFocused();
  await page.mouse.move(4, 4);
  await page.waitForTimeout(260);

  const focusedIconBox = await icon.boundingBox();
  const keyboardPreviewBox = await page.locator(PREVIEW).boundingBox();
  expect(focusedIconBox).not.toBeNull();
  expect(keyboardPreviewBox).not.toBeNull();
  const keyboardTargetX = focusedIconBox!.x + focusedIconBox!.width;
  const keyboardTargetY = focusedIconBox!.y + (focusedIconBox!.height / 2);
  const horizontalGap = Math.min(
    Math.abs(keyboardPreviewBox!.x - keyboardTargetX),
    Math.abs(
      keyboardPreviewBox!.x
      + keyboardPreviewBox!.width
      - keyboardTargetX
    )
  );
  const verticalGap = Math.min(
    Math.abs(keyboardPreviewBox!.y - keyboardTargetY),
    Math.abs(
      keyboardPreviewBox!.y
      + keyboardPreviewBox!.height
      - keyboardTargetY
    )
  );
  expect(Math.min(horizontalGap, verticalGap)).toBeLessThanOrEqual(20);
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
  await page.locator(HOME).evaluate((home, previewSelector) => {
    const preview = home.querySelector(previewSelector);
    if (!preview) {
      throw new Error('缺少活动文件预览');
    }

    const history = [preview.getAttribute('data-motion-state') ?? 'missing'];
    Reflect.set(home, '__previewMotionHistory', history);
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
    observer.observe(home, {
      attributes: true,
      attributeFilter: ['data-motion-state'],
      childList: true,
      subtree: true
    });
    Reflect.set(home, '__previewMotionObserver', observer);
  }, PREVIEW);

  for (let index = 0; index < 9; index += 1) {
    await page.keyboard.press('PageDown');
  }

  await expect(page.locator(HOME)).toHaveAttribute('data-progress', '1.0000');
  await expect(page.locator(PREVIEW)).toHaveCount(0);
  await expect(page.locator(SWARM)).toHaveCount(0);
  await expect.poll(
    () => page.locator(HOME).evaluate(
      (home) => Reflect.get(home, '__previewMotionHistory') as string[]
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
  await expect(page.getByRole('heading', { name: 'AI Pet' })).toHaveCSS('color', 'rgb(28, 28, 28)');

  await expect(page.locator('[data-testid="brand-logo"]')).toBeVisible();
  await expect(page.locator('[data-testid="brand-logo"]')).toHaveCSS('filter', 'none');
  for (const piece of await pieces.all()) {
    await expect(piece).toBeHidden();
  }

  await expect.poll(() => page.locator(ICON).count(), { timeout: 6_000 }).toBeGreaterThanOrEqual(2);
  await page.mouse.move(720, 450);
  await page.waitForTimeout(180);

  const brandTransform = page.getByRole('heading', { name: 'AI Pet' }).locator('..');
  const brandBox = await brandTransform.boundingBox();
  expect(brandBox).not.toBeNull();
  expect(Math.abs(brandBox!.x + brandBox!.width / 2 - 720)).toBeLessThanOrEqual(28);
  expect(Math.abs(brandBox!.y + brandBox!.height / 2 - 450)).toBeLessThanOrEqual(28);

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
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await expect(page.locator('[data-chapter-id]')).toHaveCount(5);

  const donationSection = page.locator('[data-chapter-id="donation"]');
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (await donationSection.getAttribute('data-interactive') === 'true') {
      break;
    }
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'PageDown',
        bubbles: true,
        cancelable: true
      }));
    });
    await page.waitForTimeout(400);
  }
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
    ['home', page.getByRole('heading', { name: 'AI Pet', exact: true }).locator('..')],
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

test('Canvas 轨迹产生真实像素、旧轨迹衰减且缓冲区 DPR 上限为 1.75', async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: WEBSITE_URL,
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
  await expect(page.getByRole('heading', { name: 'AI Pet' })).toBeVisible();
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
