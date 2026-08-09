import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const mainUrl = new URL('../src/main/index.ts', import.meta.url);
const integrityUrl = new URL(
  '../resources/windows/explorer-space-integrity.json',
  import.meta.url
);

function ordered(source: string, markers: readonly string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const current = source.indexOf(marker, previous + 1);
    expect(current, `缺少顺序标记：${marker}`).toBeGreaterThan(previous);
    previous = current;
  }
}

describe('目录空间生产 Main 组合根', () => {
  test('启动先恢复稳定空间，再初始化角色运行时，并仅在 desktop 稳定态显示', async () => {
    const source = await readFile(mainUrl, 'utf8');

    ordered(source, [
      'createPetWindow(',
      'new PetHabitatStore(',
      'await habitatStore.load()',
      "habitatSnapshot.location.kind === 'desktop'",
      'new CharacterMotionService(',
      'new CharacterBehaviorService(',
      'await characterBehavior.initialize()',
      "habitatService.snapshot().state === 'desktop'",
      'pet.show()'
    ]);
    expect(source).toContain("petPositionController.setPersistenceMode('folder')");
    expect(source).toContain('await explorer.startObserving()');
  });

  test('组合根复用既有空间服务、窗口控制器、设置 IPC、托盘呼唤和自动策略', async () => {
    const source = await readFile(mainUrl, 'utf8');

    for (const marker of [
      'new ExplorerSpaceClient(',
      'new ExplorerWindowLayerController(',
      'new HabitatWindowController(',
      'new HabitatService(',
      'new HabitatSettingsService(',
      'registerHabitatIpc(',
      'createPetSummonController(',
      'buildHabitatTrayMenu(',
      'new HabitatAutonomyPolicy('
    ]) {
      expect(source, `生产 Main 应复用 ${marker}`).toContain(marker);
    }
  });

  test('关闭严格先停自动调度和空间服务，再等桥退出、刷新双坐标，最后关闭其他服务', async () => {
    const source = await readFile(mainUrl, 'utf8');

    ordered(source, [
      'clearInterval(habitatAutonomyTimer)',
      'await habitatService.close()',
      'await habitatWindowController.dispose()',
      'await explorer.close()',
      'await petPositionController.flush()',
      'await desktopSettingsService.close()',
      'characterBehavior.close()',
      'activeAgentService?.close()'
    ]);
  });

  test('生产桥启动前验证固定清单中的两个资源 SHA-256', async () => {
    const manifest = JSON.parse(await readFile(integrityUrl, 'utf8')) as {
      version: number;
      files: Record<string, string>;
    };
    expect(manifest).toEqual({
      version: 1,
      files: {
        'explorer-space-bridge.ps1': expect.stringMatching(/^[a-f0-9]{64}$/u),
        'explorer-space-shell-tab-helper.cs': expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    });

    for (const [name, expected] of Object.entries(manifest.files)) {
      const content = await readFile(new URL(`../resources/windows/${name}`, import.meta.url));
      expect(createHash('sha256').update(content).digest('hex')).toBe(expected);
    }

    const source = await readFile(mainUrl, 'utf8');
    ordered(source, [
      'await verifyExplorerSpaceResourceIntegrity(',
      'new ExplorerSpaceClient('
    ]);
  });

  test('完整性校验或恢复失败时保持隐藏并退出应用', async () => {
    const source = await readFile(mainUrl, 'utf8');
    const startup = source.slice(source.indexOf('app.whenReady()'));

    expect(startup).toContain('.catch(error =>');
    expect(startup).toContain("console.error('应用启动失败。', error)");
    expect(startup).toContain('app.quit()');
  });
});
