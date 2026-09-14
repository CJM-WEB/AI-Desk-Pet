import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { createElectronAppFixture } from '../fixtures/electron-app';

const execFileAsync = promisify(execFile);

/** 只定位本夹具 PID 与合成标题，模拟原生关闭并观察窗口是否仍保留。 */
async function ownNativeWindow(processId: number, view: 'settings' | 'characters', close = false): Promise<{ exists: boolean; visible: boolean; handle: number }> {
  if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('MEMORY_FIXTURE_PID_INVALID');
  const title = `Myself-Memory-E2E-${view}`;
  const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MemoryWindowProbe {
  public delegate bool EnumProc(IntPtr hwnd,IntPtr unused);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc,IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr w,IntPtr l);
  public static IntPtr Find(uint owner,string title) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((hwnd,unused)=> { uint pid; GetWindowThreadProcessId(hwnd,out pid);
      var text=new StringBuilder(256); GetWindowText(hwnd,text,256);
      if(pid==owner && text.ToString()==title){found=hwnd;return false;} return true;
    },IntPtr.Zero); return found;
  }
}
'@
$handle=[MemoryWindowProbe]::Find(${processId},'${title}')
${close ? "if($handle -eq [IntPtr]::Zero){throw 'MEMORY_OWN_WINDOW_MISSING'}; if(-not [MemoryWindowProbe]::PostMessage($handle,0x10,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'MEMORY_CLOSE_FAILED'}" : ''}
ConvertTo-Json -Compress @{exists=$handle -ne [IntPtr]::Zero;visible=[MemoryWindowProbe]::IsWindowVisible($handle);handle=$handle.ToInt64()}
`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000, encoding: 'utf8' });
  return JSON.parse(stdout.trim());
}

function viewOf(page: Page): string | null {
  try {
    return new URL(page.url()).searchParams.get('view');
  } catch {
    return null;
  }
}

test('冷启动按需建窗，首次并发打开唯一且隐藏重开保留未提交界面', async () => {
  test.setTimeout(45_000);
  const fixture = await createElectronAppFixture({
    workspaceRoot: resolve(process.cwd()),
    apiKey: 'memory-lifecycle-fixture-key',
    launchTimeoutMs: 15_000,
    enableSoftwareRasterizer: true
  });
  try {
    const browser = fixture.browser as Browser;
    const pages = () => browser.contexts().flatMap(context => context.pages());
    const pagesFor = (view: string) => pages().filter(page => viewOf(page) === view);
    const waitForView = async (view: string): Promise<Page> => {
      await expect.poll(() => pagesFor(view).length).toBe(1);
      const page = pagesFor(view)[0]!;
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
      return page;
    };

    // 直接检查真实 Electron CDP 页面，隐藏的预建窗口同样会被计入。
    await expect.poll(() => pages().map(viewOf).filter(Boolean).sort())
      .toEqual(['bubble', 'chat', 'pet']);
    const pet = pagesFor('pet')[0]!;
    await expect(pet.locator('#root > *').first()).toBeAttached();
    await pet.evaluate(() => Promise.all([
      window.myself.openSettings(),
      window.myself.openSettings(),
      window.myself.openSettings()
    ]));
    const settings = await waitForView('settings');
    expect(pagesFor('characters')).toHaveLength(0);
    const syntheticKey = 'synthetic-unsaved-memory-key';
    await settings.getByLabel('API Key', { exact: true }).fill(syntheticKey);
    await settings.evaluate(() => { document.title = 'Myself-Memory-E2E-settings'; });
    const settingsNative = await ownNativeWindow(fixture.processId, 'settings');

    // 关闭只隐藏，保留同一 Renderer 的未保存字段，不执行保存或模型调用。
    await ownNativeWindow(fixture.processId, 'settings', true);
    await expect.poll(() => ownNativeWindow(fixture.processId, 'settings'))
      .toEqual({ exists: true, visible: false, handle: settingsNative.handle });
    expect(settings.isClosed()).toBe(false);
    await pet.evaluate(() => window.myself.openSettings());
    expect(await waitForView('settings')).toBe(settings);
    await expect(settings.getByLabel('API Key', { exact: true })).toHaveValue(syntheticKey);
    await expect.poll(() => ownNativeWindow(fixture.processId, 'settings'))
      .toEqual({ exists: true, visible: true, handle: settingsNative.handle });

    await pet.evaluate(() => window.myself.openCharacterWorkshop());
    const workshop = await waitForView('characters');
    await expect(workshop.locator('.section-heading h2').first()).toHaveCSS('font-size', '15px');
    await expect(workshop.locator('.section-heading').first()).toHaveCSS('align-items', 'flex-start');
    await workshop.getByRole('button', { name: '新建角色', exact: true }).click();
    const dialog = workshop.getByRole('dialog', { name: '新建角色', exact: true });
    const syntheticName = '未提交的内存验收角色';
    await dialog.getByLabel('角色名称', { exact: true }).fill(syntheticName);
    await workshop.evaluate(() => { document.title = 'Myself-Memory-E2E-characters'; });
    const workshopNative = await ownNativeWindow(fixture.processId, 'characters');
    await ownNativeWindow(fixture.processId, 'characters', true);
    await expect.poll(() => ownNativeWindow(fixture.processId, 'characters'))
      .toEqual({ exists: true, visible: false, handle: workshopNative.handle });
    expect(workshop.isClosed()).toBe(false);
    await pet.evaluate(() => window.myself.openCharacterWorkshop());
    expect(await waitForView('characters')).toBe(workshop);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('角色名称', { exact: true })).toHaveValue(syntheticName);
    await expect.poll(() => ownNativeWindow(fixture.processId, 'characters'))
      .toEqual({ exists: true, visible: true, handle: workshopNative.handle });
    expect(pagesFor('settings')).toHaveLength(1);
    expect(pagesFor('characters')).toHaveLength(1);
  } finally {
    await fixture.dispose();
  }
});
