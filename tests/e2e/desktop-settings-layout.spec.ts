import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createElectronAppFixture } from '../fixtures/electron-app';

async function waitForSettingsPage(pages: () => Page[]): Promise<Page> {
  await expect.poll(() => pages().some(page => {
    try {
      return new URL(page.url()).searchParams.get('view') === 'pet';
    } catch {
      return false;
    }
  })).toBe(true);
  const pet = pages().find(page => new URL(page.url()).searchParams.get('view') === 'pet');
  if (!pet) throw new Error('缺少 pet Renderer');
  await expect(pet.locator('#root > *').first()).toBeAttached();
  await pet.evaluate(() => window.myself.openSettings());
  await expect.poll(() => pages().some(page => {
    try {
      return new URL(page.url()).searchParams.get('view') === 'settings';
    } catch {
      return false;
    }
  })).toBe(true);
  const page = pages().find(candidate => (
    new URL(candidate.url()).searchParams.get('view') === 'settings'
  ));
  if (!page) throw new Error('缺少 settings Renderer');
  return page;
}

async function assertMcpSettingsEntryAbsent(page: Page): Promise<void> {
  await expect.poll(() => (
    page.locator('.settings-tabs').getByRole('button').allTextContents()
  )).toEqual(['模型', '隐私', '本地数据']);
  await expect(page.getByRole('button', { name: '工具' })).toHaveCount(0);
  await expect(page.getByText('MCP 服务', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('服务 ID')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '添加服务' })).toHaveCount(0);
}

async function assertLocalModelCardVisible(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: '内置本地模型' })).toBeVisible();
  await expect(page.getByRole('switch', { name: '启用内置本地模型' })).toHaveCount(1);
  await expect(page.getByText('开启期间聊天和 Agent 不调用云模型，无需API KEY', { exact: true })).toBeVisible();
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const overflowing = [...document.querySelectorAll('main *')]
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.left < -1 || rect.right > viewportWidth + 1);
      })
      .slice(0, 10)
      .map(element => `${element.tagName}.${element.className}`);
    return {
      viewportWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflowing
    };
  });
  expect(result.scrollWidth).toBeLessThanOrEqual(result.viewportWidth);
  expect(result.overflowing).toEqual([]);
}

async function assertNoClippedTextOrControlOverlap(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const visible = (element: Element): element is HTMLElement => {
      const htmlElement = element as HTMLElement;
      const rect = htmlElement.getBoundingClientRect();
      const style = getComputedStyle(htmlElement);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
    };
    const clipped = [...document.querySelectorAll('button, summary, strong, small, dt, dd')]
      .filter(visible)
      .filter(element => (
        element.scrollWidth > element.clientWidth + 1
        || element.scrollHeight > element.clientHeight + 1
      ))
      .slice(0, 10)
      .map(element => `${element.tagName}.${element.className}`);
    const overlaps: string[] = [];
    const containers = document.querySelectorAll(
      '.settings-tabs, .form-grid, .route-grid, .pane-heading, .profile-row, '
      + '.permission-row, .tool-row, .server-actions, .root-actions, .dialog-actions'
    );
    for (const container of containers) {
      const children = [...container.children].filter(visible);
      for (let leftIndex = 0; leftIndex < children.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < children.length; rightIndex += 1) {
          const left = children[leftIndex]!.getBoundingClientRect();
          const right = children[rightIndex]!.getBoundingClientRect();
          const overlapWidth = Math.min(left.right, right.right) - Math.max(left.left, right.left);
          const overlapHeight = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
          if (overlapWidth > 1 && overlapHeight > 1) {
            overlaps.push(`${container.className}:${leftIndex}-${rightIndex}`);
          }
        }
      }
    }
    return { clipped, overlaps: overlaps.slice(0, 10) };
  });
  expect(result.clipped).toEqual([]);
  expect(result.overlaps).toEqual([]);
}

