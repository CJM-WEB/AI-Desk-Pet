import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { createElectronAppFixture, type ElectronAppFixture } from '../fixtures/electron-app';
import { readWindowsCursor, setWindowsCursor } from '../fixtures/windows-pointer';

const execFileAsync = promisify(execFile);
type NativeFacts = {
  handle: number; visible: boolean; regionKind: number; points: boolean[];
  dpi: number; cursor: { x: number; y: number };
  rect: { left: number; top: number; right: number; bottom: number };
  monitor: { left: number; top: number; right: number; bottom: number };
};

/** 只读夹具自己的矩形/区域；唯一写入分支只把本夹具 settings 窗口作为合成测试背景铺满。 */
async function nativeFacts(processId: number, title: string, points: Array<{ x: number; y: number }> = [], background?: NativeFacts['monitor']): Promise<NativeFacts> {
  if (!Number.isSafeInteger(processId) || processId <= 0 || !/^Myself-Visual-E2E-(pet|chat|bubble|settings)$/u.test(title)
    || background && (title !== 'Myself-Visual-E2E-settings' || !Object.values(background).every(Number.isSafeInteger))) throw new Error('VISUAL_PROBE_INPUT_INVALID');
  const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class VisualProbe {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr unused);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] public struct Monitor { public int size; public Rect bounds,work; public int flags; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc,IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd,StringBuilder value,int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int width,int height,uint flags);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd,uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor,ref Monitor info);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr hwnd,IntPtr region);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
  [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr region,int x,int y);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr value);
  public static IntPtr Find(uint owner,string title) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((hwnd,unused)=> { uint pid; GetWindowThreadProcessId(hwnd,out pid);
      if(pid!=owner) return true;
      var text=new StringBuilder(256); GetWindowText(hwnd,text,256);
      if(text.ToString()!=title) return true;
      found=hwnd; return false;
    },IntPtr.Zero);
    return found;
  }
}
'@
[void][VisualProbe]::SetProcessDpiAwarenessContext([IntPtr](-4))
[void][VisualProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
$handle=[VisualProbe]::Find(${processId},'${title}')
if($handle -eq [IntPtr]::Zero){ throw 'VISUAL_OWN_WINDOW_MISSING' }
${background ? `if(-not [VisualProbe]::SetWindowPos($handle,[IntPtr](-2),${background.left},${background.top},${background.right - background.left},${background.bottom - background.top},0x10)){throw 'VISUAL_BACKGROUND_POSITION_FAILED'}` : ''}
$rect=New-Object VisualProbe+Rect
if(-not [VisualProbe]::GetWindowRect($handle,[ref]$rect)){ throw 'VISUAL_RECT_FAILED' }
$monitor=New-Object VisualProbe+Monitor; $monitor.size=[Runtime.InteropServices.Marshal]::SizeOf($monitor)
if(-not [VisualProbe]::GetMonitorInfo([VisualProbe]::MonitorFromWindow($handle,2),[ref]$monitor)){ throw 'VISUAL_MONITOR_FAILED' }
$region=[VisualProbe]::CreateRectRgn(0,0,0,0)
$cursor=New-Object VisualProbe+Point; [void][VisualProbe]::GetCursorPos([ref]$cursor)
try {
  $kind=[VisualProbe]::GetWindowRgn($handle,$region)
  $points=ConvertFrom-Json '${JSON.stringify(points.map(point => ({ x: Math.round(point.x), y: Math.round(point.y) })))}'
  $hits=@($points | ForEach-Object { [VisualProbe]::PtInRegion($region,$_.x,$_.y) })
  ConvertTo-Json -Compress -Depth 5 @{handle=$handle.ToInt64();visible=[VisualProbe]::IsWindowVisible($handle);regionKind=$kind;rect=$rect;monitor=$monitor.bounds;points=$hits;cursor=$cursor;dpi=[VisualProbe]::GetDpiForWindow($handle)}
} finally { [void][VisualProbe]::DeleteObject($region) }
`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000, encoding: 'utf8' });
  return JSON.parse(stdout.trim()) as NativeFacts;
}

/** 旧指针工具使用逻辑坐标；本用例显式切到 per-monitor v2 后只移动物理光标，不按下任何按钮。 */
async function setPhysicalCursor(point: { x: number; y: number }): Promise<void> {
  const x = Math.round(point.x), y = Math.round(point.y);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw new Error('VISUAL_CURSOR_INVALID');
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PhysicalCursor {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
}
'@
[void][PhysicalCursor]::SetProcessDpiAwarenessContext([IntPtr](-4))
[void][PhysicalCursor]::SetThreadDpiAwarenessContext([IntPtr](-4))
if(-not [PhysicalCursor]::SetCursorPos(${x},${y})){exit 2}
`], { windowsHide: true, timeout: 10_000 });
}

