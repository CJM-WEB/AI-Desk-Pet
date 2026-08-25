import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import packageJson from '../package.json';

const execFileAsync = promisify(execFile);

function readScalarBlock(text: string, key: string): string {
  const match = new RegExp(`^${key}:\\s*([^\\r\\n]+)`, 'mu').exec(text);
  if (!match?.[1]) throw new Error(`缺少 ${key} 配置`);
  return match[1].trim();
}

function readSection(text: string, key: string): string {
  const lines = text.split(/\r?\n/u);
  const startIndex = lines.findIndex(line => line === `${key}:`);
  if (startIndex < 0) throw new Error(`缺少 ${key} 配置段`);

  const sectionLines: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (/^\S[^:]*:/u.test(line)) break;
    sectionLines.push(line);
  }
  return sectionLines.join('\n');
}

describe('electron-builder 配置', () => {
  test('桌面端包声明安装包所需版本和描述', () => {
    expect(packageJson.version).toBe('0.1.0-alpha.1');
    expect(packageJson.description).toBe('AI Pet 第一阶段 Windows AI 桌宠 Alpha');
  });

  test('生成未签名的用户级 Windows x64 NSIS 安装包', async () => {
    const configText = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8');

    expect(readScalarBlock(configText, 'appId')).toBe('com.myself.desktop');
    expect(readScalarBlock(configText, 'productName')).toBe('AI Pet');
    expect(readScalarBlock(configText, 'artifactName')).toBe('AI-Pet-${version}-windows-${arch}.${ext}');

    const windowsConfig = readSection(configText, 'win');
    expect(windowsConfig).toContain('target: nsis');
    expect(windowsConfig).toContain('arch:');
    expect(windowsConfig).toContain('- x64');
    expect(windowsConfig).toContain('signAndEditExecutable: false');
    expect(windowsConfig).toContain('icon: resources/icon.ico');

    const nsisConfig = readSection(configText, 'nsis');
    expect(nsisConfig).toContain('oneClick: false');
    expect(nsisConfig).toContain('perMachine: false');
    expect(nsisConfig).toContain('deleteAppDataOnUninstall: false');

    const extraResources = readSection(configText, 'extraResources');
    expect([...extraResources.matchAll(/^\s*- from:\s*(.+)$/gmu)].map(match => match[1]?.trim())).toEqual([
      'resources/windows/explorer-space-bridge.ps1',
      'resources/windows/explorer-space-shell-tab-helper.cs',
      'resources/windows/explorer-space-integrity.json',
      'resources/local-model'
    ]);
    expect(extraResources).toContain('- from: resources/local-model\n    to: local-model');
    expect(extraResources).not.toMatch(/userData|authorized|habitat|characters/iu);

    const files = readSection(configText, 'files');
    expect(files).toContain('- resources/characters/default/**/*');
  });

  test('Windows 打包先校验固定本地模型资源且普通构建不触发暂存', () => {
    const packageWindows = packageJson.scripts['package:win'];

    expect(packageJson.scripts['stage:local-model']).toBe('node scripts/stage-local-model.mjs');
    expect(packageJson.scripts['verify:local-model-assets'])
      .toBe('node scripts/verify-local-model-assets.mjs');
    const verifierIndex = packageWindows.indexOf('pnpm verify:local-model-assets');
    const builderIndex = packageWindows.indexOf('electron-builder');
    expect(verifierIndex).toBeGreaterThanOrEqual(0);
    expect(builderIndex).toBeGreaterThan(verifierIndex);
    expect(packageJson.scripts.build).not.toMatch(/stage:local-model|stage-local-model/iu);
  });

  test('固定发行文本在 Windows checkout 保持 LF 以稳定 manifest 哈希', async () => {
    const repositoryRoot = new URL('../../..', import.meta.url);
    const paths = [
      'apps/desktop/resources/local-model/THIRD-PARTY-NOTICES.txt',
      'apps/desktop/resources/local-model/licenses/llama.cpp-LICENSE.txt',
      'apps/desktop/resources/local-model/licenses/Qwen3.5-4B-LICENSE.txt'
    ];
    const { stdout } = await execFileAsync('git', ['check-attr', 'eol', '--', ...paths], {
      cwd: repositoryRoot
    });

    expect(stdout.trim().split(/\r?\n/u)).toEqual(paths.map(path => `${path}: eol: lf`));
  });

  test('Windows 图标包含 256 像素资源', async () => {
    const icon = await readFile(new URL('../resources/icon.ico', import.meta.url));
    expect(icon.readUInt16LE(0)).toBe(0);
    expect(icon.readUInt16LE(2)).toBe(1);
    const imageCount = icon.readUInt16LE(4);
    const widths = Array.from({ length: imageCount }, (_, index) => {
      const widthByte = icon.readUInt8(6 + index * 16);
      return widthByte === 0 ? 256 : widthByte;
    });
    const heights = Array.from({ length: imageCount }, (_, index) => {
      const heightByte = icon.readUInt8(7 + index * 16);
      return heightByte === 0 ? 256 : heightByte;
    });

    expect(Math.max(...widths)).toBeGreaterThanOrEqual(256);
    expect(Math.max(...heights)).toBeGreaterThanOrEqual(256);
  });

  test('生产桥源码只从应用固定资源根加载', async () => {
    const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = main.indexOf('const explorerResourceRoot =');
    const end = main.indexOf('const explorerLayer =', start);
    const bridgeSetup = main.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(bridgeSetup).toContain('process.resourcesPath');
    expect(bridgeSetup).toContain("join(__dirname, '../../resources')");
    expect(bridgeSetup).not.toMatch(/userData|authorized|habitat|characters/iu);
  });
});

describe('MCP 正式产物构建边界', () => {
  test('SDK 不属于桌面端生产依赖', () => {
    expect(packageJson.dependencies).not.toHaveProperty('@modelcontextprotocol/sdk');
  });

  test('保留的 MCP 内部模块使用固定版本开发依赖', () => {
    expect(packageJson.devDependencies).toHaveProperty('@modelcontextprotocol/sdk', '1.29.0');
  });

  test('桌面构建会执行 MCP 正式产物校验器', () => {
    expect(packageJson.scripts.build).toContain('verify-production-mcp-boundary.mjs');
  });

  test('Main 显式保留 SDK 包名供 fail-closed 门禁检测', async () => {
    const configText = await readFile(new URL('../electron.vite.config.ts', import.meta.url), 'utf8');
    const mainStart = configText.indexOf('main:');
    const preloadStart = configText.indexOf('preload:', mainStart);
    const mainExternalizeSection = configText.slice(mainStart, preloadStart);

    expect(mainStart).toBeGreaterThanOrEqual(0);
    expect(preloadStart).toBeGreaterThan(mainStart);
    expect(mainExternalizeSection).toContain("include: ['@modelcontextprotocol/sdk']");
  });
});
