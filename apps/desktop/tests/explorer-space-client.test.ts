import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  ExplorerSpaceClient,
  buildExplorerBridgeSpawnSpec,
  type ExplorerBridgeChild
} from '../src/main/habitat/explorer-space-client';

class FakeChild extends EventEmitter implements ExplorerBridgeChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 3210;
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  });
}

const bridgeSource = readFileSync(resolve(import.meta.dirname, '../resources/windows/explorer-space-bridge.ps1'), 'utf8');

const hello = '{"version":1,"type":"hello","nonce":"0123456789abcdef0123456789abcdef","sequence":0}\n';
const nextHello = '{"version":1,"type":"hello","nonce":"abcdef0123456789abcdef0123456789","sequence":0}\n';

function snapshotLine(input: { nonce?: string; sequence: number; instanceId: string }): string {
  return `${JSON.stringify({
    version: 1,
    type: 'explorer-snapshot',
    nonce: input.nonce ?? '0123456789abcdef0123456789abcdef',
    sequence: input.sequence,
    status: 'ready',
    windowType: 'explorer',
    instanceId: input.instanceId,
    hwnd: '43210',
    path: 'C:\\target',
    rect: { x: 0, y: 0, width: 800, height: 600 },
    foreground: true,
    minimized: false,
    search: false
  })}\n`;
}

function responseLine(input: { nonce: string; sequence: number; requestId: string }): string {
  return `${JSON.stringify({
    version: 1,
    type: 'response',
    nonce: input.nonce,
    sequence: input.sequence,
    requestId: input.requestId,
    ok: true
  })}\n`;
}

function heartbeatLine(input: { nonce?: string; sequence: number }): string {
  return `${JSON.stringify({
    version: 1,
    type: 'observer-heartbeat',
    nonce: input.nonce ?? '0123456789abcdef0123456789abcdef',
    sequence: input.sequence
  })}\n`;
}

