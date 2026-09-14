import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WINDOWS_CURSOR_INTEROP = String.raw`
using System;
using System.Runtime.InteropServices;
public static class MyselfCursorInterop {
  [StructLayout(LayoutKind.Sequential)]
  public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(
    IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int virtualKey);
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(
    IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(
    IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(
    uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
}`;

export type WindowsCursorSnapshot = Readonly<{ x: number; y: number; dpi: number }>;
export type WindowsPointerTarget = Readonly<{ processId: number; leftButtonDown: boolean }>;
export type WindowsWindowRect = Readonly<{
  left: number; top: number; right: number; bottom: number;
}>;

/** E2E 只调用固定 Win32 光标 API，并由用例 finally 恢复进入测试前的位置。 */
export async function readWindowsCursor(): Promise<WindowsCursorSnapshot> {
  const script = String.raw`
Add-Type -TypeDefinition @'
${WINDOWS_CURSOR_INTEROP}
'@
$point = [MyselfCursorInterop+Point]::new()
if (-not [MyselfCursorInterop]::GetCursorPos([ref]$point)) { exit 2 }
$dpi = [MyselfCursorInterop]::GetDpiForSystem()
[Console]::Out.Write("$($point.X),$($point.Y),$dpi")`;
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script
  ], { windowsHide: true, timeout: 10_000, encoding: 'utf8' });
  const match = /^(-?\d+),(-?\d+),(\d+)$/u.exec(stdout.trim());
  if (!match) throw new Error('WINDOWS_CURSOR_PROBE_INVALID');
  return { x: Number(match[1]), y: Number(match[2]), dpi: Number(match[3]) };
}

export async function setWindowsCursor(point: Readonly<{ x: number; y: number }>): Promise<void> {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  const script = String.raw`
Add-Type -TypeDefinition @'
${WINDOWS_CURSOR_INTEROP}
'@
if (-not [MyselfCursorInterop]::SetCursorPos(${x}, ${y})) { exit 2 }`;
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script
  ], { windowsHide: true, timeout: 30_000, encoding: 'utf8' });
}

export async function setWindowsLeftButton(down: boolean): Promise<void> {
  const flag = down ? '0x0002' : '0x0004';
  const script = String.raw`
Add-Type -TypeDefinition @'
${WINDOWS_CURSOR_INTEROP}
'@
[MyselfCursorInterop]::mouse_event(${flag}, 0, 0, 0, [UIntPtr]::Zero)`;
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script
  ], { windowsHide: true, timeout: 10_000, encoding: 'utf8' });
}

/** 从 Win32 命中测试读取真实输入目标，避免以内存中的穿透标志代替系统事实。 */
export async function readWindowsPointerTarget(): Promise<WindowsPointerTarget> {
  const script = String.raw`
Add-Type -TypeDefinition @'
${WINDOWS_CURSOR_INTEROP}
'@
$point = [MyselfCursorInterop+Point]::new()
if (-not [MyselfCursorInterop]::GetCursorPos([ref]$point)) { exit 2 }
$window = [MyselfCursorInterop]::WindowFromPoint($point)
[uint32]$processId = 0
[void][MyselfCursorInterop]::GetWindowThreadProcessId($window, [ref]$processId)
$leftButtonDown = ([MyselfCursorInterop]::GetAsyncKeyState(1) -band 0x8000) -ne 0
[Console]::Out.Write("$processId,$leftButtonDown")`;
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script
  ], { windowsHide: true, timeout: 10_000, encoding: 'utf8' });
  const match = /^(\d+),(True|False)$/u.exec(stdout.trim());
  if (!match) throw new Error('WINDOWS_POINTER_TARGET_PROBE_INVALID');
  return { processId: Number(match[1]), leftButtonDown: match[2] === 'True' };
}

/** 读取目标 Electron 顶层窗口的真实物理矩形，避免混用 DIP 与 Win32 坐标。 */
export async function readWindowsProcessWindowRect(processId: number): Promise<WindowsWindowRect> {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error('WINDOWS_WINDOW_PROCESS_ID_INVALID');
  }
  const script = String.raw`
Add-Type -TypeDefinition @'
${WINDOWS_CURSOR_INTEROP}
'@
$process = Get-Process -Id ${String(processId)} -ErrorAction Stop
$window = $process.MainWindowHandle
if ($window -eq [IntPtr]::Zero) { exit 2 }
$rect = [MyselfCursorInterop+Rect]::new()
if (-not [MyselfCursorInterop]::GetWindowRect($window, [ref]$rect)) { exit 3 }
[Console]::Out.Write("$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)")`;
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script
  ], { windowsHide: true, timeout: 10_000, encoding: 'utf8' });
  const match = /^(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/u.exec(stdout.trim());
  if (!match) throw new Error('WINDOWS_WINDOW_RECT_PROBE_INVALID');
  return {
    left: Number(match[1]), top: Number(match[2]),
    right: Number(match[3]), bottom: Number(match[4])
  };
}

/** 将测试目标提升到普通窗口 Z 序顶部，但不激活、不改位置或尺寸。 */
export async function raiseWindowsProcessWindow(processId: number): Promise<void> {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error('WINDOWS_WINDOW_PROCESS_ID_INVALID');
  }
  const script = String.raw`
Add-Type -TypeDefinition @'
${WINDOWS_CURSOR_INTEROP}
'@
$process = Get-Process -Id ${String(processId)} -ErrorAction Stop
$window = $process.MainWindowHandle
if ($window -eq [IntPtr]::Zero) { exit 2 }
$flags = 0x0001 -bor 0x0002 -bor 0x0010
if (-not [MyselfCursorInterop]::SetWindowPos(
  $window, [IntPtr](-1), 0, 0, 0, 0, $flags)) { exit 3 }
if (-not [MyselfCursorInterop]::SetWindowPos(
  $window, [IntPtr](-2), 0, 0, 0, 0, $flags)) { exit 4 }`;
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script
  ], { windowsHide: true, timeout: 10_000, encoding: 'utf8' });
}
