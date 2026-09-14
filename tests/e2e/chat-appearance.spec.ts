import { createRequire } from 'node:module';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect, test, type Browser } from '@playwright/test';

let browser: Browser;
let url: string;
test.beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-pet-appearance-'));
  const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
  await requireDesktop('esbuild').build({ entryPoints: [resolve('apps/desktop/tests/fixtures/chat-appearance.tsx')],
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    outfile: join(directory, 'fixture.js') });
  await writeFile(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>*{box-sizing:border-box}html,body{margin:0;background:transparent}button,textarea{font:inherit}</style><div id="root"></div><script src="fixture.js"></script>');
  url = pathToFileURL(join(directory, 'index.html')).href;
  browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
});
test.afterAll(async () => { await browser?.close(); });

test('选项向左展开且不遮输入，窄屏仍能完整点击', async () => {
  const page = await browser.newPage({ viewport: { width: 712, height: 800 }, reducedMotion: 'reduce' });
  try {
    await page.goto(url);
    await page.getByRole('button', { name: '选项', exact: true }).click();
    // 减少动态效果仍有一帧动画；完成后再核对最终几何，避免采到缩放中间态。
    await page.locator('[role="menu"]').evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished));
    });
    for (const width of [712, 528, 360]) {
      await page.setViewportSize({ width, height: 800 });
      const geometry = await page.locator('[role="menu"]').evaluate(menu => {
        const box = menu.getBoundingClientRect();
        const orb = document.querySelector('.island-orb')!.getBoundingClientRect();
        const input = document.querySelector('.island-input')!.getBoundingClientRect();
        return { left: box.left, right: box.right, orbLeft: orb.left, orbRight: orb.right, inputLeft: input.left, inputRight: input.right, viewport: innerWidth };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(12);
      expect(geometry.left).toBeLessThan(geometry.orbLeft);
      expect(geometry.right).toBeCloseTo(geometry.orbRight, 0);
      expect(geometry.right).toBeLessThan(geometry.inputLeft);
      expect(geometry.inputRight).toBeLessThan(geometry.viewport);
      for (const item of await page.getByRole('menuitem').all()) {
        expect(await item.evaluate(element => {
          const box = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        })).toBe(true);
      }
    }
  } finally { await page.close(); }
});

test('历史没有外层白底，消息保留阴影且可以滚动', async () => {
  const page = await browser.newPage({ viewport: { width: 712, height: 800 } });
  try {
    await page.goto(url);
    const history = page.getByRole('region', { name: '历史对话' });
    const style = await history.evaluate(element => {
      const css = getComputedStyle(element);
      return { background: css.backgroundColor, image: css.backgroundImage, border: css.borderTopWidth,
        shadow: css.boxShadow, messageShadow: getComputedStyle(element.querySelector('.message')!).boxShadow };
    });
    expect(style.background).toBe('rgba(0, 0, 0, 0)');
    expect(style.image).toBe('none');
    expect(style.border).toBe('0px');
    expect(style.shadow).toBe('none');
    expect(style.messageShadow).not.toBe('none');
    await history.hover(); await page.mouse.wheel(0, 200);
    await expect.poll(() => history.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  } finally { await page.close(); }
});

test('流式气泡保持现有宽度，最多四行并能滚动到完整末尾', async () => {
  const page = await browser.newPage({ viewport: { width: 464, height: 700 }, reducedMotion: 'reduce' });
  try {
    await page.goto(`${url}#bubble`);
    await expect.poll(() => page.evaluate(() => typeof Reflect.get(window, 'appearanceReply'))).toBe('function');
    const reply = async (text: string) => {
      await page.evaluate(value => Reflect.get(window, 'appearanceReply')(value), text);
      await expect(page.locator('.speech-text')).toHaveText(text);
    };
    await reply('短回复');
    const initial = await page.locator('.pet-speech').boundingBox();
    await reply('第一行\n第二行\n第三行\n第四行\n第五行\n完整末尾');
    const text = page.locator('.speech-text');
    const metrics = await text.evaluate(element => {
      const css = getComputedStyle(element);
      return { lines: (element.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom)) / parseFloat(css.lineHeight), scroll: element.scrollHeight > element.clientHeight };
    });
    expect(metrics.lines).toBeCloseTo(4, 1);
    expect(metrics.scroll).toBe(true);
    expect((await page.locator('.pet-speech').boundingBox())!.height).toBeGreaterThan(initial!.height);
    const cappedHeight = (await page.locator('.pet-speech').boundingBox())!.height;
    await reply('保持目前宽度并验证自动换行。'.repeat(80) + '完整末尾');
    const box = (await page.locator('.pet-speech').boundingBox())!;
    expect(box.width).toBe(440);
    expect(box.height).toBeCloseTo(cappedHeight, 0);
    await text.hover(); await page.mouse.wheel(0, 10000);
    await expect.poll(() => text.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
  } finally { await page.close(); }
});
