import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EXPLORER_SPACE_MAX_LINE_BYTES,
  parseBridgeLine,
  parseBridgeStderrLine,
  serializeBridgeCommand
} from '../src/main/habitat/explorer-space-protocol';

const nonce = '0123456789abcdef0123456789abcdef';
describe('资源管理器空间桥接协议', () => {
  it('协议源码不保留旧 UIA profile 事实或策略函数', () => {
    const source = readFileSync(resolve(
      import.meta.dirname, '../src/main/habitat/explorer-space-protocol.ts'
    ), 'utf8');
    for (const forbidden of [
      'RestrictedExplorerObservationFacts', 'evaluateRestrictedExplorerObservation',
      'visitedNodes', 'maxDepth', 'selectedTabCount', 'addressCount',
      'runtimeStable', 'shellPathMatchCount'
    ]) expect(source).not.toContain(forbidden);
  });

  it('接受带版本、进程 nonce 与初始序号的 hello', () => {
    expect(parseBridgeLine(JSON.stringify({
      version: 1,
      type: 'hello',
      nonce,
      sequence: 0
    }))).toEqual({ version: 1, type: 'hello', nonce, sequence: 0 });
  });

  it('心跳只接受协议身份字段，拒绝任何 Explorer 事实或额外字段', () => {
    expect(parseBridgeLine(JSON.stringify({
      version: 1, type: 'observer-heartbeat', nonce, sequence: 1
    }))).toEqual({ version: 1, type: 'observer-heartbeat', nonce, sequence: 1 });

    for (const extra of [
      { status: 'ready' }, { path: 'C:\\secret' }, { hwnd: '10' },
      { instanceId: 'A' }, { rect: { x: 0, y: 0, width: 1, height: 1 } }
    ]) {
      expect(() => parseBridgeLine(JSON.stringify({
        version: 1, type: 'observer-heartbeat', nonce, sequence: 1, ...extra
      }))).toThrow('BRIDGE_PROTOCOL_INVALID');
    }
    expect(() => parseBridgeLine(JSON.stringify({
      version: 1, type: 'observer-heartbeat', nonce: 'wrong', sequence: 1
    }))).toThrow('BRIDGE_PROTOCOL_INVALID');
    expect(() => parseBridgeLine(JSON.stringify({
      version: 1, type: 'observer-heartbeat', nonce, sequence: Number.MAX_SAFE_INTEGER
    }))).toThrow('BRIDGE_PROTOCOL_INVALID');
  });

  it.each([
    { version: 2, type: 'hello', nonce, sequence: 0 },
    { version: 1, type: 'hello', nonce, sequence: 0, extra: true },
    { version: 1, type: 'hello', nonce: '', sequence: 0 },
    { version: 1, type: 'hello', nonce, sequence: 1 }
  ])('严格拒绝无效 hello：%j', (value) => {
    expect(() => parseBridgeLine(JSON.stringify(value))).toThrow('BRIDGE_PROTOCOL_INVALID');
  });

  it('接受准确、歧义、无候选和组件不可用四种 Explorer 快照', () => {
    expect(parseBridgeLine(JSON.stringify({
      version: 1,
      type: 'explorer-snapshot',
      nonce,
      sequence: 1,
      status: 'ready',
      windowType: 'explorer',
      instanceId: 'shell-window-1',
      hwnd: '43210',
      path: 'C:\\测试 空间\\#100%\\🦊',
      rect: { x: -1200, y: 10, width: 1000, height: 700 },
      foreground: true,
      minimized: false,
      search: false
    }))).toMatchObject({ status: 'ready', sequence: 1, hwnd: '43210' });

    expect(parseBridgeLine(JSON.stringify({
      version: 1,
      type: 'explorer-snapshot',
      nonce,
      sequence: 2,
      status: 'ambiguous'
    }))).toMatchObject({ status: 'ambiguous' });

    expect(parseBridgeLine(JSON.stringify({
      version: 1,
      type: 'explorer-snapshot',
      nonce,
      sequence: 3,
      status: 'none'
    }))).toMatchObject({ status: 'none' });

    expect(parseBridgeLine(JSON.stringify({
      version: 1,
      type: 'explorer-snapshot',
      nonce,
      sequence: 4,
      status: 'unavailable'
    }))).toMatchObject({ status: 'unavailable' });
  });

  it('Shell/COM 不可用保持 unavailable，不能降格为 none', () => {
    const parsed = parseBridgeLine(JSON.stringify({
      version: 1,
      type: 'explorer-snapshot',
      nonce,
      sequence: 1,
      status: 'unavailable'
    }));

    expect(parsed).toMatchObject({ type: 'explorer-snapshot', status: 'unavailable' });
    expect(parsed).not.toMatchObject({ status: 'none' });
  });

  it.each([
    { status: 'ready', windowType: 'dialog' },
    { status: 'ready', windowType: 'explorer', path: '' },
    { status: 'ready', windowType: 'explorer', rect: { x: 0, y: 0, width: 0, height: 10 } },
    { status: 'ready', windowType: 'explorer', rect: { x: 0, y: 0, width: 10, height: Number.NaN } },
    { status: 'ready', tabHwnd: '76543' }
  ])('拒绝不准确的 Explorer 事实：%j', (override) => {
    const base = {
      version: 1,
      type: 'explorer-snapshot',
      nonce,
      sequence: 1,
      status: 'ready',
      windowType: 'explorer',
      instanceId: 'shell-window-1',
      hwnd: '43210',
      path: 'C:\\target',
      rect: { x: 0, y: 0, width: 800, height: 600 },
      foreground: true,
      minimized: false,
      search: false
    };
    expect(() => parseBridgeLine(JSON.stringify({ ...base, ...override }))).toThrow('BRIDGE_PROTOCOL_INVALID');
  });

  it.each([
    {
      base: { status: 'ambiguous' },
      forbidden: { candidateHwnds: ['76543'] }
    },
    {
      base: { status: 'none' },
      forbidden: { title: '不得读取或泄露窗口标题' }
    },
    {
      base: { status: 'unavailable' },
      forbidden: { unmatchedPath: 'C:\\不得泄露未匹配路径' }
    }
  ])('非 ready 快照只因追加禁用字段而被拒绝：%j', ({ base, forbidden }) => {
    const minimal = {
      version: 1,
      type: 'explorer-snapshot',
      nonce,
      sequence: 1,
      ...base
    };

    expect(parseBridgeLine(JSON.stringify(minimal))).toMatchObject(base);
    expect(() => parseBridgeLine(JSON.stringify({ ...minimal, ...forbidden })))
      .toThrow('BRIDGE_PROTOCOL_INVALID');
  });

  it('拒绝超长行、乱码 JSON 和未知字段', () => {
    expect(() => parseBridgeLine('x'.repeat(EXPLORER_SPACE_MAX_LINE_BYTES + 1))).toThrow('BRIDGE_LINE_TOO_LONG');
    expect(() => parseBridgeLine('{')).toThrow('BRIDGE_JSON_INVALID');
    expect(() => parseBridgeLine(JSON.stringify({
      version: 1,
      type: 'response',
      nonce,
      sequence: 1,
      requestId: 'request-1',
      ok: true,
      unknown: true
    }))).toThrow('BRIDGE_PROTOCOL_INVALID');
  });

  it.each([
    { command: 'start-observing' },
    { command: 'stop-observing' },
    { command: 'shutdown' }
  ])('只序列化固定命令：%j', (command) => {
    const line = serializeBridgeCommand({
      version: 1,
      nonce,
      requestId: 'request-1',
      ...command
    } as Parameters<typeof serializeBridgeCommand>[0]);
    expect(JSON.parse(line)).toMatchObject(command);
    expect(line.endsWith('\n')).toBe(true);
  });

  it('拒绝未知命令与命令未知字段', () => {
    for (const command of [
      { command: 'place-near', explorerHwnd: '10', petHwnd: '20' },
      { command: 'remove-layer', petHwnd: '20' }
    ]) {
      expect(() => serializeBridgeCommand({
        version: 1, nonce, requestId: 'request-1', ...command
      } as never)).toThrow('BRIDGE_COMMAND_INVALID');
    }
    expect(() => serializeBridgeCommand({
      version: 1,
      nonce,
      requestId: 'request-1',
      command: 'run-powershell'
    } as never)).toThrow('BRIDGE_COMMAND_INVALID');
    expect(() => serializeBridgeCommand({
      version: 1,
      nonce,
      requestId: 'request-1',
      command: 'shutdown',
      script: 'Get-ChildItem'
    } as never)).toThrow('BRIDGE_COMMAND_INVALID');
  });

  it('stderr 只接受不含上下文的稳定诊断码', () => {
    expect(parseBridgeStderrLine('SHELL_COM_UNAVAILABLE')).toBe('SHELL_COM_UNAVAILABLE');
    expect(() => parseBridgeStderrLine('C:\\secret\\path')).toThrow('BRIDGE_STDERR_INVALID');
    expect(() => parseBridgeStderrLine('ERROR Get-ChildItem')).toThrow('BRIDGE_STDERR_INVALID');
  });
});
