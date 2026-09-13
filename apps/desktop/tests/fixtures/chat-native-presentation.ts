import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, screen, type Rectangle } from 'electron';
import { createChatPointerObserver } from '../../src/main/windows/chat-native-pointer';

// 完全独立夹具：仅自身背景、玻璃窗口和合成文案，不连接正式业务或用户桌宠。
const directory = process.env.CHAT_NATIVE_EVIDENCE!;
const facts: Record<string, unknown> = { electron: process.versions.electron, platform: process.platform, screenshots: [] };
const windows: BrowserWindow[] = [];
let observer: ReturnType<typeof createChatPointerObserver> | undefined;
const watchdog = setTimeout(() => { app.exit(1); }, 45000);
function native(action: 'capture' | 'click' | 'region' | 'geometry' | 'round-region', args: Record<string, string | number>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', process.env.CHAT_NATIVE_SCRIPT!, '-Action', action, '-OwnerPid', String(process.pid), ...Object.entries(args).flatMap(([key, value]) => [`-${key}`, String(value)])],
      { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('FIXTURE_NATIVE_TIMEOUT')); }, 8000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(output.trim()); else reject(new Error(error || `FIXTURE_NATIVE_EXIT_${code}`)); });
  });
}
function handle(window: BrowserWindow): string { return window.getNativeWindowHandle().readBigUInt64LE().toString(); }
function roundedShape(width: number, height: number, radius: number): Rectangle[] {
  return Array.from({ length: height }, (_, y) => {
    const vertical = Math.max(radius - y - 0.5, y + 0.5 - (height - radius), 0);
    const inset = Math.ceil(radius - Math.sqrt(radius * radius - vertical * vertical));
    return { x: inset, y, width: width - 2 * inset, height: 1 };
  });
}
async function run() {
  await app.whenReady();
  await mkdir(directory, { recursive: true });
  const area = screen.getPrimaryDisplay().bounds;
  const bounds = { x: area.x + Math.round((area.width - 740) / 2), y: area.y + Math.round((area.height - 480) / 2), width: 740, height: 480 };
  const backdrop = new BrowserWindow({ ...area, frame: false, thickFrame: false, show: false, alwaysOnTop: true, backgroundColor: '#ffffff', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  windows.push(backdrop);
  await backdrop.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<html><style>html,body{margin:0;height:100%;background:repeating-linear-gradient(90deg,#ef3166 0 10px,#24c8df 10px 20px,#fad147 20px 30px,#6352cf 30px 40px)}p{margin:0;padding:12px;background:#fff;font:18px sans-serif}</style><p>受控原生验收背景</p><script>window.downs=0;addEventListener("pointerdown",()=>window.downs++)</script></html>')}`);
  // 隐藏启动的 GUI 子进程第一次 ShowWindow 会遵循 SW_HIDE，第二次才遵循显式显示。
  backdrop.show(); backdrop.show(); backdrop.focus();
  await delay(600);
  facts.backdropBounds = backdrop.getBounds();
  facts.backdropVisibility = { visible: backdrop.isVisible(), top: backdrop.isAlwaysOnTop(), title: backdrop.getTitle() };
  const probePoint = screen.dipToScreenPoint({ x: bounds.x + 200, y: bounds.y + 200 });
  facts.backdropGeometry = JSON.parse(await native('geometry', { X: probePoint.x, Y: probePoint.y, Handle: handle(backdrop) }));
  const glass = new BrowserWindow({ x: bounds.x + 100, y: bounds.y + 100, width: 540, height: 180, frame: false, thickFrame: false, show: false, transparent: false, backgroundColor: '#00000000', alwaysOnTop: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  windows.push(glass);
  await glass.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<html><style>html,body{margin:0;height:100%;background:transparent}p{position:absolute;left:35px;top:55px;padding:10px;background:#ffffffb3;border-radius:10px;font:18px sans-serif;color:#222}</style><p>原生玻璃合成正文</p><script>window.downs=0;addEventListener("pointerdown",()=>window.downs++)</script></html>')}`);
  const capture = async (name: string) => {
    await delay(600);
    const rect = screen.dipToScreenRect(backdrop, bounds);
    const file = join(directory, `${name}.png`);
    await native('capture', { X: rect.x, Y: rect.y, Width: rect.width, Height: rect.height, Handle: handle(backdrop), OutputPath: file });
    (facts.screenshots as string[]).push(file);
  };
  await capture('00-backdrop');
  glass.setBackgroundMaterial('acrylic'); glass.show(); glass.focus();
  facts.acrylicApi = '返回无异常';
  await capture('01-acrylic-rectangle');
  glass.setShape(roundedShape(540, 180, 90));
  await capture('02-acrylic-capsule');
  const shape = JSON.parse(await native('region', { Width: 540, Height: 180, Handle: handle(glass) }));
  facts.capsuleRegion = shape;
  assert.equal(shape.center, true); assert.equal(shape.corner, false);
  const points: { x: number; y: number }[] = [];
  const failures: string[] = [];
  // 仅夹具记录自有观察器协议，以区分握手、消息泵与宿主解析故障。
  const childPort = createRequire(join(directory, 'fixture.js'))('node:child_process') as typeof import('node:child_process');
  const originalSpawn = childPort.spawn;
  const trace: string[] = [];
  childPort.spawn = ((...args: Parameters<typeof spawn>) => {
    const child = originalSpawn(...args);
    if (Array.isArray(args[1]) && args[1].some(value => value.endsWith('chat-pointer-observer.ps1'))) {
      child.stdout?.on('data', chunk => { if (trace.length < 100) trace.push(chunk.toString()); });
    }
    return child;
  }) as typeof spawn;
  observer = createChatPointerObserver({ resourceRoot: process.env.CHAT_NATIVE_RESOURCES!, onPointerDown: point => points.push(point), onFailure: code => failures.push(code) });
  observer.setEnabled(true);
  childPort.spawn = originalSpawn;
  await delay(3000);
  async function click(name: string, x: number, y: number) {
    const point = screen.dipToScreenPoint({ x, y });
    const before = { backdrop: await backdrop.webContents.executeJavaScript('window.downs'), glass: await glass.webContents.executeJavaScript('window.downs'), points: points.length };
    await native('click', { X: point.x, Y: point.y });
    await delay(200);
    const result = { before, after: { backdrop: await backdrop.webContents.executeJavaScript('window.downs'), glass: await glass.webContents.executeJavaScript('window.downs'), points: points.length }, physical: point, lastObserved: points.at(-1) };
    facts[name] = result;
    return result;
  }
  const corner = await click('shapeTransparentCorner', bounds.x + 102, bounds.y + 102);
  assert.equal(corner.after.backdrop, corner.before.backdrop + 1); assert.equal(corner.after.glass, corner.before.glass);
  assert.deepEqual(corner.lastObserved, corner.physical);
  const inside = await click('shapeInside', bounds.x + 370, bounds.y + 190);
  assert.equal(inside.after.glass, inside.before.glass + 1); assert.equal(inside.after.backdrop, inside.before.backdrop);
  assert.deepEqual(inside.lastObserved, inside.physical);
  glass.setIgnoreMouseEvents(true, { forward: true });
  const pass = await click('ignoreMousePassthrough', bounds.x + 370, bounds.y + 190);
  assert.equal(pass.after.backdrop, pass.before.backdrop + 1); assert.equal(pass.after.glass, pass.before.glass);
  assert.deepEqual(pass.lastObserved, pass.physical);
  glass.setIgnoreMouseEvents(false);
  const outside = await click('outsideGlass', bounds.x + 40, bounds.y + 400);
  assert.equal(outside.after.backdrop, outside.before.backdrop + 1); assert.deepEqual(outside.lastObserved, outside.physical);
  observer.setEnabled(false);
  const disabled = await click('observerDisabled', bounds.x + 40, bounds.y + 400);
  assert.equal(disabled.after.backdrop, disabled.before.backdrop + 1); assert.equal(disabled.after.points, disabled.before.points);
  glass.setSize(180, 180); glass.setShape(roundedShape(180, 180, 90));
  glass.focus(); await capture('03-acrylic-circle');
  facts.circleBounds = glass.getBounds();
  facts.circleRegion = JSON.parse(await native('region', { Width: 180, Height: 180, Handle: handle(glass) }));
  glass.setSize(540, 280); glass.setShape(roundedShape(540, 280, 24));
  await capture('04-acrylic-expanded');
  facts.expandedBounds = glass.getBounds();
  facts.directRoundRegion = await native('round-region', { Handle: handle(glass) });
  await capture('05-acrylic-native-round-region');
  glass.hide();
  const history = new BrowserWindow({ x: bounds.x + 190, y: bounds.y + 75, width: 360, height: 280, frame: false, thickFrame: true, show: false, transparent: false, backgroundColor: '#00000000', alwaysOnTop: true, focusable: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  windows.push(history);
  await history.loadURL('data:text/html,<html style="background:transparent"><body style="background:transparent"></body></html>');
  history.setBackgroundMaterial('acrylic'); history.setIgnoreMouseEvents(true); history.showInactive();
  const content = new BrowserWindow({ x: bounds.x + 100, y: bounds.y + 75, width: 540, height: 360, frame: false, thickFrame: false, show: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true, parent: history, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  windows.push(content);
  await content.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<html><style>html,body{margin:0;background:transparent;font:16px sans-serif;color:#222}.history{position:absolute;left:90px;top:0;width:360px;height:280px;border-radius:24px;background:#ffffff55;box-sizing:border-box;padding:24px}.bar{position:absolute;left:90px;top:300px;width:360px;height:48px;border-radius:24px;background:#ffffffd0;text-align:center;line-height:48px}.ball{position:absolute;top:300px;width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#59d9e8,#9a7be8)}.left{left:30px}.right{right:30px}</style><div class="history">历史原生背景与清晰合成正文<br><br>此窗口不连接正式聊天内容。</div><div class="bar">透明聊天内容层</div><div class="ball left"></div><div class="ball right"></div></html>')}`);
  content.show(); content.focus();
  await capture('06-history-acrylic-under-transparent-content');
  await backdrop.webContents.executeJavaScript("document.documentElement.style.background='linear-gradient(90deg,#ff2030 0 50%,#174cff 50% 100%)';document.body.style.background='transparent'");
  await capture('07-history-low-frequency-red-blue-boundary');
  await backdrop.webContents.executeJavaScript("document.documentElement.style.background='linear-gradient(90deg,#174cff 0 50%,#ff2030 50% 100%)'");
  await capture('08-history-swapped-blue-red-boundary');
  facts.historyLayer = { bounds: history.getBounds(), visible: history.isVisible(), ignoresMouse: '已启用', contentBounds: content.getBounds(), contentVisible: content.isVisible() };
  facts.observerFailures = failures;
  facts.observerPoints = points;
  facts.observerProtocol = trace;
  assert.equal(failures.length, 0);
  await observer.dispose(); observer = undefined;
  facts.dispose = '正常退出';
}
void run().then(async () => {
  facts.status = '原生协议、命中与穿透自动化通过；视觉限制另见报告';
  await writeFile(join(directory, 'facts.json'), JSON.stringify(facts, null, 2), 'utf8');
  console.log(JSON.stringify(facts));
  clearTimeout(watchdog); for (const window of windows) window.destroy(); app.exit(0);
}).catch(async error => {
  facts.failure = String(error);
  await observer?.dispose().catch(() => undefined);
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'facts.json'), JSON.stringify(facts, null, 2), 'utf8');
  console.error(JSON.stringify(facts)); clearTimeout(watchdog); for (const window of windows) window.destroy(); app.exit(1);
});
