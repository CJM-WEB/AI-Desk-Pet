import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { createE2eCharacterDialogAdapter } from '../src/main/characters/e2e-character-dialogs';

describe('角色工作室 E2E 对话框适配器', () => {
  test('按固定队列返回临时素材、安全包、恶意包和单次导出目标', async () => {
    const adapter = createE2eCharacterDialogAdapter({
      userDataDirectory: 'temp/user-data',
      authorizedRootDirectory: 'temp/root',
      characterAssetsDirectory: 'temp/assets',
      safeCharacterPackage: 'temp/packages/safe.zip',
      maliciousCharacterPackage: 'temp/packages/malicious.zip',
      characterExportDestination: 'temp/exports/role.zip'
    });

    await expect(adapter.chooseSources()).resolves.toEqual({
      canceled: false,
      filePaths: [join('temp/assets', 'idle.png')]
    });
    await expect(adapter.chooseSources()).resolves.toEqual({
      canceled: false,
      filePaths: [join('temp/assets', 'carrying.png')]
    });
    await expect(adapter.choosePackage()).resolves.toEqual({
      canceled: false,
      filePaths: ['temp/packages/safe.zip']
    });
    await expect(adapter.choosePackage()).resolves.toEqual({
      canceled: false,
      filePaths: ['temp/packages/malicious.zip']
    });
    await expect(adapter.chooseExportDestination()).resolves.toEqual({
      canceled: false,
      filePath: 'temp/exports/role.zip'
    });
    await expect(adapter.chooseExportDestination()).resolves.toEqual({
      canceled: true
    });
  });
});