describe('ExplorerSpaceClient', () => {
  it('沉默子进程在 hello 超时后失败并终止当前 child', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockImplementation(() => {
      setTimeout(() => child.emit('exit', null, 'SIGTERM'), 30);
      return true;
    });
    const unrelated = new FakeChild();
    const client = new ExplorerSpaceClient({ spawn: () => child, helloTimeoutMs: 100, closeTimeoutMs: 50 });
    client.on('error', () => undefined);
    const started = client.start();
    const rejected = expect(started).rejects.toThrow('BRIDGE_HELLO_TIMEOUT');
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(unrelated.kill).not.toHaveBeenCalled();
    let cleaned = false;
    const cleanup = client.waitForCleanup().then(() => { cleaned = true; });
    await vi.advanceTimersByTimeAsync(28);
    expect(cleaned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await cleanup;
    expect(client.snapshot()).toEqual({ state: 'failed', errorCode: 'BRIDGE_HELLO_TIMEOUT' });
    vi.useRealTimers();
  });

  it('hello 前后协议失败只终止各自持有的 child', async () => {
    const beforeHello = new FakeChild();
    const first = new ExplorerSpaceClient({ spawn: () => beforeHello });
    first.on('error', () => undefined);
    const firstStart = first.start();
    beforeHello.stdout.write('{"version":2}\n');
    await expect(firstStart).rejects.toThrow('BRIDGE_PROTOCOL_INVALID');
    expect(beforeHello.kill).toHaveBeenCalledOnce();

    const afterHello = new FakeChild();
    const second = new ExplorerSpaceClient({ spawn: () => afterHello });
    second.on('error', () => undefined);
    const secondStart = second.start();
    afterHello.stdout.write(hello);
    await secondStart;
    afterHello.stdout.write('{"version":1,"type":"explorer-snapshot","nonce":"0123456789abcdef0123456789abcdef","sequence":0,"status":"none"}\n');
    await vi.waitFor(() => expect(second.snapshot().errorCode).toBe('BRIDGE_PROTOCOL_INVALID'));
    expect(afterHello.kill).toHaveBeenCalledOnce();
    expect(beforeHello.kill).toHaveBeenCalledOnce();
  });

  it('使用固定 PowerShell、参数数组、隐藏窗口和最小环境，不覆盖 ExecutionPolicy', () => {
    const spec = buildExplorerBridgeSpawnSpec({
      windowsDirectory: 'C:\\Windows',
      resourceRoot: 'C:\\app\\resources',
      tempDirectory: 'C:\\Temp'
    });

    expect(spec.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(spec.args).toEqual([
      '-NoLogo', '-NoProfile', '-NonInteractive',
      '-File', 'C:\\app\\resources\\windows\\explorer-space-bridge.ps1'
    ]);
    expect(spec.args.join(' ')).not.toMatch(/ExecutionPolicy|Bypass/i);
    expect(spec.options).toMatchObject({ windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    expect(Object.keys(spec.options.env ?? {}).sort()).toEqual([
      'ComSpec', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR'
    ]);
  });

  it('hello 验证前不发送命令，验证后请求携带 nonce 和 requestId', async () => {
    const child = new FakeChild();
    const written: string[] = [];
    child.stdin.on('data', (chunk) => written.push(chunk.toString()));
    const client = new ExplorerSpaceClient({ spawn: () => child, requestTimeoutMs: 100 });
    const started = client.start();
    expect(written).toEqual([]);
    child.stdout.write(hello);
    await started;

    const request = client.startObserving();
    await vi.waitFor(() => expect(written).toHaveLength(1));
    const command = JSON.parse(written[0]!);
    expect(command).toMatchObject({
      version: 1,
      nonce: '0123456789abcdef0123456789abcdef',
      command: 'start-observing'
    });
    expect(command.requestId).toMatch(/^request-/);
    child.stdout.write(`${JSON.stringify({
      version: 1,
      type: 'response',
      nonce: command.nonce,
      sequence: 1,
      requestId: command.requestId,
      ok: true
    })}\n`);
    await expect(request).resolves.toEqual({ ok: true });
  });

  it('普通请求超时后终止 owned child，并等待真实 exit', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockImplementation(() => {
      setTimeout(() => child.emit('exit', null, 'SIGTERM'), 30);
      return true;
    });
    const unrelated = new FakeChild();
    const client = new ExplorerSpaceClient({ spawn: () => child, requestTimeoutMs: 20, closeTimeoutMs: 50 });
    client.on('error', () => undefined);
    const started = client.start();
    child.stdout.write(hello);
    await started;

    const rejected = expect(client.startObserving()).rejects.toThrow('BRIDGE_REQUEST_TIMEOUT');
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(unrelated.kill).not.toHaveBeenCalled();
    expect(client.snapshot()).toEqual({ state: 'failed', errorCode: 'BRIDGE_REQUEST_TIMEOUT' });

    let cleaned = false;
    const cleanup = client.waitForCleanup().then(() => { cleaned = true; });
    await vi.advanceTimersByTimeAsync(29);
    expect(cleaned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await cleanup;
    expect(client.snapshot()).toEqual({ state: 'failed', errorCode: 'BRIDGE_REQUEST_TIMEOUT' });
    vi.useRealTimers();
  });

  it('观察超时收到快照时续期，最终超时后等待 owned child 真实 exit', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockImplementation(() => {
      setTimeout(() => child.emit('exit', null, 'SIGTERM'), 30);
      return true;
    });
    const written: string[] = [];
    child.stdin.on('data', (chunk) => written.push(chunk.toString()));
    const client = new ExplorerSpaceClient({
      spawn: () => child,
      observationTimeoutMs: 20,
      requestTimeoutMs: 20,
      closeTimeoutMs: 50
    });
    client.on('error', () => undefined);
    const started = client.start();
    child.stdout.write(hello);
    await started;

    const observing = client.startObserving();
    expect(written).toHaveLength(1);
    const command = JSON.parse(written[0]!);
    child.stdout.write(`${JSON.stringify({
      version: 1,
      type: 'response',
      nonce: command.nonce,
      sequence: 1,
      requestId: command.requestId,
      ok: true
    })}\n`);
    await observing;
    await vi.advanceTimersByTimeAsync(19);
    child.stdout.write('{"version":1,"type":"explorer-snapshot","nonce":"0123456789abcdef0123456789abcdef","sequence":2,"status":"none"}\n');
    await vi.advanceTimersByTimeAsync(19);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(client.snapshot()).toEqual({ state: 'failed', errorCode: 'BRIDGE_OBSERVATION_TIMEOUT' });

    let cleaned = false;
    const cleanup = client.waitForCleanup().then(() => { cleaned = true; });
    await vi.advanceTimersByTimeAsync(29);
    expect(cleaned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await cleanup;
    expect(client.snapshot().state).not.toBe('closed');
    vi.useRealTimers();
  });

  it('稳定快照去重超过五秒时由无事实心跳续期，且不发出额外 snapshot', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const written: string[] = [];
    const snapshots: unknown[] = [];
    child.stdin.on('data', chunk => written.push(chunk.toString()));
    const client = new ExplorerSpaceClient({
      spawn: () => child, observationTimeoutMs: 5_000, requestTimeoutMs: 100
    });
    client.on('snapshot', value => snapshots.push(value));
    client.on('error', () => undefined);
    const started = client.start();
    child.stdout.write(hello);
    await started;
    const observing = client.startObserving();
    const command = JSON.parse(written[0]!);
    child.stdout.write(responseLine({ nonce: command.nonce, sequence: 1, requestId: command.requestId }));
    await observing;
    child.stdout.write(snapshotLine({ sequence: 2, instanceId: 'stable-a' }));
    await vi.advanceTimersByTimeAsync(4_000);
    child.stdout.write(heartbeatLine({ sequence: 3 }));
    await vi.advanceTimersByTimeAsync(4_000);
    child.stdout.write(heartbeatLine({ sequence: 4 }));
    await vi.advanceTimersByTimeAsync(4_000);

    expect(client.snapshot()).toEqual({ state: 'ready' });
    expect(child.kill).not.toHaveBeenCalled();
    expect(snapshots).toHaveLength(1);
    vi.useRealTimers();
  });

  it('stop-observing 成功后不再要求心跳', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const written: string[] = [];
    child.stdin.on('data', chunk => written.push(chunk.toString()));
    const client = new ExplorerSpaceClient({
      spawn: () => child, observationTimeoutMs: 20, requestTimeoutMs: 100
    });
    const started = client.start();
    child.stdout.write(hello);
    await started;
    const observing = client.startObserving();
    let command = JSON.parse(written[0]!);
    child.stdout.write(responseLine({ nonce: command.nonce, sequence: 1, requestId: command.requestId }));
    await observing;
    const stopping = client.stopObserving();
    command = JSON.parse(written[1]!);
    child.stdout.write(responseLine({ nonce: command.nonce, sequence: 2, requestId: command.requestId }));
    await stopping;
    child.stdout.write(heartbeatLine({ sequence: 3 }));
    await vi.advanceTimersByTimeAsync(100);

    expect(client.snapshot()).toEqual({ state: 'ready' });
    expect(child.kill).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('心跳不延长普通请求超时', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const written: string[] = [];
    child.stdin.on('data', chunk => written.push(chunk.toString()));
    const client = new ExplorerSpaceClient({
      spawn: () => child, observationTimeoutMs: 100, requestTimeoutMs: 20
    });
    client.on('error', () => undefined);
    const started = client.start();
    child.stdout.write(hello);
    await started;
    const observing = client.startObserving();
    const command = JSON.parse(written[0]!);
    child.stdout.write(responseLine({ nonce: command.nonce, sequence: 1, requestId: command.requestId }));
    await observing;

    const pending = expect(client.stopObserving()).rejects.toThrow('BRIDGE_REQUEST_TIMEOUT');
    await vi.advanceTimersByTimeAsync(19);
    child.stdout.write(heartbeatLine({ sequence: 2 }));
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(client.snapshot().errorCode).toBe('BRIDGE_REQUEST_TIMEOUT');
    vi.useRealTimers();
  });

  it('心跳沿用当前 generation 的 nonce 与严格递增序列', async () => {
    const wrongNonceChild = new FakeChild();
    const wrongNonceClient = new ExplorerSpaceClient({ spawn: () => wrongNonceChild });
    wrongNonceClient.on('error', () => undefined);
    const wrongNonceStart = wrongNonceClient.start();
    wrongNonceChild.stdout.write(hello);
    await wrongNonceStart;
    wrongNonceChild.stdout.write(heartbeatLine({
      nonce: 'abcdef0123456789abcdef0123456789', sequence: 1
    }));
    expect(wrongNonceClient.snapshot().errorCode).toBe('BRIDGE_NONCE_INVALID');

    const maxSequenceChild = new FakeChild();
    const maxSequenceClient = new ExplorerSpaceClient({ spawn: () => maxSequenceChild });
    maxSequenceClient.on('error', () => undefined);
    const maxSequenceStart = maxSequenceClient.start();
    maxSequenceChild.stdout.write(hello);
    await maxSequenceStart;
    maxSequenceChild.stdout.write(heartbeatLine({ sequence: Number.MAX_SAFE_INTEGER }));
    expect(maxSequenceClient.snapshot().errorCode).toBe('BRIDGE_PROTOCOL_INVALID');
    await maxSequenceClient.waitForCleanup();
    expect(maxSequenceChild.kill).toHaveBeenCalledOnce();

    const repeatedChild = new FakeChild();
    const repeatedClient = new ExplorerSpaceClient({ spawn: () => repeatedChild });
    repeatedClient.on('error', () => undefined);
    const repeatedStart = repeatedClient.start();
    repeatedChild.stdout.write(hello);
    await repeatedStart;
    repeatedChild.stdout.write(heartbeatLine({ sequence: 1 }));
    repeatedChild.stdout.write(heartbeatLine({ sequence: 1 }));
    expect(repeatedClient.snapshot().errorCode).toBe('BRIDGE_SEQUENCE_INVALID');
  });

  it('请求超时后的 kill 拒绝与 exit 超时均不能伪报 closed', async () => {
    vi.useFakeTimers();
    const refusedChild = new FakeChild();
    refusedChild.kill.mockReturnValue(false);
    const refused = new ExplorerSpaceClient({ spawn: () => refusedChild, requestTimeoutMs: 10, closeTimeoutMs: 20 });
    refused.on('error', () => undefined);
    const refusedStart = refused.start();
    refusedChild.stdout.write(hello);
    await refusedStart;
    const refusedRequest = expect(refused.startObserving()).rejects.toThrow('BRIDGE_REQUEST_TIMEOUT');
    await vi.advanceTimersByTimeAsync(10);
    await refusedRequest;
    await expect(refused.waitForCleanup()).rejects.toThrow('BRIDGE_PROCESS_TERMINATION_FAILED');
    expect(refused.snapshot()).toEqual({ state: 'failed', errorCode: 'BRIDGE_REQUEST_TIMEOUT' });

    const stuckChild = new FakeChild();
    stuckChild.kill.mockReturnValue(true);
    const stuck = new ExplorerSpaceClient({ spawn: () => stuckChild, requestTimeoutMs: 10, closeTimeoutMs: 20 });
    stuck.on('error', () => undefined);
    const stuckStart = stuck.start();
    stuckChild.stdout.write(nextHello);
    await stuckStart;
    const stuckRequest = expect(stuck.startObserving()).rejects.toThrow('BRIDGE_REQUEST_TIMEOUT');
    await vi.advanceTimersByTimeAsync(10);
    await stuckRequest;
    const cleanup = expect(stuck.waitForCleanup()).rejects.toThrow('BRIDGE_PROCESS_EXIT_TIMEOUT');
    await vi.advanceTimersByTimeAsync(20);
    await cleanup;
    expect(stuck.snapshot()).toEqual({ state: 'failed', errorCode: 'BRIDGE_REQUEST_TIMEOUT' });
    vi.useRealTimers();
  });

  it('同一客户端关闭后可重启，完整隔离旧 generation 并重新生成 opaque instanceId', async () => {
    const oldChild = new FakeChild();
    const newChild = new FakeChild();
    const children = [oldChild, newChild];
    const oldWritten: string[] = [];
    const newWritten: string[] = [];
    oldChild.stdin.on('data', (chunk) => oldWritten.push(chunk.toString()));
    newChild.stdin.on('data', (chunk) => newWritten.push(chunk.toString()));
    const client = new ExplorerSpaceClient({ spawn: () => children.shift()! });
    const snapshots: string[] = [];
    const diagnostics: string[] = [];
    client.on('error', () => undefined);
    client.on('snapshot', (value: { instanceId?: string }) => snapshots.push(value.instanceId ?? ''));
    client.on('diagnostic', (value: string) => diagnostics.push(value));
    const oldStart = client.start();
    oldChild.stdout.write(hello);
    await oldStart;
    oldChild.stdout.write(snapshotLine({ sequence: 1, instanceId: 'same-helper-instance' }));
    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    expect(snapshots[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshots[0]).not.toContain('same-helper-instance');
    expect(snapshots[0]).not.toContain('0123456789abcdef0123456789abcdef');
    oldChild.stderr.write('OLD_PARTIAL');

    const closing = client.close();
    await vi.waitFor(() => expect(oldWritten).toHaveLength(1));
    const shutdown = JSON.parse(oldWritten[0]!);
    oldChild.stdout.write(snapshotLine({ sequence: 999, instanceId: 'closing-instance' }));
    oldChild.stdout.write(responseLine({ nonce: shutdown.nonce, sequence: 999, requestId: 'request-999' }));
    oldChild.stderr.write('SHELL_COM_UNAVAILABLE\n');
    expect(snapshots).toHaveLength(1);
    expect(diagnostics).toEqual([]);
    oldChild.stdout.write(responseLine({ nonce: shutdown.nonce, sequence: 2, requestId: shutdown.requestId }));
    oldChild.emit('exit', null, null);
    await closing;

    const newStart = client.start();
    newChild.stdout.write(nextHello);
    await newStart;
    newChild.stdout.write(snapshotLine({
      nonce: 'abcdef0123456789abcdef0123456789',
      sequence: 1,
      instanceId: 'same-helper-instance'
    }));
    await vi.waitFor(() => expect(snapshots).toHaveLength(2));
    expect(snapshots[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshots[1]).not.toBe(snapshots[0]);
    newChild.stderr.write('SHELL_COM_UNAVAILABLE\n');
    await vi.waitFor(() => expect(diagnostics).toEqual(['SHELL_COM_UNAVAILABLE']));

    oldChild.stdout.write(snapshotLine({ sequence: 999, instanceId: 'stale-instance' }));
    oldChild.stdout.write(heartbeatLine({ sequence: Number.MAX_SAFE_INTEGER }));
    oldChild.emit('error', new Error('stale-child-error'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.snapshot().state).toBe('ready');
    expect(snapshots).toHaveLength(2);

    const newRequest = client.startObserving();
    await vi.waitFor(() => expect(newWritten).toHaveLength(1));
    const command = JSON.parse(newWritten[0]!);
    expect(command.requestId).toBe('request-1');
    newChild.stdout.write(responseLine({ nonce: command.nonce, sequence: 2, requestId: command.requestId }));
    await expect(newRequest).resolves.toEqual({ ok: true });
  });

  it('失败且 cleanup 成功后同一客户端可真实 spawn 新 child', async () => {
    const failedChild = new FakeChild();
    const recoveredChild = new FakeChild();
    const children = [failedChild, recoveredChild];
    const client = new ExplorerSpaceClient({ spawn: () => children.shift()! });
    client.on('error', () => undefined);

    const failedStart = client.start();
    failedChild.stdout.write('{"version":2}\n');
    await expect(failedStart).rejects.toThrow('BRIDGE_PROTOCOL_INVALID');
    await client.waitForCleanup();

    const recoveredStart = client.start();
    recoveredChild.stdout.write(nextHello);
    await recoveredStart;
    expect(client.snapshot()).toEqual({ state: 'ready' });
    expect(children).toHaveLength(0);
  });

  it('starting 期间 close 会拒绝 start、回收 child，且 closing 不发出快照', async () => {
    const child = new FakeChild();
    const snapshots: unknown[] = [];
    const client = new ExplorerSpaceClient({ spawn: () => child });
    client.on('snapshot', (value) => snapshots.push(value));
    const started = client.start();
    const closing = client.close();
    child.stdout.write(snapshotLine({ sequence: 1, instanceId: 'must-not-emit' }));

    await expect(started).rejects.toThrow('BRIDGE_CLOSE_REQUESTED');
    await closing;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(snapshots).toEqual([]);
    expect(client.snapshot()).toEqual({ state: 'closed' });
  });

  it('failed 后 close 只等待 cleanup，不得覆盖为 closed', async () => {
    const child = new FakeChild();
    const client = new ExplorerSpaceClient({ spawn: () => child });
    client.on('error', () => undefined);
    const started = client.start();
    child.stdout.write('{"version":2}\n');
    await expect(started).rejects.toThrow('BRIDGE_PROTOCOL_INVALID');
    await client.close();
    expect(client.snapshot()).toEqual({ state: 'failed', errorCode: 'BRIDGE_PROTOCOL_INVALID' });
  });

  it.each([
    { name: 'kill 返回 false', kill: (child: FakeChild) => child.kill.mockReturnValue(false) },
    { name: 'kill 抛错', kill: (child: FakeChild) => child.kill.mockImplementation(() => { throw new Error('denied'); }) }
  ])('关闭时$name：旧 child 未退出前拒绝重启，真实退出后才 spawn', async ({ kill }) => {
    vi.useFakeTimers();
    const oldChild = new FakeChild();
    const newChild = new FakeChild();
    kill(oldChild);
    const children = [oldChild, newChild];
    const client = new ExplorerSpaceClient({
      spawn: () => children.shift()!,
      requestTimeoutMs: 10,
      closeTimeoutMs: 10
    });
    const started = client.start();
    oldChild.stdout.write(hello);
    await started;

    const closing = expect(client.close()).rejects.toThrow('BRIDGE_PROCESS_TERMINATION_FAILED');
    await vi.advanceTimersByTimeAsync(21);
    await closing;
    await expect(client.start()).rejects.toThrow('BRIDGE_PREVIOUS_PROCESS_ACTIVE');
    expect(children).toHaveLength(1);

    oldChild.emit('exit', null, 'SIGTERM');
    const restarted = client.start();
    newChild.stdout.write(nextHello);
    await restarted;
    expect(client.snapshot()).toEqual({ state: 'ready' });
    expect(children).toHaveLength(0);
    vi.useRealTimers();
  });

  it('关闭 exit-timeout 后旧 child 存活时不 spawn，迟到真实 exit 后才允许', async () => {
    vi.useFakeTimers();
    const oldChild = new FakeChild();
    const newChild = new FakeChild();
    oldChild.kill.mockReturnValue(true);
    const children = [oldChild, newChild];
    const client = new ExplorerSpaceClient({
      spawn: () => children.shift()!,
      requestTimeoutMs: 10,
      closeTimeoutMs: 10
    });
    const started = client.start();
    oldChild.stdout.write(hello);
    await started;

    const closing = expect(client.close()).rejects.toThrow('BRIDGE_PROCESS_EXIT_TIMEOUT');
    await vi.advanceTimersByTimeAsync(31);
    await closing;
    await expect(client.start()).rejects.toThrow('BRIDGE_PREVIOUS_PROCESS_ACTIVE');
    expect(children).toHaveLength(1);

    oldChild.emit('exit', null, 'SIGTERM');
    const restarted = client.start();
    newChild.stdout.write(nextHello);
    await restarted;
    expect(client.snapshot()).toEqual({ state: 'ready' });
    vi.useRealTimers();
  });

  it('failed cleanup 后排队的 restart 会被并发 close-intent 取消', async () => {
    vi.useFakeTimers();
    const oldChild = new FakeChild();
    const unexpectedChild = new FakeChild();
    oldChild.kill.mockImplementation(() => {
      setTimeout(() => oldChild.emit('exit', null, 'SIGTERM'), 30);
      return true;
    });
    const children = [oldChild, unexpectedChild];
    const client = new ExplorerSpaceClient({
      spawn: () => children.shift()!,
      requestTimeoutMs: 10,
      closeTimeoutMs: 50
    });
    client.on('error', () => undefined);
    const started = client.start();
    oldChild.stdout.write(hello);
    await started;
    const failedRequest = expect(client.startObserving()).rejects.toThrow('BRIDGE_REQUEST_TIMEOUT');
    await vi.advanceTimersByTimeAsync(10);
    await failedRequest;

    const restart = expect(client.start()).rejects.toThrow('BRIDGE_RESTART_CANCELLED');
    const closing = client.close();
    await vi.advanceTimersByTimeAsync(30);
    await restart;
    await closing;
    expect(children).toHaveLength(1);
    expect(client.snapshot()).toEqual({ state: 'failed', errorCode: 'BRIDGE_REQUEST_TIMEOUT' });
    vi.useRealTimers();
  });

  it('close await 期间 write fail 时保持 failed，不得在 continuation 写入 closed', async () => {
    const child = new FakeChild();
    vi.spyOn(child.stdin, 'write').mockImplementation(((
      _chunk: unknown,
      callback: (error?: Error | null) => void
    ) => {
      queueMicrotask(() => callback(new Error('write failed')));
      return false;
    }) as never);
    const client = new ExplorerSpaceClient({ spawn: () => child });
    client.on('error', () => undefined);
    const started = client.start();
    child.stdout.write(hello);
    await started;

    await client.close();
    expect(client.snapshot()).toEqual({ state: 'failed', errorCode: 'BRIDGE_WRITE_FAILED' });
  });

  it('child exit 会立即拒绝普通 pending 与 closing 中的 shutdown，不等待请求超时', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const written: string[] = [];
    child.stdin.on('data', (chunk) => written.push(chunk.toString()));
    const client = new ExplorerSpaceClient({ spawn: () => child, requestTimeoutMs: 10_000 });
    client.on('error', () => undefined);
    const started = client.start();
    child.stdout.write(hello);
    await started;
    const request = client.startObserving();
    child.emit('exit', 1, null);
    await expect(request).rejects.toThrow('BRIDGE_PROCESS_EXITED');
    expect(client.snapshot()).toEqual({ state: 'failed', errorCode: 'BRIDGE_PROCESS_EXITED' });

    const closingChild = new FakeChild();
    const closingClient = new ExplorerSpaceClient({ spawn: () => closingChild, requestTimeoutMs: 10_000 });
    const closingStart = closingClient.start();
    closingChild.stdout.write(nextHello);
    await closingStart;
    const closingRequest = closingClient.startObserving();
    const closing = closingClient.close();
    closingChild.stdout.write(snapshotLine({
      nonce: 'abcdef0123456789abcdef0123456789',
      sequence: 1,
      instanceId: 'closing-instance'
    }));
    closingChild.emit('exit', 0, null);
    await expect(closingRequest).rejects.toThrow('BRIDGE_PROCESS_EXITED');
    await closing;
    expect(closingClient.snapshot()).toEqual({ state: 'closed' });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('stdin.write error 会 fail 并回收 owned child', async () => {
    const child = new FakeChild();
    vi.spyOn(child.stdin, 'write').mockImplementation(((
      _chunk: unknown,
      callback: (error?: Error | null) => void
    ) => {
      queueMicrotask(() => callback(new Error('write failed')));
      return false;
    }) as never);
    const client = new ExplorerSpaceClient({ spawn: () => child });
    client.on('error', () => undefined);
    const started = client.start();
    child.stdout.write(hello);
    await started;

    await expect(client.startObserving()).rejects.toThrow('BRIDGE_WRITE_FAILED');
    expect(child.kill).toHaveBeenCalledOnce();
    await client.waitForCleanup();
    expect(client.snapshot()).toEqual({ state: 'failed', errorCode: 'BRIDGE_WRITE_FAILED' });
  });

  it('kill 抛错按终止失败收口，不遗失原始失败态', async () => {
    const child = new FakeChild();
    child.kill.mockImplementation(() => { throw new Error('access denied'); });
    const client = new ExplorerSpaceClient({ spawn: () => child });
    client.on('error', () => undefined);
    const started = client.start();
    child.stdout.write('{"version":2}\n');

    await expect(started).rejects.toThrow('BRIDGE_PROTOCOL_INVALID');
    await expect(client.waitForCleanup()).rejects.toThrow('BRIDGE_PROCESS_TERMINATION_FAILED');
    expect(client.snapshot()).toEqual({ state: 'failed', errorCode: 'BRIDGE_PROTOCOL_INVALID' });
  });

  it('拒绝重复序号、错误 nonce 与过期响应', async () => {
    const child = new FakeChild();
    const client = new ExplorerSpaceClient({ spawn: () => child, requestTimeoutMs: 10 });
    const failures: string[] = [];
    client.on('error', (error) => failures.push((error as Error).message));
    const started = client.start();
    child.stdout.write(hello);
    await started;
    child.stdout.write('{"version":1,"type":"explorer-snapshot","nonce":"0123456789abcdef0123456789abcdef","sequence":1,"status":"none"}\n');
    child.stdout.write('{"version":1,"type":"explorer-snapshot","nonce":"0123456789abcdef0123456789abcdef","sequence":1,"status":"none"}\n');
    await vi.waitFor(() => expect(failures).toContain('BRIDGE_SEQUENCE_INVALID'));

    const child2 = new FakeChild();
    const client2 = new ExplorerSpaceClient({ spawn: () => child2, requestTimeoutMs: 10 });
    client2.on('error', () => undefined);
    const started2 = client2.start();
    child2.stdout.write(hello);
    await started2;
    await expect(client2.startObserving()).rejects.toThrow('BRIDGE_REQUEST_TIMEOUT');
    child2.stdout.write('{"version":1,"type":"response","nonce":"ffffffffffffffffffffffffffffffff","sequence":1,"requestId":"request-1","ok":true}\n');
    await vi.waitFor(() => expect(client2.snapshot().state).toBe('failed'));
  });

  it('超长 stdout 与泄密 stderr 均使客户端失败', async () => {
    const child = new FakeChild();
    const client = new ExplorerSpaceClient({ spawn: () => child });
    client.on('error', () => undefined);
    void client.start().catch(() => undefined);
    child.stdout.write(`${'x'.repeat(16 * 1024 + 1)}\n`);
    await vi.waitFor(() => expect(client.snapshot().errorCode).toBe('BRIDGE_LINE_TOO_LONG'));

    const child2 = new FakeChild();
    const client2 = new ExplorerSpaceClient({ spawn: () => child2 });
    client2.on('error', () => undefined);
    void client2.start().catch(() => undefined);
    child2.stderr.write('C:\\private\\folder\n');
    await vi.waitFor(() => expect(client2.snapshot().errorCode).toBe('BRIDGE_STDERR_INVALID'));
  });

  it('关闭先请求 shutdown，超时后只终止已验证 PID', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockReturnValue(true);
    const written: string[] = [];
    child.stdin.on('data', (chunk) => written.push(chunk.toString()));
    const client = new ExplorerSpaceClient({
      spawn: () => child,
      requestTimeoutMs: 50,
      closeTimeoutMs: 100
    });
    const started = client.start();
    child.stdout.write(hello);
    await started;
    const closing = client.close();
    const rejected = expect(closing).rejects.toThrow('BRIDGE_PROCESS_EXIT_TIMEOUT');
    await vi.advanceTimersByTimeAsync(251);
    await rejected;
    expect(JSON.parse(written[0]!)).toMatchObject({ command: 'shutdown' });
    expect(child.kill).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('终止后继续等待 child 的真实 exit，不能提前标记 closed', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockImplementation(() => {
      setTimeout(() => child.emit('exit', null, 'SIGTERM'), 20);
      return true;
    });
    const client = new ExplorerSpaceClient({ spawn: () => child, requestTimeoutMs: 20, closeTimeoutMs: 40 });
    const started = client.start();
    child.stdout.write(hello);
    await started;
    let settled = false;
    const closing = client.close().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(61);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(client.snapshot().state).toBe('closing');
    await vi.advanceTimersByTimeAsync(20);
    await closing;
    expect(client.snapshot().state).toBe('closed');
    vi.useRealTimers();
  });

  it('child 拒绝终止时关闭失败，不能伪报 closed', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockReturnValue(false);
    const client = new ExplorerSpaceClient({ spawn: () => child, requestTimeoutMs: 20, closeTimeoutMs: 40 });
    const started = client.start();
    child.stdout.write(hello);
    await started;
    const closing = client.close();
    const rejected = expect(closing).rejects.toThrow('BRIDGE_PROCESS_TERMINATION_FAILED');
    await vi.advanceTimersByTimeAsync(61);
    await rejected;
    expect(client.snapshot()).toEqual({ state: 'failed', errorCode: 'BRIDGE_PROCESS_TERMINATION_FAILED' });
    vi.useRealTimers();
  });

  it('协议失败公开 cleanup promise，并等待真实 exit', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockImplementation(() => {
      setTimeout(() => child.emit('exit', null, 'SIGTERM'), 30);
      return true;
    });
    const client = new ExplorerSpaceClient({ spawn: () => child, closeTimeoutMs: 50 });
    client.on('error', () => undefined);
    const started = client.start();
    child.stdout.write('{"version":2}\n');
    await expect(started).rejects.toThrow('BRIDGE_PROTOCOL_INVALID');
    let cleaned = false;
    const cleanup = client.waitForCleanup().then(() => { cleaned = true; });
    await vi.advanceTimersByTimeAsync(29);
    expect(cleaned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await cleanup;
    vi.useRealTimers();
  });

  it('生产桥接只调用精确 Shell 标签 Helper，旧 UIA 观察器不再参与组合', () => {
    expect(bridgeSource).toMatch(/ObserveActiveExplorer\s*\(\s*\)/);
    expect(bridgeSource).toMatch(/\[AiPet\.ExplorerSpace\.RestrictedExplorerShellTabObserver\]::ObserveActiveExplorer\s*\(\s*\)/u);
    expect(bridgeSource).not.toMatch(/\[RestrictedExplorerObserver\]::ObserveActiveExplorer\s*\(\s*\)/u);
  });

  it('固定桥接源码彻底拒绝旧 UIA、实例 LRU 与外层窗口归因', () => {
    expect(bridgeSource).toMatch(/InputCapacity\s*=\s*8/);
    expect(bridgeSource).toMatch(/type\s*=\s*'observer-heartbeat'/);
    expect(bridgeSource).toMatch(/heartbeatIntervalMilliseconds\s*=\s*1000/);
    expect(bridgeSource).toMatch(/fingerprint\s*-eq\s*\$lastSnapshot\)\s*\{\s*return\s*\}/);
    expect(bridgeSource).toMatch(/status\s*-eq\s*'unavailable'[\s\S]{0,160}\$script:shutdown\s*=\s*\$true/i);
    for (const forbidden of [
      'System.Windows.Automation', 'UIAutomation', 'RestrictedExplorerObserver',
      'ExplorerInstanceLru', 'Shell.Application', 'Get-WindowClass', 'Test-ExplorerWindow',
      'GetWindowText', 'RootElement', 'FindAll(', 'TryGetCurrentPattern', 'InvokePattern',
      'SetValue', 'SendKeys', 'mouse_event', 'keybd_event', 'Screenshot'
    ]) expect(bridgeSource).not.toContain(forbidden);
  });
});
