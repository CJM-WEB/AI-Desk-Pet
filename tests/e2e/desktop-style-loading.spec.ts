import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect, test } from '@playwright/test';

test('视图拆包后保留原工作室与全局样式的最终级联', async () => {
  const output = resolve('apps/desktop/out/renderer');
  const html = await readFile(resolve(output, 'index.html'), 'utf8');
  const initial = [...html.matchAll(/href="\.\/([^"\s]+\.css)"/gu)].map(match => match[1]!);
  expect(initial.length).toBeGreaterThan(0);
  // 模拟正式入口先加载基础 CSS、视图再加载独有 CSS，直接使用实际构建产物。
  const deferred = (await readdir(resolve(output, 'assets')))
    .filter(name => /^CharacterWorkshopView-.*\.css$/u.test(name))
    .map(name => `assets/${name}`);
  const browser = await chromium.launch(process.platform === 'win32'
    ? { channel: 'msedge', headless: true } : { headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main class="character-workshop-shell"><div class="section-heading"><h2>动作</h2></div><div class="stage-heading"><h2>预览</h2></div><p class="field-help">说明</p></main>');
    for (const path of [...new Set([...initial, ...deferred])]) {
      await page.addStyleTag({ content: await readFile(resolve(output, path), 'utf8') });
    }
    const styles = await page.evaluate(() => {
      const css = (selector: string) => getComputedStyle(document.querySelector(selector)!);
      return {
        alignment: css('.section-heading').alignItems,
        headingSize: css('.section-heading h2').fontSize,
        previewSize: css('.stage-heading h2').fontSize,
        helpMargin: css('.field-help').margin,
        helpColor: css('.field-help').color
      };
    });
    expect(styles).toEqual({ alignment: 'flex-start', headingSize: '15px', previewSize: '13px',
      helpMargin: '3px 0px 0px', helpColor: 'rgb(104, 118, 129)' });
  } finally {
    await browser.close();
  }
});
