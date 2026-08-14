import { readdirSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

function normalizePath(filePath: string): string {
  const normalized = resolve(filePath).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [entryPath] : [];
  });
}

describe('Desktop TypeScript 配置', () => {
  test('纳入 tests 下全部 .ts 与 .tsx 源码', () => {
    const testFilePath = fileURLToPath(import.meta.url);
    const desktopDirectory = resolve(dirname(testFilePath), '..');
    const tsconfigPath = resolve(desktopDirectory, 'tsconfig.json');
    const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    const parsedConfig = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      desktopDirectory
    );
    const configuredFiles = new Set(parsedConfig.fileNames.map(normalizePath));
    const missingTestFiles = collectTypeScriptFiles(resolve(desktopDirectory, 'tests'))
      .filter(filePath => !configuredFiles.has(normalizePath(filePath)))
      .map(filePath => relative(desktopDirectory, filePath));

    expect(missingTestFiles).toEqual([]);
  });
});