async function pageFor(fixture: ElectronAppFixture, view: 'pet' | 'chat' | 'bubble' | 'settings'): Promise<Page> {
  const pages = () => (fixture.browser as Browser).contexts().flatMap(context => context.pages());
  await expect.poll(() => pages().some(page => new URL(page.url()).searchParams.get('view') === view)).toBe(true);
  const page = pages().find(candidate => new URL(candidate.url()).searchParams.get('view') === view);
  if (!page) throw new Error('VISUAL_RENDERER_MISSING');
  await page.evaluate(title => { document.title = title; }, `Myself-Visual-E2E-${view}`);
  return page;
}

/** 实际DOM中心命中必须归菜单自身；只读核对三项，不触发新对话或设置业务。 */
async function assertMenuCenters(chat: Page): Promise<void> {
  for (const name of ['新对话', '历史', '设置']) {
    const item = chat.getByRole('menuitem', { name, exact: true });
    await expect(item).toBeVisible();
    await expect.poll(() => item.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })).toBe(true);
  }
  // 菜单空白托底也不能遮住输入文字左侧；中心点击不足以发现整层z-index回退。
  await expect.poll(() => chat.getByLabel('和我说点什么').evaluate(element => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + 24, rect.y + rect.height / 2));
  })).toBe(true);
}

