import { execFile } from 'node:child_process';
import { win32 } from 'node:path';

const PROBE_SOURCE = `
using System;
using System.Runtime.InteropServices;
public static class MyselfForegroundFullscreenProbe {
  [StructLayout(LayoutKind.Sequential)] private struct Rect {
    public int Left; public int Top; public int Right; public int Bottom;
  }
  [StructLayout(LayoutKind.Sequential)] private struct MonitorInfo {
    public int Size; public Rect Monitor; public Rect Work; public int Flags;
  }
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  public static bool Sample() {
    IntPtr hwnd = GetForegroundWindow();
    if (hwnd == IntPtr.Zero || !GetWindowRect(hwnd, out Rect window)) return true;
    IntPtr monitor = MonitorFromWindow(hwnd, 2);
    MonitorInfo info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
    if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) return true;
    return window.Left <= info.Monitor.Left && window.Top <= info.Monitor.Top
      && window.Right >= info.Monitor.Right && window.Bottom >= info.Monitor.Bottom;
  }
}`;

const PROBE_COMMAND = `Add-Type -TypeDefinition @'\n${PROBE_SOURCE}\n'@\nif ([MyselfForegroundFullscreenProbe]::Sample()) { '1' } else { '0' }`;

export interface ForegroundFullscreenProbe {
  sample(): Promise<boolean>;
}

export interface ForegroundFullscreenProbeOptions {
  platform?: NodeJS.Platform;
  runFixedProbe?: () => Promise<string>;
}

/** 固定适配器只接受严格布尔输出，任意平台或执行不确定性均阻止自动藏身。 */
export function createForegroundFullscreenProbe(
  options: ForegroundFullscreenProbeOptions = {}
): ForegroundFullscreenProbe {
  const platform = options.platform ?? process.platform;
  const run = options.runFixedProbe ?? runWindowsForegroundFullscreenProbe;
  return {
    async sample(): Promise<boolean> {
      if (platform !== 'win32') return true;
      try {
        const output = (await run()).trim();
        if (output === '1') return true;
        if (output === '0') return false;
        return true;
      } catch {
        return true;
      }
    }
  };
}

function runWindowsForegroundFullscreenProbe(): Promise<string> {
  const windowsDirectory = process.env.SystemRoot ?? 'C:\\Windows';
  const executable = win32.join(
    windowsDirectory,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const encoded = Buffer.from(PROBE_COMMAND, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, encoding: 'utf8', timeout: 2_000, maxBuffer: 16 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}
