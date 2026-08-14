import { readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { expect, test } from 'vitest';
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

/** Desktop E2E 的唯一入口契约：配置负责 spec 归属，门禁脚本负责调用该入口。 */
test('每个 Desktop E2E spec 都由一个显式入口拥有且 verify:desktop 可达全部门禁', () => {
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

  expect(desktopMatches).toEqual([
    'desktop-settings-layout.spec.ts',
    'desktop.spec.ts'
  ]);
  expect(new Set(desktopMatches).size).toBe(desktopMatches.length);
  expect(desktopMatches).not.toContain('website.spec.ts');
  expect(websiteMatches).toContain('website.spec.ts');

  const desktopCandidates = allE2eSpecs.filter(
    fileName => !websiteMatches.includes(fileName)
  );
  expect(desktopMatches).toEqual(desktopCandidates.sort());

  expect(scripts['test:e2e:desktop']).toContain(
    'playwright test --config tests/playwright.config.ts'
  );
  expect(scripts['test:e2e:desktop']).not.toMatch(/tests\/e2e\/.*\.spec\.ts/u);
  expect(countCommand(scripts['verify:desktop'], 'pnpm test:security')).toBe(1);
  expect(countCommand(scripts['verify:desktop'], 'pnpm test:integration')).toBe(1);
  expect(countCommand(scripts['verify:desktop'], 'pnpm test:e2e:desktop')).toBe(1);
  expect(scripts['test:security']).toContain('--config tests/vitest.config.ts');
  expect(scripts['test:integration']).toContain('--config tests/vitest.config.ts');
});