test('正式视觉：宠物屏顶边仅提示，点击展开与菜单历史收起，气泡最小权限和原生透明角/尾部', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', '真实原生窗口仅在 Windows 验收');
  test.setTimeout(120_000);
  const cursor = await readWindowsCursor();
  let fixture: ElectronAppFixture | undefined;
  const evidence: Record<string, unknown> = {};
  try {
    fixture = await createElectronAppFixture({ workspaceRoot: resolve(process.cwd()), apiKey: 'visual-fixture-unused-key' });
    const pet = await pageFor(fixture, 'pet'), chat = await pageFor(fixture, 'chat'), bubble = await pageFor(fixture, 'bubble');
    const petNative = await nativeFacts(fixture.processId, 'Myself-Visual-E2E-pet');
    evidence.petNative = petNative;
    await chat.evaluate(() => {
      const state = globalThis as typeof globalThis & { __visualCommands?: unknown[] };
      state.__visualCommands = [];
      window.myself.chatPresentation!.onCommand(command => state.__visualCommands?.push(command));
    });
    await setPhysicalCursor({ x: (petNative.rect.left + petNative.rect.right) / 2, y: (petNative.rect.top + petNative.rect.bottom) / 2 });
    const stage = chat.locator('[data-island-mode]');
    const input = chat.getByRole('textbox', { name: '和我说点什么' });
    await expect(stage).toHaveAttribute('data-island-mode', 'hidden');
    await expect(input).toBeHidden();
    expect((await nativeFacts(fixture.processId, 'Myself-Visual-E2E-chat')).visible).toBe(false);

    await test.step('真实光标进入宠物屏顶边只peek，提示不显示输入', async () => {
      await setPhysicalCursor({ x: (petNative.monitor.left + petNative.monitor.right) / 2, y: petNative.monitor.top });
      evidence.cursorAtTop = await readWindowsCursor();
      const aware = await nativeFacts(fixture!.processId, 'Myself-Visual-E2E-pet');
      evidence.awareCursorAtTop = aware;
      expect(aware.cursor).toEqual({ x: Math.round((petNative.monitor.left + petNative.monitor.right) / 2), y: petNative.monitor.top });
      evidence.mainAtTop = await fixture!.getMainE2eState();
      await expect(stage).toHaveAttribute('data-island-mode', 'peek');
      await expect(chat.getByRole('button', { name: '打开聊天', exact: true })).toBeVisible();
      await expect(input).toBeHidden();
      evidence.peek = await nativeFacts(fixture!.processId, 'Myself-Visual-E2E-chat');
    });
    await test.step('点击三角才三球落位、展开输入', async () => {
      await chat.getByRole('button', { name: '打开聊天', exact: true }).click();
      await expect(stage).toHaveAttribute('data-island-mode', 'opening');
      await expect(stage).toHaveAttribute('data-island-mode', 'open');
      await expect(input).toBeVisible();
      await expect(chat.getByRole('button', { name: '选项', exact: true })).toBeVisible();
      await expect(chat.getByRole('button', { name: '发送给 AI Pet', exact: true })).toBeVisible();
    });

    await test.step('菜单与历史真实按钮切换，点击输入只关闭菜单', async () => {
      const options = chat.getByRole('button', { name: '选项', exact: true });
      await options.click(); await expect(chat.getByRole('menu')).toBeVisible();
      await assertMenuCenters(chat);
      await input.click(); await expect(chat.getByRole('menu')).toBeHidden();
      await expect(stage).toHaveAttribute('data-island-mode', 'open');
      await options.click(); await chat.getByRole('menuitem', { name: '历史', exact: true }).click();
      await expect(chat.locator('.island-history-wrap')).toHaveAttribute('data-open', 'true');
      await expect(chat.getByRole('region', { name: '历史对话', exact: true })).toBeVisible();
      await assertMenuCenters(chat);
      await input.click();
      await expect(chat.getByRole('menu')).toBeHidden();
      await options.click(); await chat.getByRole('menuitem', { name: '历史', exact: true }).click();
      await expect(chat.locator('.island-history-wrap')).toHaveAttribute('data-open', 'false');
      await input.click();
    });

    await test.step('Win32实际区域排除透明角并包含输入中心', async () => {
      const native = await nativeFacts(fixture!.processId, 'Myself-Visual-E2E-chat');
      const metrics = await chat.evaluate(() => { const rect = document.querySelector('.island-input')!.getBoundingClientRect(); return { width: innerWidth, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
      const scale = (native.rect.right - native.rect.left) / metrics.width;
      const facts = await nativeFacts(fixture!.processId, 'Myself-Visual-E2E-chat', [{ x: 1, y: 1 }, { x: metrics.x * scale, y: metrics.y * scale }]);
      expect(facts.regionKind).toBe(3); expect(facts.points).toEqual([false, true]); evidence.chatRegion = facts;
    });

    await test.step('气泡正式preload仅展示协议；合成展示经白名单桥交付且尾部进入原生区域', async () => {
      expect(await bubble.evaluate(() => Object.keys(window.myself))).toEqual(['chatPresentation']);
      expect(await bubble.evaluate(() => Object.keys(window.myself.chatPresentation!).sort())).toEqual(['dispatch', 'onCommand', 'onIntent', 'onSnapshot', 'publish', 'ready', 'setLayout']);
      await chat.evaluate(async () => {
        const api = window.myself.chatPresentation!;
        const ready = await api.ready();
        await api.publish({ epoch: ready.epoch, revision: ready.revisionFloor + 1, conversationRevision: 0, reply: { id: 'visual-fixture-reply', text: '受控视觉夹具气泡正文' }, confirmation: null });
      });
      await expect(bubble.getByText('受控视觉夹具气泡正文', { exact: true })).toBeVisible();
      await expect.poll(() => bubble.locator('.speech-tail').evaluate(element => (element as HTMLElement).style.left)).not.toBe('');
      const native = await nativeFacts(fixture!.processId, 'Myself-Visual-E2E-bubble');
      const metrics = await bubble.evaluate(() => { const element = document.querySelector('.speech-tail') as HTMLElement, speech = document.querySelector('.pet-speech')!.getBoundingClientRect(), tail = element.getBoundingClientRect(); return { width: innerWidth, body: { x: speech.x + speech.width / 2, y: speech.y + 16 }, tail: { x: tail.x + tail.width / 2, y: tail.y + tail.height / 2 }, anchor: { side: element.dataset.side, tailX: Number.parseFloat(element.style.left) + 6, bodyLeft: speech.x, bodyWidth: speech.width } }; });
      expect(['top', 'bottom']).toContain(metrics.anchor.side);
      expect(metrics.anchor.tailX).toBeGreaterThanOrEqual(0); expect(metrics.anchor.tailX).toBeLessThanOrEqual(metrics.anchor.bodyWidth);
      expect(metrics.anchor.bodyLeft).toBeGreaterThanOrEqual(0); expect(metrics.anchor.bodyLeft + metrics.anchor.bodyWidth).toBeLessThanOrEqual(metrics.width);
      evidence.bubbleAnchor = metrics.anchor;
      const scale = (native.rect.right - native.rect.left) / metrics.width;
      const facts = await nativeFacts(fixture!.processId, 'Myself-Visual-E2E-bubble', [{ x: 1, y: 1 }, { x: metrics.body.x * scale, y: metrics.body.y * scale }, { x: metrics.tail.x * scale, y: metrics.tail.y * scale }]);
      expect(facts.regionKind).toBe(3); expect(facts.points).toEqual([false, true, true]); evidence.bubbleRegion = facts;
    });

    // CDP 点击不改变系统光标；先离开顶边，复现用户真实点击收起按钮后的光标位置条件。
    await setPhysicalCursor({ x: (petNative.rect.left + petNative.rect.right) / 2, y: (petNative.rect.top + petNative.rect.bottom) / 2 });
    await chat.getByRole('button', { name: '收起聊天', exact: true }).click();
    await expect(stage).toHaveAttribute('data-island-mode', 'hidden'); await expect(input).toBeHidden();
    expect((await nativeFacts(fixture.processId, 'Myself-Visual-E2E-chat')).visible).toBe(false);
    expect(await bubble.getByText('受控视觉夹具气泡正文', { exact: true }).isVisible()).toBe(true);

    await test.step('受控其他窗口收到真实首击，同时Main收起；安全截图仅含自有合成背景', async () => {
      await chat.evaluate(() => window.myself.openSettings());
      const background = await pageFor(fixture!, 'settings');
      await background.evaluate(() => {
        const state = globalThis as typeof globalThis & { __visualBackgroundDowns?: number };
        state.__visualBackgroundDowns = 0;
        const layer = document.createElement('div');
        layer.id = 'visual-controlled-background';
        layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:linear-gradient(90deg,#ef5350 0 50%,#42a5f5 50% 100%);color:white;display:grid;place-items:center;font-size:24px';
        layer.textContent = '受控正式视觉验收背景';
        layer.addEventListener('pointerdown', () => { state.__visualBackgroundDowns = (state.__visualBackgroundDowns ?? 0) + 1; });
        document.body.append(layer);
      });
      const backgroundNative = await nativeFacts(fixture!.processId, 'Myself-Visual-E2E-settings', [], petNative.monitor);
      await chat.evaluate(() => window.myself.openChat());
      await expect(stage).toHaveAttribute('data-island-mode', 'open');
      await chat.getByRole('button', { name: '选项', exact: true }).click();
      await chat.getByRole('menuitem', { name: '历史', exact: true }).click();
      await input.click();
      await expect(chat.locator('.island-history-wrap')).toHaveAttribute('data-open', 'true');

      // 复用任务1已实机验证的捕获/原子点击守卫原文，避免另造截图和鼠标安全边界。
      const source = await readFile(resolve('apps/desktop/scripts/run-chat-native-validation.mjs'), 'utf8');
      const helper = /await writeFile\(nativeScript, String.raw`([\s\S]*?)`, 'utf8'\);/u.exec(source)?.[1];
      if (!helper) throw new Error('VISUAL_EXISTING_NATIVE_HELPER_MISSING');
      const directory = await mkdtemp(join(tmpdir(), 'ai-pet-visual-native-e2e-'));
      const script = join(directory, 'native.ps1'); await writeFile(script, helper, 'utf8');
      const run = (action: 'capture' | 'click', args: string[]) => execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, '-Action', action, '-OwnerPid', String(fixture!.processId), ...args], { windowsHide: true, timeout: 10_000, encoding: 'utf8' });
      const capture = async (view: 'chat' | 'bubble') => {
        const facts = await nativeFacts(fixture!.processId, `Myself-Visual-E2E-${view}`);
        // 原生150%尺寸可能向外取整1px；捕获严格限制在已覆盖背景内，不扩大隐私守卫。
        const left = Math.max(facts.rect.left, backgroundNative.rect.left), top = Math.max(facts.rect.top, backgroundNative.rect.top);
        const right = Math.min(facts.rect.right, backgroundNative.rect.right), bottom = Math.min(facts.rect.bottom, backgroundNative.rect.bottom);
        if (right <= left || bottom <= top) throw new Error('VISUAL_CAPTURE_OUTSIDE_CONTROLLED_BACKGROUND');
        evidence[`${view}CaptureRect`] = { original: facts.rect, captured: { left, top, right, bottom } };
        const path = testInfo.outputPath(`controlled-native-${view}.png`);
        await run('capture', ['-Handle', String(backgroundNative.handle), '-X', String(left), '-Y', String(top), '-Width', String(right - left), '-Height', String(bottom - top), '-OutputPath', path]);
        await testInfo.attach(`controlled-native-${view}`, { path, contentType: 'image/png' });
      };
      await capture('chat');
      // 合成背景保持普通窗口，产品原生置顶层应自然位于其上；只重投测试正文等待新的布局。
      await chat.evaluate(async () => {
        const api = window.myself.chatPresentation!, ready = await api.ready();
        await api.publish({ epoch: ready.epoch, revision: ready.revisionFloor + 1, conversationRevision: 0, reply: null, confirmation: null });
      });
      await expect(bubble.getByText('受控视觉夹具气泡正文', { exact: true })).toBeHidden();
      await chat.evaluate(async () => {
        const api = window.myself.chatPresentation!, ready = await api.ready();
        await api.publish({ epoch: ready.epoch, revision: ready.revisionFloor + 1, conversationRevision: 0, reply: { id: 'visual-native-reply', text: '受控正式窗口玻璃气泡' }, confirmation: null });
      });
      await expect(bubble.getByText('受控正式窗口玻璃气泡', { exact: true })).toBeVisible();
      await capture('bubble');

      // 点位远离当前chat/bubble/pet，并由原子native helper再次验证实际命中PID后才按下。
      await run('click', ['-X', String(petNative.monitor.left + 60), '-Y', String(petNative.monitor.bottom - 100)]);
      await expect.poll(() => background.evaluate(() => Reflect.get(globalThis, '__visualBackgroundDowns'))).toBe(1);
      await expect(stage).toHaveAttribute('data-island-mode', 'hidden'); await expect(input).toBeHidden();
      expect((await nativeFacts(fixture!.processId, 'Myself-Visual-E2E-chat')).visible).toBe(false);
      await expect(bubble.getByText('受控正式窗口玻璃气泡', { exact: true })).toBeVisible();
      evidence.externalClick = { backgroundNative, backgroundDowns: 1, chatHidden: true, bubbleRetained: true };
    });
    evidence.logs = fixture.logs;
  } finally {
    if (fixture) {
      evidence.logs = fixture.logs;
      const chat = (fixture.browser as Browser).contexts().flatMap(context => context.pages()).find(page => new URL(page.url()).searchParams.get('view') === 'chat');
      evidence.commands = chat ? await chat.evaluate(() => Reflect.get(globalThis, '__visualCommands')).catch(() => 'renderer-gone') : 'chat-gone';
    }
    const factsPath = testInfo.outputPath('controlled-native-window-facts.json');
    await writeFile(factsPath, JSON.stringify(evidence, null, 2), 'utf8');
    await testInfo.attach('controlled-native-window-facts', { path: factsPath, contentType: 'application/json' });
    await fixture?.dispose(); await setWindowsCursor(cursor);
  }
});
