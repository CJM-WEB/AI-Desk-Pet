import type { IpcMain } from 'electron';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ipcChannels } from '../src/shared/ipc-channels';
import type { MyselfApi } from '../src/shared/myself-api';
import {
  registerCharacterMotionIpc,
  registerPetWindowInteractionIpc
} from '../src/main/ipc/register-ipc';
import {
  characterActionFeedbackInputSchema,
  petGeometryRenderViewSchema,
  characterMotionDeltaProbeSchema,
  characterMotionEventSchema
} from '../src/shared/character-motion-ipc';

type Handler = (event: unknown, input?: unknown) => unknown;
type Listener = (event: unknown, ...args: unknown[]) => void;
const invoke = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();
let exposedApi: MyselfApi | undefined;

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: MyselfApi) => {
      exposedApi = api;
    }
  },
  ipcRenderer: { invoke, on, removeListener }
}));

await import('../src/preload/index');

function snapshot(revision = 1) {
  return {
    revision,
    timestampMs: 100,
    position: { x: 10, y: 20 },
    target: { x: 30, y: 40 },
    direction: 'right' as const,
    moving: true,
    carrying: false
  };
}

function createIpcMain() {
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Listener>();
  return {
    handlers,
    listeners,
    ipcMain: {
      removeHandler: (channel: string) => handlers.delete(channel),
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      removeAllListeners: (channel: string) => listeners.delete(channel),
      on: (channel: string, listener: Listener) => listeners.set(channel, listener)
    } as unknown as IpcMain
  };
}

beforeEach(() => {
  invoke.mockReset();
  on.mockReset();
  removeListener.mockReset();
});

