import { resolve } from 'node:path';
import { resolveConfig } from 'vitest/node';
import { expect, test } from 'vitest';

/** 验证 Desktop 门禁使用 Vitest 实际解析后的固定文件 worker 上限，而非仅检查配置源码文本。 */
test('Desktop Vitest 解析后固定使用四个文件 worker', async () => {
  const desktopRoot = resolve(import.meta.dirname, '..');
  const { vitestConfig } = await resolveConfig({
    root: desktopRoot,
    config: resolve(desktopRoot, 'vitest.config.ts')
  });

  expect(vitestConfig.maxWorkers).toBe(4);
});
