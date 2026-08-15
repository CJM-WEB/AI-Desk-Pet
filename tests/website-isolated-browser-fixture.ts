import {
  devices,
  type Browser,
  type BrowserContextOptions,
  type BrowserType,
  type Page,
  type TestInfo,
} from '@playwright/test';

const { defaultBrowserType: _defaultBrowserType, ...desktopChrome } =
  devices['Desktop Chrome'];

export const WEBSITE_BROWSER_CONTEXT_OPTIONS = Object.freeze({
  ...desktopChrome,
  locale: 'zh-CN',
}) satisfies Readonly<BrowserContextOptions>;

interface IsolatedBrowserInput {
  browserType: BrowserType;
  headless: boolean;
  launchOptions: Parameters<BrowserType['launch']>[0];
}

interface IsolatedPageInput {
  browser: Browser;
  baseURL: string | undefined;
  testInfo: TestInfo;
}

function throwCollectedErrors(errors: unknown[]): void {
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, '隔离浏览器生命周期发生多个错误');
  }
}

/** 浏览器由本夹具独占，确保每次调用都释放其进程资源。 */
export async function useIsolatedBrowser(
  input: IsolatedBrowserInput,
  use: (browser: Browser) => Promise<void>,
): Promise<void> {
  const browser = await input.browserType.launch({
    ...input.launchOptions,
    headless: input.headless,
  });
  const errors: unknown[] = [];

  try {
    await use(browser);
  } catch (error) {
    errors.push(error);
  }

  try {
    await browser.close();
  } catch (error) {
    errors.push(error);
  }

  throwCollectedErrors(errors);
}

/** 上下文持有追踪诊断证据；非预期结果才将其写盘并附加到测试报告。 */
export async function useIsolatedPage(
  input: IsolatedPageInput,
  use: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await input.browser.newContext({
    ...WEBSITE_BROWSER_CONTEXT_OPTIONS,
    baseURL: input.baseURL,
  });
  const errors: unknown[] = [];
  let tracingStarted = false;

  try {
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    tracingStarted = true;
    await use(await context.newPage());
  } catch (error) {
    errors.push(error);
  }

  /** 清理失败不能覆盖主流程错误，全部错误由调用方获得。 */
  if (tracingStarted) {
    try {
      if (input.testInfo.status !== input.testInfo.expectedStatus) {
        const path = input.testInfo.outputPath('trace.zip');
        await context.tracing.stop({ path });
        await input.testInfo.attach('trace', {
          path,
          contentType: 'application/zip',
        });
      } else {
        await context.tracing.stop();
      }
    } catch (error) {
      errors.push(error);
    }
  }

  try {
    await context.close();
  } catch (error) {
    errors.push(error);
  }

  throwCollectedErrors(errors);
}