describe('角色运动严格 IPC', () => {
  test('视觉几何渲染视图只接受窗口内去全局坐标字段', () => {
    expect(petGeometryRenderViewSchema.parse({
      revision: 2,
      scale: 1.2,
      visualBoundsInWindowDip: { x: 10, y: 20, width: 80, height: 120 }
    })).toEqual({
      revision: 2,
      scale: 1.2,
      visualBoundsInWindowDip: { x: 10, y: 20, width: 80, height: 120 }
    });
    expect(() => petGeometryRenderViewSchema.parse({
      revision: Number.MAX_SAFE_INTEGER + 1,
      scale: 1,
      visualBoundsInWindowDip: { x: 0, y: 0, width: 1, height: 1 }
    })).toThrow();
    expect(() => petGeometryRenderViewSchema.parse({
      revision: 1,
      scale: 1,
      visualBoundsInWindowDip: {
        x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 1
      }
    })).toThrow();
    for (const privateField of [
      { characterId: 'private-character' },
      { resourceRevision: 'a'.repeat(64) },
      { displayId: 'display-1' },
      { footAnchorDip: { x: 300, y: 400 } },
      { windowBoundsDip: { x: 300, y: 200, width: 180, height: 220 } },
      { globalVisualBoundsDip: { x: 310, y: 220, width: 80, height: 120 } }
    ]) {
      expect(() => petGeometryRenderViewSchema.parse({
        revision: 2,
        scale: 1.2,
        visualBoundsInWindowDip: { x: 10, y: 20, width: 80, height: 120 },
        ...privateField
      })).toThrow();
    }
  });

  test('E2E 运动差值探针只接受去标识化相对字段', () => {
    expect(characterMotionDeltaProbeSchema.parse({
      moved: true,
      horizontal: -24,
      vertical: 12
    })).toEqual({ moved: true, horizontal: -24, vertical: 12 });
    expect(() => characterMotionDeltaProbeSchema.parse({
      moved: true,
      horizontal: -24,
      vertical: 12,
      position: { x: 100, y: 200 },
      actionId: 'private-action',
      playbackToken: 'private-token'
    })).toThrow();
    expect(() => characterMotionDeltaProbeSchema.parse({
      moved: false,
      horizontal: Number.POSITIVE_INFINITY,
      vertical: 0
    })).toThrow();
    expect(() => characterMotionDeltaProbeSchema.parse({
      moved: false,
      horizontal: 1,
      vertical: 0
    })).toThrow();
  });

  test('行为权威、行为动作与旧待机动作都只能携带严格白名单字段', () => {
    expect(characterMotionEventSchema.parse({
      type: 'behavior-authority',
      characterId: 'legacy-character',
      mode: 'legacy-v1'
    })).toEqual({
      type: 'behavior-authority',
      characterId: 'legacy-character',
      mode: 'legacy-v1'
    });
    expect(characterMotionEventSchema.parse({
      type: 'behavior-action',
      revision: 2,
      stateId: 'thinking',
      modifierStateIds: ['focused'],
      actionId: 'thinking-loop',
      playbackToken: 'behavior-token-2'
    })).toEqual({
      type: 'behavior-action',
      revision: 2,
      stateId: 'thinking',
      modifierStateIds: ['focused'],
      actionId: 'thinking-loop',
      playbackToken: 'behavior-token-2'
    });
    expect(() => characterMotionEventSchema.parse({
      type: 'behavior-action',
      revision: 2,
      stateId: 'thinking',
      actionId: 'thinking-loop',
      playbackToken: 'behavior-token-2',
      path: 'C:\\private'
    })).toThrow();
  });

  test.each(['started', 'completed', 'interrupted', 'failed'] as const)(
    '播放反馈接受 %s 且拒绝伪造令牌和未知字段',
    status => {
      expect(characterActionFeedbackInputSchema.parse({
        playbackToken: 'behavior-token-2',
        actionId: 'thinking-loop',
        status
      })).toEqual({
        playbackToken: 'behavior-token-2',
        actionId: 'thinking-loop',
        status
      });
      expect(() => characterActionFeedbackInputSchema.parse({
        playbackToken: '伪造令牌',
        actionId: 'thinking-loop',
        status
      })).toThrow();
      expect(() => characterActionFeedbackInputSchema.parse({
        playbackToken: 'behavior-token-2',
        actionId: 'thinking-loop',
        status,
        error: '不得跨 IPC 传递错误文本'
      })).toThrow();
    }
  );

  test('Main 只接受空输入并严格校验无路径快照结果', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const petSender = { id: 1 };
    const service = {
      getSnapshot: vi.fn(() => snapshot()),
      applyPlaybackFeedback: vi.fn(async () => undefined)
    };
    registerCharacterMotionIpc(ipcMain, service, petSender as never);
    const handler = handlers.get(ipcChannels.characterMotionSnapshotGet);

    await expect(handler?.({}, {})).resolves.toEqual({ snapshot: snapshot() });
    await expect(handler?.({}, { x: 1 })).rejects.toMatchObject({
      code: 'CHARACTER_INPUT_INVALID'
    });
    service.getSnapshot.mockReturnValueOnce({
      ...snapshot(),
      path: 'C:\\private'
    } as never);
    await expect(handler?.({}, {})).rejects.toMatchObject({
      code: 'CHARACTER_OPERATION_FAILED'
    });

    const report = handlers.get(ipcChannels.characterActionFeedback);
    await expect(report?.({ sender: petSender }, {
      playbackToken: 'opaque-token',
      actionId: 'idle-a',
      status: 'started'
    })).resolves.toEqual({ ok: true });
    expect(service.applyPlaybackFeedback).toHaveBeenCalledWith({
      playbackToken: 'opaque-token',
      actionId: 'idle-a',
      status: 'started'
    });
    await expect(report?.({ sender: petSender }, {
      playbackToken: 'behavior-token-2',
      actionId: 'thinking-loop',
      status: 'completed'
    })).resolves.toEqual({ ok: true });
    expect(service.applyPlaybackFeedback).toHaveBeenLastCalledWith({
      playbackToken: 'behavior-token-2',
      actionId: 'thinking-loop',
      status: 'completed'
    });
    await expect(report?.({ sender: { id: 2 } }, {
      playbackToken: 'opaque-token',
      actionId: 'idle-a',
      status: 'started'
    })).rejects.toThrow('CHARACTER_PLAYBACK_SENDER_INVALID');
    await expect(report?.({ sender: petSender }, {
      playbackToken: 'opaque-token',
      actionId: 'idle-a',
      status: 'started',
      path: 'C:\\private'
    })).rejects.toMatchObject({ code: 'CHARACTER_INPUT_INVALID' });

    service.applyPlaybackFeedback.mockRejectedValueOnce(
      new Error('CHARACTER_PLAYBACK_UNAUTHORIZED')
    );
    await expect(report?.({ sender: petSender }, {
      playbackToken: 'forged-token',
      actionId: 'thinking-loop',
      status: 'started'
    })).rejects.toThrow('CHARACTER_PLAYBACK_UNAUTHORIZED');
  });

  test('三条拖拽命令对非法 sender 和多余参数均失败关闭', () => {
    const { ipcMain, listeners } = createIpcMain();
    const petSender = { isDestroyed: () => false };
    const controller = {
      setPassthrough: vi.fn(),
      beginDrag: vi.fn(),
      updateDrag: vi.fn(),
      endDrag: vi.fn(),
      dispose: vi.fn()
    };
    registerPetWindowInteractionIpc(ipcMain, controller, petSender as never);
    const commands = [
      [ipcChannels.petDragBegin, controller.beginDrag],
      [ipcChannels.petDragUpdate, controller.updateDrag],
      [ipcChannels.petDragEnd, controller.endDrag]
    ] as const;

    for (const [channel] of commands) {
      listeners.get(channel)?.({ sender: { isDestroyed: () => false } });
      listeners.get(channel)?.({ sender: petSender }, { x: 1, y: 2 });
    }
    for (const [, action] of commands) expect(action).not.toHaveBeenCalled();

    for (const [channel] of commands) listeners.get(channel)?.({ sender: petSender });
    for (const [, action] of commands) expect(action).toHaveBeenCalledOnce();
  });

  test('preload 只暴露快照读取和固定事件订阅，不暴露任意坐标写入', async () => {
    invoke.mockResolvedValueOnce({ snapshot: snapshot() });
    await expect(exposedApi?.getCharacterMotionSnapshot()).resolves.toEqual(snapshot());
    expect(invoke).toHaveBeenCalledWith(ipcChannels.characterMotionSnapshotGet, {});
    expect(exposedApi).not.toHaveProperty('setPosition');
    expect(exposedApi).not.toHaveProperty('moveCharacterTo');

    const listener = vi.fn();
    const unsubscribe = exposedApi?.subscribeCharacterMotion(listener);
    const wrapped = on.mock.calls[0]?.[1] as (
      event: unknown,
      payload: unknown
    ) => void;
    wrapped({ sender: '不得暴露' }, { type: 'snapshot', snapshot: snapshot(2) });
    wrapped({}, { type: 'unknown', path: 'C:\\private' });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      type: 'snapshot',
      snapshot: snapshot(2)
    });
    unsubscribe?.();
    expect(removeListener).toHaveBeenCalledWith(
      ipcChannels.characterMotionEvent,
      wrapped
    );
  });
});
