import { readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveConfig } from 'vitest/node';
import desktopPlaywrightConfig from '../../../tests/playwright.config';
import websitePlaywrightConfig from '../../../tests/playwright.website.config';

type PlaywrightConfigContract = {
  testMatch?: string | string[];
};

function normalizeTestMatch(testMatch: string | string[] | undefined): string[] {
  if (!testMatch) return [];
  return (Array.isArray(testMatch) ? testMatch : [testMatch])
    .map(match => basename(match))
    .sort();
}

function countCommand(script: string, command: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = script.indexOf(command, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + command.length;
  }
}

function requiredScript(scripts: Record<string, string>, name: string): string {
  const script = scripts[name];
  if (typeof script !== 'string') {
    expect.fail(`package.json 缺少必需脚本：${name}`);
  }
  return script;
}

/** Desktop E2E 的唯一入口契约：配置负责 spec 归属，门禁脚本负责调用该入口。 */
test('每个 Desktop E2E spec 都由一个显式入口拥有且 verify:desktop 可达全部门禁', async () => {
  const repositoryRoot = resolve(import.meta.dirname, '../../..');
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const allE2eSpecs = readdirSync(resolve(repositoryRoot, 'tests/e2e'))
    .filter(fileName => fileName.endsWith('.spec.ts'));
  const desktopMatches = normalizeTestMatch(
    (desktopPlaywrightConfig as PlaywrightConfigContract).testMatch
  );
  const websiteMatches = normalizeTestMatch(
    (websitePlaywrightConfig as PlaywrightConfigContract).testMatch
  );
  const scripts = packageJson.scripts;
  const testE2eDesktop = requiredScript(scripts, 'test:e2e:desktop');
  const verifyDesktop = requiredScript(scripts, 'verify:desktop');
  const testSecurity = requiredScript(scripts, 'test:security');
  const testIntegration = requiredScript(scripts, 'test:integration');

  expect(desktopMatches).toEqual([
    'character-event-bindings.spec.ts',
    'character-motion-continuity.spec.ts',
    'chat-appearance.spec.ts',
    'chat-visual-presentation.spec.ts',
    'desktop-memory-lifecycle.spec.ts',
    'desktop-settings-layout.spec.ts',
    'desktop-style-loading.spec.ts',
    'desktop.spec.ts'
  ]);
  expect(new Set(desktopMatches).size).toBe(desktopMatches.length);
  expect(desktopMatches).not.toContain('website.spec.ts');
  expect(websiteMatches).toContain('website.spec.ts');

  const desktopCandidates = allE2eSpecs.filter(
    fileName => !websiteMatches.includes(fileName)
  );
  expect(desktopMatches).toEqual(desktopCandidates.sort());

  expect(testE2eDesktop).toContain(
    'playwright test --config tests/playwright.config.ts'
  );
  expect(testE2eDesktop).not.toMatch(/tests\/e2e\/.*\.spec\.ts/u);
  expect(countCommand(verifyDesktop, 'pnpm test:security')).toBe(1);
  expect(countCommand(verifyDesktop, 'pnpm test:integration')).toBe(1);
  expect(countCommand(verifyDesktop, 'pnpm test:e2e:desktop')).toBe(1);
  expect(testSecurity).toContain('--config tests/vitest.config.ts');
  expect(testIntegration).toContain('--config tests/vitest.config.ts');

  const desktopRoot = resolve(import.meta.dirname, '..');
  const { vitestConfig } = await resolveConfig({
    root: desktopRoot,
    config: resolve(desktopRoot, 'vitest.config.ts')
  });
  expect(vitestConfig.maxWorkers).toBe(4);
});
