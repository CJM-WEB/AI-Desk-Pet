import type { IpcMain } from 'electron';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ipcChannels } from '../src/shared/ipc-channels';
import type { MyselfApi } from '../src/shared/myself-api';
import { registerCharacterMotionIpc } from '../src/main/ipc/register-ipc';
import {
  characterActionFeedbackInputSchema,
  characterActionMilestoneInputSchema,
  characterMotionEventSchema
} from '../src/shared/character-motion-ipc';

type Handler = (event: unknown, input?: unknown) => unknown;
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
  return {
    handlers,
    ipcMain: {
      removeHandler: (channel: string) => handlers.delete(channel),
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
    } as unknown as IpcMain
  };
}

beforeEach(() => {
  invoke.mockReset();
  on.mockReset();
  removeListener.mockReset();
});

describe('角色运动严格 IPC', () => {
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

  test('提交帧里程碑只接受严格字段', () => {
    expect(characterActionMilestoneInputSchema.parse({
      playbackToken: 'behavior-token-2',
      actionId: 'carry-action',
      kind: 'commit-frame',
      frameId: 'carry-commit'
    })).toEqual({
      playbackToken: 'behavior-token-2',
      actionId: 'carry-action',
      kind: 'commit-frame',
      frameId: 'carry-commit'
    });
    expect(() => characterActionMilestoneInputSchema.parse({
      playbackToken: 'behavior-token-2',
      actionId: 'carry-action',
      kind: 'commit-frame',
      frameId: 'carry-commit',
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
    const observer = {
      onPlaybackStarted: vi.fn(),
      onPlaybackTerminal: vi.fn(),
      onCommitFrame: vi.fn(() => true)
    };
    registerCharacterMotionIpc(ipcMain, service, petSender as never, observer);
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
    expect(observer.onPlaybackStarted).toHaveBeenCalledWith('opaque-token', 'idle-a');
    expect(observer.onPlaybackTerminal).toHaveBeenCalledWith(
      'behavior-token-2', 'thinking-loop', 'completed'
    );
    const milestone = handlers.get(ipcChannels.characterActionMilestone);
    await expect(milestone?.({ sender: petSender }, {
      playbackToken: 'behavior-token-2',
      actionId: 'carry-action',
      kind: 'commit-frame',
      frameId: 'carry-commit'
    })).resolves.toEqual({ ok: true });
    expect(observer.onCommitFrame).toHaveBeenCalledWith(
      'behavior-token-2', 'carry-action', 'carry-commit'
    );
    observer.onCommitFrame.mockReturnValueOnce(false);
    await expect(milestone?.({ sender: petSender }, {
      playbackToken: 'behavior-token-old',
      actionId: 'carry-action',
      kind: 'commit-frame',
      frameId: 'carry-commit'
    })).rejects.toThrow('CHARACTER_ACTION_MILESTONE_REJECTED');
    await expect(milestone?.({ sender: { id: 2 } }, {
      playbackToken: 'behavior-token-2',
      actionId: 'carry-action',
      kind: 'commit-frame',
      frameId: 'carry-commit'
    })).rejects.toThrow('CHARACTER_PLAYBACK_SENDER_INVALID');
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

  test('事务端口未接线时稳定拒绝提交帧', async () => {
    const { handlers, ipcMain } = createIpcMain();
    const petSender = { id: 1 };
    registerCharacterMotionIpc(ipcMain, {
      getSnapshot: () => snapshot(),
      applyPlaybackFeedback: vi.fn()
    }, petSender as never);
    await expect(handlers.get(ipcChannels.characterActionMilestone)?.(
      { sender: petSender },
      {
        playbackToken: 'behavior-token-2',
        actionId: 'carry-action',
        kind: 'commit-frame',
        frameId: 'carry-commit'
      }
    )).rejects.toThrow('CHARACTER_ACTION_MILESTONE_UNAVAILABLE');
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
