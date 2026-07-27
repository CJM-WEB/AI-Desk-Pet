import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startProviderServer, type ProviderStep } from '../fixtures/provider-server';
import { createElectronAppFixture } from '../fixtures/electron-app';

function toolResponse(
  requestId: string,
  toolName: string,
  arguments_: Record<string, unknown>
): ProviderStep['response'] {
  return {
    type: 'tool_request',
    request: { requestId, toolName, arguments: arguments_ }
  };
}

function lastToolResult(request: Parameters<NonNullable<ProviderStep['inspect']>>[0]): unknown {
  const message = request.messages.at(-1);
  if (!message || message.role !== 'tool') throw new Error('缺少工具结果消息');
  return JSON.parse(message.content) as unknown;
}

async function waitForPage(
  pages: () => Page[],
  view: 'pet' | 'chat' | 'settings'
): Promise<Page> {
  await expect.poll(() => pages().some(page => {
    try {
      return new URL(page.url()).searchParams.get('view') === view;
    } catch {
      return false;
    }
  })).toBe(true);
  const page = pages().find(candidate => (
    new URL(candidate.url()).searchParams.get('view') === view
  ));
  if (!page) throw new Error(`缺少 ${view} Renderer`);
  return page;
}

async function submitChat(page: Page, text: string): Promise<void> {
  await page.getByLabel('和我说点什么').fill(text);
  await page.getByRole('button', { name: '发送给 Myself' }).click();
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

    // 首帧可能是切换 tab 前的缓存表面；逐帧确认后再触发两次 compositor 更新。
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

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.describe('多 Provider 与 MCP 真实 Electron 流程', () => {
  test('设置、MCP read、写确认/取消、失败/取消、阶段与退出清理', async () => {
    test.setTimeout(70_000);
    const providerSteps: ProviderStep[] = [
      { response: { type: 'text', text: '连接成功' } },
      {
        response: toolResponse(
          'mcp-echo',
          'mcp.local-tools.echo',
          { text: '来自 MCP 的结果' }
        ),
        inspect: request => {
          if (!request.tools.some(tool => tool.function.name === 'mcp.local-tools.echo')) {
            throw new Error('模型上下文缺少 MCP read 工具');
          }
        }
      },
      {
        response: { type: 'text', text: 'MCP 已返回结果。' },
        inspect: request => {
          if (!JSON.stringify(lastToolResult(request)).includes('来自 MCP 的结果')) {
            throw new Error('MCP 工具结果未回到模型上下文');
          }
        }
      },
      {
        response: toolResponse(
          'create-confirmed',
          'builtin.files.create_file',
          { relativePath: 'confirmed.txt' }
        )
      },
      { response: { type: 'text', text: '确认文件已创建。' } },
      {
        response: toolResponse(
          'create-cancelled',
          'builtin.files.create_file',
          { relativePath: 'cancelled.txt' }
        )
      },
      {
        delayMs: 3_000,
        response: { type: 'text', text: '这条慢响应不应显示。' }
      }
    ];
    const provider = await startProviderServer(providerSteps);
    const fixture = await createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: provider.apiKey,
      launchTimeoutMs: 20_000
    });
    const pages = (): Page[] => fixture.browser.contexts().flatMap(context => context.pages());
    const mcpFixturePath = resolve(
      process.cwd(),
      'apps/desktop/tests/fixtures/mcp-test-server.ts'
    );
    const mcpPidFile = resolve(fixture.authorizedRootDirectory, 'mcp.pid');
    let mcpPid: number | null = null;

    try {
      const petPage = await waitForPage(pages, 'pet');
      const chatPage = await waitForPage(pages, 'chat');
      const settingsPage = await waitForPage(pages, 'settings');
      for (const page of [petPage, chatPage, settingsPage]) page.setDefaultTimeout(8_000);

      console.log('E2E_MILESTONE:provider-settings');
      await settingsPage.getByLabel('自定义').check();
      await settingsPage.getByText('高级设置', { exact: true }).click();
      await settingsPage.getByLabel('档案名称').fill('本地 Provider');
      await settingsPage.getByLabel('Base URL').fill(provider.baseUrl);
      await settingsPage.getByLabel('Model ID').fill('e2e-model');
      await settingsPage.getByLabel('API Key', { exact: true }).fill(provider.apiKey);
      await settingsPage.getByLabel('额外参数（JSON）').fill('{');
      await settingsPage.getByRole('button', { name: '保存档案' }).click();
      await expect(settingsPage.getByRole('alert')).toContainText('额外参数必须是');
      await settingsPage.getByLabel('额外参数（JSON）').fill('{}');
      await settingsPage.getByRole('button', { name: '保存档案' }).click();
      await expect(settingsPage.getByText('模型档案已保存。')).toBeVisible();

      await settingsPage.getByRole('button', { name: '测试 本地 Provider 连接' }).click();
      await expect(settingsPage.getByText('连接成功。')).toBeVisible();
      await settingsPage.getByRole('combobox', { name: '主模型', exact: true })
        .selectOption({ label: '本地 Provider' });
      await settingsPage.getByRole('combobox', { name: 'Agent 模型', exact: true })
        .selectOption({ label: '本地 Provider' });
      await settingsPage.getByRole('button', { name: '保存路由' }).click();
      await expect(settingsPage.getByText('模型路由已保存。')).toBeVisible();

      console.log('E2E_MILESTONE:privacy-root');
      await settingsPage.getByRole('button', { name: '隐私' }).click();
      await settingsPage.getByLabel('文件数据授权').check();
      await settingsPage.getByRole('button', { name: '保存隐私设置' }).click();
      await expect(settingsPage.getByText('隐私设置已保存。')).toBeVisible();
      await settingsPage.getByRole('button', { name: '选择目录' }).click();
      await expect(settingsPage.getByText('授权目录已更新。')).toBeVisible();

      console.log('E2E_MILESTONE:mcp-config');
      await settingsPage.getByRole('button', { name: '工具' }).click();
      await settingsPage.getByLabel('服务 ID').fill('local-tools');
      await settingsPage.getByLabel('程序绝对路径').fill(process.execPath);
      await settingsPage.getByLabel('参数').fill(mcpFixturePath);
      await settingsPage.getByLabel('工作目录').fill(process.cwd());
      await settingsPage.getByLabel('环境变量名').fill('MCP_PID_FILE');
      await settingsPage.getByLabel('认证值').fill(mcpPidFile);
      await settingsPage.getByRole('button', { name: '添加服务' }).click();
      await expect(settingsPage.getByText('确认启动本地服务')).toBeVisible();
      await expect(settingsPage.getByRole('button', { name: '取消' })).toBeFocused();
      await settingsPage.keyboard.press('Escape');
      await expect(settingsPage.getByText('确认启动本地服务')).toHaveCount(0);
      await expect(settingsPage.getByText('已取消启动 MCP 服务。')).toBeVisible();
      await settingsPage.getByLabel('认证值').fill(mcpPidFile);
      await settingsPage.getByRole('button', { name: '添加服务' }).click();
      await expect(settingsPage.getByRole('button', { name: '取消' })).toBeFocused();
      await settingsPage.keyboard.press('Shift+Tab');
      await expect(settingsPage.getByRole('button', { name: '确认并保存' })).toBeFocused();
      await settingsPage.keyboard.press('Tab');
      await expect(settingsPage.getByRole('button', { name: '取消' })).toBeFocused();
      await expect(settingsPage.getByText(process.execPath, { exact: true })).toBeVisible();
      await expect(settingsPage.getByText('MCP_PID_FILE', { exact: true })).toBeVisible();
      await settingsPage.getByRole('button', { name: '确认并保存' }).click();
      await settingsPage.getByRole('button', { name: '测试 local-tools 连接' }).click();
      await expect(settingsPage.getByText('已连接')).toBeVisible();
      await expect(settingsPage.getByLabel('echo 工具开关')).toBeEnabled();
      await expect(settingsPage.getByLabel('echo 工具开关')).not.toBeChecked();
      await settingsPage.getByLabel('echo 工具开关').click();
      await expect(settingsPage.getByText('确认本地只读授权')).toBeVisible();
      await settingsPage.getByRole('button', {
        name: '我确认该工具仅执行只读操作'
      }).click();
      await expect(settingsPage.getByText(
        '本地只读授权已保存，工具已启用。'
      )).toBeVisible();
      await expect(settingsPage.getByLabel('echo 工具开关')).toBeChecked();
      console.log('E2E_MILESTONE:mcp-connected');

      console.log('E2E_MILESTONE:chat-mcp');
      await submitChat(chatPage, '调用 MCP echo');
      await expect(chatPage.getByText('MCP 已返回结果。')).toBeVisible();
      mcpPid = Number(await readFile(mcpPidFile, 'utf8'));
      expect(isProcessRunning(mcpPid)).toBe(true);
      await expect(petPage.locator('.pet-character')).toHaveAttribute('data-state', 'success');

      console.log('E2E_MILESTONE:write-confirm');
      await submitChat(chatPage, '创建 confirmed.txt');
      const confirmedCard = chatPage.getByRole('region', { name: '创建文件 confirmed.txt' });
      await confirmedCard.getByRole('button', { name: '确认创建文件' }).click();
      await expect(chatPage.getByText('确认文件已创建。')).toBeVisible();
      const confirmedPath = resolve(fixture.authorizedRootDirectory, 'confirmed.txt');
      await expect.poll(async () => {
        try {
          await readFile(confirmedPath);
          return true;
        } catch {
          return false;
        }
      }).toBe(true);

      await submitChat(chatPage, '创建 cancelled.txt');
      const cancelledCard = chatPage.getByRole('region', { name: '创建文件 cancelled.txt' });
      await cancelledCard.getByRole('button', { name: '先不创建' }).click();
      await expect(cancelledCard).toHaveCount(0);
      await expect(readFile(
        resolve(fixture.authorizedRootDirectory, 'cancelled.txt')
      )).rejects.toMatchObject({ code: 'ENOENT' });

      console.log('E2E_MILESTONE:cancel-active');
      await submitChat(chatPage, '开始一个慢任务');
      await expect(chatPage.getByRole('button', { name: '停止当前任务' })).toBeVisible();
      await chatPage.getByRole('button', { name: '停止当前任务' }).click();
      await expect(chatPage.getByText('已经停下')).toBeVisible();
      await expect(chatPage.getByText('这条慢响应不应显示。')).toHaveCount(0);

      console.log('E2E_MILESTONE:provider-failure');
      await submitChat(chatPage, '触发 Provider 失败');
      await expect(chatPage.getByText('模型服务发生错误，请稍后重试。')).toBeVisible();
      await expect(petPage.locator('.pet-character')).toHaveAttribute('data-state', 'error');

      expect(provider.inspectionErrors).toEqual([]);
      provider.assertComplete();
      const captured = fixture.logs.join('\n');
      expect(captured).not.toContain(provider.apiKey);
      expect(captured).not.toContain(fixture.authorizedRootDirectory);
      expect(captured).not.toMatch(/authorization\s*:/iu);
      console.log('E2E_MILESTONE:cleanup');
    } finally {
      await fixture.dispose();
      await provider.close();
    }

    expect(mcpPid).not.toBeNull();
    if (mcpPid !== null) {
      await expect.poll(() => isProcessRunning(mcpPid!), { timeout: 10_000 }).toBe(false);
    }
  });

  for (const viewport of [
    { width: 720, height: 620 },
    { width: 640, height: 520 }
  ]) {
    test(`设置页 ${viewport.width}x${viewport.height} 无溢出`, async ({}, testInfo) => {
      test.setTimeout(30_000);
      const fixture = await createElectronAppFixture({
        workspaceRoot: resolve(process.cwd()),
        apiKey: 'visual-test-key',
        launchTimeoutMs: 15_000,
        enableSoftwareRasterizer: true
      });
      try {
        const settingsPage = await waitForPage(
          () => fixture.browser.contexts().flatMap(context => context.pages()),
          'settings'
        );
        settingsPage.setDefaultTimeout(8_000);
        await settingsPage.setViewportSize(viewport);
        for (const tab of ['模型', '工具', '隐私', '本地数据']) {
          await settingsPage.getByRole('button', { name: tab, exact: true }).click();
          await assertNoHorizontalOverflow(settingsPage);
          await assertNoClippedTextOrControlOverlap(settingsPage);
        }
        const modelTab = settingsPage.getByRole('button', { name: '模型', exact: true });
        await modelTab.click();
        await expect(modelTab).toHaveAttribute('aria-current', 'page');
        await expect(settingsPage.getByRole('heading', { name: '模型档案' })).toBeVisible();
        const screenshotPath = testInfo.outputPath(
          `settings-${viewport.width}x${viewport.height}.png`
        );
        const image = await capturePageViaCdp(settingsPage, screenshotPath);
        expect(image.readUInt32BE(16)).toBe(viewport.width);
        expect(image.readUInt32BE(20)).toBe(viewport.height);
      } finally {
        await fixture.dispose();
      }
    });
  }
});
