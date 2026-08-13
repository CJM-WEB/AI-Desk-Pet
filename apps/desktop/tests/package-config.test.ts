import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import packageJson from '../package.json';

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
    expect(extraResources.match(/^\s*- from:/gmu)).toHaveLength(3);
    expect(extraResources).toContain('- from: resources/windows/explorer-space-bridge.ps1');
    expect(extraResources).toContain('- from: resources/windows/explorer-space-shell-tab-helper.cs');
    expect(extraResources).toContain('- from: resources/windows/explorer-space-integrity.json');
    expect(extraResources).not.toMatch(/userData|authorized|habitat|characters/iu);

    const files = readSection(configText, 'files');
    expect(files).toContain('- resources/characters/default/**/*');
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
