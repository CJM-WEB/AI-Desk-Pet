import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
import electron from 'electron';

// 只供原生验收：捕获本程序控制的背景矩形，并在鼠标注入前验证目标窗口所有者。
const directory = await mkdtemp(join(tmpdir(), 'ai-pet-chat-native-'));
const bundle = join(directory, 'fixture.cjs');
const nativeScript = join(directory, 'fixture-native.ps1');
await writeFile(nativeScript, String.raw`param(
  [ValidateSet('capture','click','region','geometry','round-region')][string]$Action,
  [int]$X, [int]$Y, [int]$Width, [int]$Height, [int]$OwnerPid,
  [long]$Handle, [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FixtureNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left; public int top; public int right; public int bottom; }
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr data);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr hwnd, IntPtr region);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr r, int x, int y);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr value);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int ellipseWidth, int ellipseHeight);
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hwnd, IntPtr region, bool redraw);
  public static bool SafeRect(int x, int y, int width, int height, uint owner, IntPtr background) {
    RECT bounds;
    uint actual;
    GetWindowThreadProcessId(background, out actual);
    if (actual != owner || !IsWindowVisible(background) || !GetWindowRect(background, out bounds) || x < bounds.left || y < bounds.top || x+width > bounds.right || y+height > bounds.bottom) return false;
    foreach (POINT point in new [] { new POINT { x=x, y=y }, new POINT { x=x+width-1, y=y }, new POINT { x=x, y=y+height-1 }, new POINT { x=x+width-1, y=y+height-1 } }) {
      GetWindowThreadProcessId(WindowFromPoint(point), out actual);
      if (actual != owner) return false;
    }
    bool safe = true, found = false;
    EnumWindows((hwnd, unused) => {
      if (hwnd == background) { found = true; return false; }
      RECT r; uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid != owner && IsWindowVisible(hwnd) && GetWindowRect(hwnd, out r) && r.left < x+width && r.right > x && r.top < y+height && r.bottom > y) { safe = false; return false; }
      return true;
    }, IntPtr.Zero);
    return safe && found;
  }
}
'@
[void][FixtureNative]::SetProcessDPIAware()
[void][FixtureNative]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($Handle -ne 0) {
  [uint32]$handleOwner=0
  [void][FixtureNative]::GetWindowThreadProcessId([IntPtr]$Handle,[ref]$handleOwner)
  if ($handleOwner -ne $OwnerPid) { throw 'FIXTURE_HANDLE_NOT_OWNED' }
}
if ($Action -eq 'round-region') {
  $rect=New-Object FixtureNative+RECT
  [void][FixtureNative]::GetWindowRect([IntPtr]$Handle,[ref]$rect)
  $region=[FixtureNative]::CreateRoundRectRgn(0,0,$rect.right-$rect.left,$rect.bottom-$rect.top,180,180)
  $result=[FixtureNative]::SetWindowRgn([IntPtr]$Handle,$region,$true)
  if ($result -eq 0) { [void][FixtureNative]::DeleteObject($region); throw 'FIXTURE_ROUND_REGION_FAILED' }
  Write-Output 'ROUND_REGION_API_OK'
} elseif ($Action -eq 'geometry') {
  $rect=New-Object FixtureNative+RECT
  [void][FixtureNative]::GetWindowRect([IntPtr]$Handle,[ref]$rect)
  $point=New-Object FixtureNative+POINT; $point.x=$X; $point.y=$Y
  [uint32]$actual=0; [void][FixtureNative]::GetWindowThreadProcessId([FixtureNative]::WindowFromPoint($point),[ref]$actual)
  Write-Output (ConvertTo-Json -Compress @{rect=$rect;atPointPid=$actual;expectedPid=$OwnerPid;point=$point})
} elseif ($Action -eq 'capture') {
  if (-not [FixtureNative]::SafeRect($X,$Y,$Width,$Height,$OwnerPid,[IntPtr]$Handle)) { throw 'FIXTURE_CAPTURE_NOT_OWNED' }
  $bitmap = New-Object System.Drawing.Bitmap($Width,$Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try { $graphics.CopyFromScreen($X,$Y,0,0,$bitmap.Size); $bitmap.Save($OutputPath,[System.Drawing.Imaging.ImageFormat]::Png) }
  finally { $graphics.Dispose(); $bitmap.Dispose() }
  Write-Output 'CAPTURE_OWNED_RECT_OK'
} elseif ($Action -eq 'click') {
  $point = New-Object FixtureNative+POINT; $point.x=$X; $point.y=$Y
  $target = [FixtureNative]::WindowFromPoint($point)
  [uint32]$actual = 0
  [void][FixtureNative]::GetWindowThreadProcessId($target,[ref]$actual)
  if ($actual -ne $OwnerPid) { throw 'FIXTURE_CLICK_NOT_OWNED' }
  $old = New-Object FixtureNative+POINT
  [void][FixtureNative]::GetCursorPos([ref]$old)
  try { [void][FixtureNative]::SetCursorPos($X,$Y); Start-Sleep -Milliseconds 100; [FixtureNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 80; [FixtureNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 100 }
  finally { [void][FixtureNative]::SetCursorPos($old.x,$old.y) }
  Write-Output 'CLICK_OWNED_POINT_OK'
} else {
  $region=[FixtureNative]::CreateRectRgn(0,0,0,0)
  try {
    $kind=[FixtureNative]::GetWindowRgn([IntPtr]$Handle,$region)
    $corner=[FixtureNative]::PtInRegion($region,1,1)
    $center=[FixtureNative]::PtInRegion($region,$Width/2,$Height/2)
    Write-Output (ConvertTo-Json -Compress @{ kind=$kind; corner=$corner; center=$center })
  } finally { [void][FixtureNative]::DeleteObject($region) }
}
`, 'utf8');
await build({ entryPoints: [resolve('tests/fixtures/chat-native-presentation.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: bundle });
const outputDirectory = resolve('../../.superpowers/sdd/2026-09-13-desktop-chat-visual-redesign/native-evidence');
const env = { ...process.env, CHAT_NATIVE_SCRIPT: nativeScript, CHAT_NATIVE_EVIDENCE: outputDirectory, CHAT_NATIVE_RESOURCES: resolve('resources') };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [bundle], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'], env });
const watchdog = setTimeout(() => { child.kill(); process.exitCode = 1; }, 60000);
try { process.exitCode = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => resolveExit(code ?? 1)); }); }
finally { clearTimeout(watchdog); }
