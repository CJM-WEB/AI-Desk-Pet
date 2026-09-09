import { access, readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const settingsViewUrl = new URL(
  '../src/renderer/src/settings/SettingsView.tsx',
  import.meta.url
);
const mcpSettingsUrl = new URL(
  '../src/renderer/src/settings/McpSettings.tsx',
  import.meta.url
);

describe('Renderer MCP 正式生产边界', () => {
  test('设置入口不再引用 MCP 组件、回调或恒假能力开关', async () => {
    const source = await readFile(settingsViewUrl, 'utf8');

    expect(source).not.toMatch(/McpSettings|mcpActions|McpLaunch|desktopRuntimeCapabilities/u);
    await expect(access(mcpSettingsUrl)).rejects.toThrow();
  });
});
