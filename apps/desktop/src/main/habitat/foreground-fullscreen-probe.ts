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
  close(): Promise<void>;
}

interface FixedProbeExecution {
  result: Promise<string>;
  cancel(): void;
}

export interface ForegroundFullscreenProbeOptions {
  platform?: NodeJS.Platform;
  runFixedProbe?: () => Promise<string>;
  startFixedProbe?: () => FixedProbeExecution;
}

/** 固定适配器只接受严格布尔输出，任意平台或执行不确定性均阻止自动藏身。 */
export function createForegroundFullscreenProbe(
  options: ForegroundFullscreenProbeOptions = {}
): ForegroundFullscreenProbe {
  const platform = options.platform ?? process.platform;
  const runFixedProbe = options.runFixedProbe;
  const start = options.startFixedProbe
    ?? (runFixedProbe
      ? () => ({ result: runFixedProbe(), cancel: () => undefined })
      : startWindowsForegroundFullscreenProbe);
  let active: { execution: FixedProbeExecution; sample: Promise<boolean> } | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  return {
    sample(): Promise<boolean> {
      if (platform !== 'win32' || closed) return Promise.resolve(true);
      if (active) return active.sample;
      let execution: FixedProbeExecution;
      try {
        execution = start();
      } catch {
        return Promise.resolve(true);
      }
      const current = { execution, sample: Promise.resolve(true) };
      active = current;
      current.sample = (async () => {
        try {
          const output = (await execution.result).trim();
          if (closed) return true;
          if (output === '1') return true;
          if (output === '0') return false;
          return true;
        } catch {
          return true;
        } finally {
          if (active === current) active = undefined;
        }
      })();
      return current.sample;
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      const current = active;
      try { current?.execution.cancel(); } catch { /* 取消失败仍等待进程自然收敛。 */ }
      closePromise = current?.sample.then(() => undefined) ?? Promise.resolve();
      return closePromise;
    }
  };
}

function startWindowsForegroundFullscreenProbe(): FixedProbeExecution {
  const windowsDirectory = process.env.SystemRoot ?? 'C:\\Windows';
  const executable = win32.join(
    windowsDirectory,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const encoded = Buffer.from(PROBE_COMMAND, 'utf16le').toString('base64');
  let child: ReturnType<typeof execFile> | undefined;
  const result = new Promise<string>((resolve, reject) => {
    child = execFile(
      executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, encoding: 'utf8', timeout: 2_000, maxBuffer: 16 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
  return {
    result,
    cancel: () => {
      if (child && !child.killed) child.kill();
    }
  };
}