// 失败时经 CDP 截取真实合成画面，保留布局问题的可复核证据。
async function capturePageViaCdp(page: Page, path: string): Promise<Buffer> {
  const session = await page.context().newCDPSession(page);
  let screencastStarted = false;
  try {
    await session.send('Page.bringToFront');
    const nextFrame = (): Promise<string> => new Promise((resolveFrame, rejectFrame) => {
      const timeout = setTimeout(() => {
        rejectFrame(new Error('CDP_SCREENCAST_TIMEOUT'));
      }, 8_000);
      session.once('Page.screencastFrame', event => {
        void (async () => {
          try {
            await session.send('Page.screencastFrameAck', {
              sessionId: event.sessionId
            });
            clearTimeout(timeout);
            resolveFrame(event.data);
          } catch (error) {
            clearTimeout(timeout);
            rejectFrame(error);
          }
        })();
      });
    });
    await session.send('Page.startScreencast', {
      format: 'png',
      quality: 100,
      maxWidth: page.viewportSize()?.width,
      maxHeight: page.viewportSize()?.height,
      everyNthFrame: 1
    });
    screencastStarted = true;

    await nextFrame();
    const previousOpacity = await session.send('Runtime.evaluate', {
      expression: 'document.body.style.opacity',
      returnByValue: true
    });
    const repaintOpacity = previousOpacity.result.value === '0.999' ? '0.998' : '0.999';
    const repaintedFrame = nextFrame();
    await session.send('Runtime.evaluate', {
      expression: `document.body.style.opacity = ${JSON.stringify(repaintOpacity)}`
    });
    await repaintedFrame;

    const restoredFrame = nextFrame();
    await session.send('Runtime.evaluate', {
      expression: `document.body.style.opacity = ${
        JSON.stringify(previousOpacity.result.value ?? '')
      }`
    });
    const image = Buffer.from(await restoredFrame, 'base64');
    await session.send('Page.stopScreencast');
    screencastStarted = false;
    await writeFile(path, image);
    return image;
  } finally {
    if (screencastStarted) {
      await session.send('Page.stopScreencast').catch(() => undefined);
    }
    await session.detach();
  }
}

test('720x620 默认尺寸下设置页无横向溢出且 MCP 入口不可见', async ({}, testInfo) => {
  test.setTimeout(30_000);
  const fixture = await createElectronAppFixture({
    workspaceRoot: resolve(process.cwd()),
    apiKey: 'visual-test-key',
    launchTimeoutMs: 15_000,
    enableSoftwareRasterizer: true
  });
  try {
    const settingsPage = await waitForSettingsPage(
      () => fixture.browser.contexts().flatMap(context => context.pages())
    );
    settingsPage.setDefaultTimeout(8_000);
    await settingsPage.setViewportSize({ width: 720, height: 620 });
    try {
      await assertMcpSettingsEntryAbsent(settingsPage);
      await assertLocalModelCardVisible(settingsPage);

      for (const tab of ['模型', '隐私', '本地数据']) {
        await settingsPage.getByRole('button', { name: tab }).click();
        await assertNoHorizontalOverflow(settingsPage);
        await assertNoClippedTextOrControlOverlap(settingsPage);
      }
    } catch (error) {
      await capturePageViaCdp(
        settingsPage,
        testInfo.outputPath('settings-720x620-failure.png')
      ).catch(() => undefined);
      throw error;
    }
  } finally {
    await fixture.dispose();
  }
});

test('640x520 最小尺寸下设置页无文字或控件重叠且 MCP 入口不可见', async ({}, testInfo) => {
  test.setTimeout(30_000);
  const fixture = await createElectronAppFixture({
    workspaceRoot: resolve(process.cwd()),
    apiKey: 'visual-test-key',
    launchTimeoutMs: 15_000,
    enableSoftwareRasterizer: true
  });
  try {
    const settingsPage = await waitForSettingsPage(
      () => fixture.browser.contexts().flatMap(context => context.pages())
    );
    settingsPage.setDefaultTimeout(8_000);
    await settingsPage.setViewportSize({ width: 640, height: 520 });
    try {
      await assertMcpSettingsEntryAbsent(settingsPage);
      await assertLocalModelCardVisible(settingsPage);

      for (const tab of ['模型', '隐私', '本地数据']) {
        await settingsPage.getByRole('button', { name: tab }).click();
        await assertNoHorizontalOverflow(settingsPage);
        await assertNoClippedTextOrControlOverlap(settingsPage);
      }
    } catch (error) {
      await capturePageViaCdp(
        settingsPage,
        testInfo.outputPath('settings-640x520-failure.png')
      ).catch(() => undefined);
      throw error;
    }
  } finally {
    await fixture.dispose();
  }
});
