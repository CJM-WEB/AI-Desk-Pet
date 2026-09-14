import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { win32 } from 'node:path';

export interface ChatPointerObserverOptions {
  resourceRoot: string;
  onPointerDown(point: { x: number; y: number }): void;
  onFailure(code: string): void;
}

/** 只读鼠标按下屏幕物理坐标；宿主负责 DIP 转换和自身交互区域判定。 */
export function createChatPointerObserver(options: ChatPointerObserverOptions): {
  setEnabled(enabled: boolean): void;
  dispose(): Promise<void>;
} {
  let child: ChildProcessWithoutNullStreams | undefined;
  let ready = false;
  let enabled = false;
  let failed = false;
  let closed = false;
  let exited = false;
  let generation = 0;
  let acknowledged = -1;
  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposal: Promise<void> | undefined;
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  const fail = (code: string) => {
    if (failed || closed) return;
    failed = true; enabled = false; clearTimer();
    try { child?.kill(); } catch { /* 只终止当前观察器，不扩大终止范围。 */ }
    try { options.onFailure(code); } catch { /* 宿主窗口已销毁时仍保持失败事实与进程清理，不让事件异常退出 Main。 */ }
  };
  const arm = (ms: number) => { clearTimer(); timer = setTimeout(() => fail('CHAT_POINTER_TIMEOUT'), ms); };
  const write = (message: object) => {
    try { child?.stdin.write(`${JSON.stringify(message)}\n`, error => { if (error) fail('CHAT_POINTER_WRITE_FAILED'); }); }
    catch { fail('CHAT_POINTER_WRITE_FAILED'); }
  };
  const update = () => {
    if (!ready || closed || failed) return;
    write({ version: 1, type: 'set-enabled', enabled, generation });
    arm(2000);
  };
  const integer = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= 2147483647;
  const consume = (line: string) => {
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (!message || message.version !== 1) throw new Error();
      const keys = Object.keys(message).sort().join(',');
      if (message.type === 'ready' && keys === 'type,version' && !ready) {
        ready = true; update(); return;
      }
      if (!ready) throw new Error();
      if (message.type === 'enabled' && keys === 'generation,type,version' && integer(message.generation)) {
        if (message.generation > generation || message.generation < 0) throw new Error();
        if (message.generation === generation) { acknowledged = generation; if (enabled) arm(5000); else clearTimer(); }
        return;
      }
      if (message.type === 'heartbeat' && keys === 'type,version') {
        if (enabled && acknowledged === generation) arm(5000);
        return;
      }
      if (message.type !== 'pointer-down' || keys !== 'generation,type,version,x,y'
        || !integer(message.generation) || !integer(message.x) || !integer(message.y)
        || message.generation < 0 || message.generation > generation) throw new Error();
      if (enabled && acknowledged === generation && message.generation === generation) options.onPointerDown({ x: message.x, y: message.y });
    } catch { fail('CHAT_POINTER_PROTOCOL_INVALID'); }
  };
  const start = () => {
    try {
      if (process.platform !== 'win32' || !win32.isAbsolute(options.resourceRoot)) throw new Error();
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
      child = spawn(win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', win32.join(options.resourceRoot, 'windows', 'chat-pointer-observer.ps1')],
        { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
          SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP
        } });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (failed || closed) return;
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0 && !failed) {
          const line = buffer.slice(0, newline).replace(/\r$/u, ''); buffer = buffer.slice(newline + 1);
          if (Buffer.byteLength(line) > 256) { fail('CHAT_POINTER_PROTOCOL_INVALID'); return; }
          consume(line);
        }
        if (Buffer.byteLength(buffer) > 256) fail('CHAT_POINTER_PROTOCOL_INVALID');
      });
      child.stderr.on('data', () => fail('CHAT_POINTER_NATIVE_FAILED'));
      child.stdin.on('error', () => fail('CHAT_POINTER_WRITE_FAILED'));
      child.on('error', () => fail('CHAT_POINTER_START_FAILED'));
      child.on('exit', () => { exited = true; fail('CHAT_POINTER_EXITED'); });
      arm(10000);
    } catch { fail('CHAT_POINTER_START_FAILED'); }
  };
  return {
    setEnabled(value) {
      if (closed || failed || enabled === value) return;
      enabled = value; generation += 1; acknowledged = -1;
      if (!child && value) start(); else update();
    },
    dispose() {
      if (disposal) return disposal;
      closed = true; enabled = false; clearTimer();
      if (!child || exited) { disposal = Promise.resolve(); return disposal; }
      // 正常 shutdown 后最多等待一秒；强制终止只针对所持有的子进程。
      disposal = new Promise<void>((resolve, reject) => {
        let settled = false;
        let forced: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error) => {
          if (settled) return; settled = true; clearTimeout(grace); clearTimeout(forced);
          child?.off('exit', onExit);
          if (error) reject(error); else resolve();
        };
        const onExit = () => finish();
        child!.once('exit', onExit);
        const grace = setTimeout(() => {
          try { if (!child!.kill()) { finish(new Error('CHAT_POINTER_CLOSE_FAILED')); return; } }
          catch { finish(new Error('CHAT_POINTER_CLOSE_FAILED')); return; }
          forced = setTimeout(() => finish(new Error('CHAT_POINTER_CLOSE_TIMEOUT')), 1000);
        }, 1000);
        write({ version: 1, type: 'shutdown' });
      });
      return disposal;
    }
  };
}
