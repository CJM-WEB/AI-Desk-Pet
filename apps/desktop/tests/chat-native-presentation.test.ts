import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launcher = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: launcher.spawn }));

// 固定启动端口的替身不观察真实桌面；协议与清理仍执行产品实现。
class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  kill = vi.fn(() => { queueMicrotask(() => this.emit('exit', null)); return true; });
  send(value: unknown) { this.stdout.write(`${JSON.stringify(value)}\n`); }
}

describe('聊天原生点击观察器', () => {
  let child: Child;
  beforeEach(() => { vi.useFakeTimers(); child = new Child(); launcher.spawn.mockReset().mockReturnValue(child); });
  afterEach(() => { vi.useRealTimers(); });

  it('原生资源只能安装WH_MOUSE_LL鼠标钩子，不能误用键盘钩子常量', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../resources/windows/chat-pointer-observer.cs'), 'utf8');
    expect(source).toMatch(/const int WhMouseLl = 14;/u);
    expect(source).toMatch(/hook = SetWindowsHookEx\(WhMouseLl,/u);
    expect(source).not.toMatch(/SetWindowsHookEx\(13,/u);
  });

  it('原生鼠标回调和消息泵不直接写stdout，输出队列有界并独立写出', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../resources/windows/chat-pointer-observer.cs'), 'utf8');
    const observe = source.slice(source.indexOf('private static IntPtr Observe'), source.indexOf('public static void Run'));
    expect(observe).not.toContain('Console.WriteLine');
    expect(source).toContain('private const int OutputCapacity = 64;');
    expect(source).toContain('output.IsBackground = true;');
  });

  async function create() {
    const module = await import('../src/main/windows/chat-native-pointer');
    expect(module.createChatPointerObserver).toBeTypeOf('function');
    const points: { x: number; y: number }[] = [];
    const failure = vi.fn();
    const observer = module.createChatPointerObserver({ resourceRoot: 'C:\\app\\resources', onPointerDown: point => points.push(point), onFailure: failure });
    return { observer, points, failure };
  }

  it('默认停用且关闭不创建进程', async () => {
    const { observer, points } = await create();
    observer.setEnabled(false);
    await observer.dispose();
    observer.setEnabled(true);
    expect(launcher.spawn).not.toHaveBeenCalled();
    expect(points).toEqual([]);
  });

  it('宿主失败提示抛错仍清理观察器，不让原生事件异常退出主进程', async () => {
    const { createChatPointerObserver } = await import('../src/main/windows/chat-native-pointer');
    const observer = createChatPointerObserver({ resourceRoot: 'C:\\app\\resources', onPointerDown: vi.fn(), onFailure: () => { throw new Error('window-gone'); } });
    observer.setEnabled(true);
    expect(() => child.stderr.write('native-error')).not.toThrow();
    expect(child.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); await observer.dispose();
  });

  it('固定隐藏启动；hello和启用确认之前不发布点击，停用立即失效', async () => {
    const { observer, points } = await create();
    observer.setEnabled(true);
    const [executable, args, options] = launcher.spawn.mock.calls[0]!;
    expect(executable).toMatch(/System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    expect(args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'C:\\app\\resources\\windows\\chat-pointer-observer.ps1']);
    expect(options).toMatchObject({ windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.send({ version: 1, type: 'ready' });
    expect(child.stdin.read()?.toString()).toBe('{"version":1,"type":"set-enabled","enabled":true,"generation":1}\n');
    child.send({ version: 1, type: 'pointer-down', generation: 1, x: 3, y: -4 });
    expect(points).toEqual([]);
    child.send({ version: 1, type: 'enabled', generation: 1 });
    child.stdout.write('{"version":1,"type":"pointer-down","generation":1,"x":3,');
    child.stdout.write('"y":-4}\n');
    expect(points).toEqual([{ x: 3, y: -4 }]);
    observer.setEnabled(false);
    child.send({ version: 1, type: 'pointer-down', generation: 1, x: 9, y: 8 });
    expect(points).toHaveLength(1);
    const disposed = observer.dispose();
    child.emit('exit', 0);
    await disposed;
  });

  it.each(['not-json\n', '{"version":1,"type":"pointer-down","generation":1,"x":1,"y":2,"text":"private"}\n', 'x'.repeat(257), '{"version":1,"type":"pointer-down","generation":1,"x":1.5,"y":2}\n'])('非法输出只报告固定错误并停止当前进程：%s', async raw => {
    const { observer, points, failure } = await create();
    observer.setEnabled(true);
    child.send({ version: 1, type: 'ready' });
    child.send({ version: 1, type: 'enabled', generation: 1 });
    child.stdout.write(raw);
    child.send({ version: 1, type: 'pointer-down', generation: 1, x: 4, y: 5 });
    expect(points).toEqual([]);
    expect(failure).toHaveBeenCalledExactlyOnceWith('CHAT_POINTER_PROTOCOL_INVALID');
    expect(child.kill).toHaveBeenCalledOnce();
    observer.setEnabled(true);
    expect(launcher.spawn).toHaveBeenCalledOnce();
    await observer.dispose();
  });

  it('启动失败不改变其他窗口与进程；错误不泄露原始内容', async () => {
    launcher.spawn.mockImplementation(() => { throw new Error('private path'); });
    const { observer, points, failure } = await create();
    observer.setEnabled(true);
    expect(failure).toHaveBeenCalledExactlyOnceWith('CHAT_POINTER_START_FAILED');
    expect(points).toEqual([]);
    expect(child.kill).not.toHaveBeenCalled();
    await observer.dispose();
  });

  it('沉默启动与未确认启用均有界失败', async () => {
    const first = await create();
    first.observer.setEnabled(true);
    await vi.advanceTimersByTimeAsync(10001);
    expect(first.failure).toHaveBeenCalledExactlyOnceWith('CHAT_POINTER_TIMEOUT');
    await first.observer.dispose();
    child = new Child(); launcher.spawn.mockReturnValue(child);
    const second = await create();
    second.observer.setEnabled(true);
    child.send({ version: 1, type: 'ready' });
    await vi.advanceTimersByTimeAsync(2001);
    expect(second.failure).toHaveBeenCalledExactlyOnceWith('CHAT_POINTER_TIMEOUT');
    await second.observer.dispose();
  });

  it('关闭先撤销点击，shutdown无响应时仅终止自己的进程且幂等', async () => {
    const { observer, points } = await create();
    observer.setEnabled(true);
    child.send({ version: 1, type: 'ready' });
    child.send({ version: 1, type: 'enabled', generation: 1 });
    const disposed = observer.dispose();
    expect(observer.dispose()).toBe(disposed);
    child.send({ version: 1, type: 'pointer-down', generation: 1, x: 1, y: 2 });
    await vi.advanceTimersByTimeAsync(1001);
    await disposed;
    expect(points).toEqual([]);
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
