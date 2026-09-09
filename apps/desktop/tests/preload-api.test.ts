import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ipcChannels } from '../src/shared/ipc-channels';
import type { MyselfApi } from '../src/shared/myself-api';

const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined);
const send = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();
let exposedApi: MyselfApi | undefined;

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: MyselfApi) => {
      exposedApi = api;
    }
  },
  ipcRenderer: { invoke, send, on, removeListener }
}));

process.argv.push('--myself-e2e-probe');
await import('../src/preload/index');

beforeEach(() => {
  invoke.mockClear();
  send.mockClear();
});

describe('preload 清除本地数据转发', () => {
  test('传入档案标识时将其发送到固定 IPC 通道', async () => {
    await exposedApi?.clearLocalData('secret', 'alpha');

    expect(invoke).toHaveBeenCalledWith(ipcChannels.settingsClearLocalData, {
      scope: 'secret',
      profileId: 'alpha'
    });
  });

  test('省略档案标识时保持旧版默认档案负载', async () => {
    await exposedApi?.clearLocalData('secret');

    expect(invoke).toHaveBeenCalledWith(ipcChannels.settingsClearLocalData, { scope: 'secret' });
  });

  test('高级设置只通过固定白名单通道转发', async () => {
    await exposedApi?.getSettingsDashboard();
    await exposedApi?.saveModelRoute({
      primaryProfileId: null,
      chatProfileId: null,
      agentProfileId: null,
      visionProfileId: null,
      fallbackProfileIds: [],
      allowCrossProviderFallback: false
    });
    await exposedApi?.setIncognitoSession(true);
    await exposedApi?.savePetAlwaysOnTop(true);
    await exposedApi?.setLocalModelEnabled(true);

    expect(invoke).toHaveBeenNthCalledWith(1, ipcChannels.settingsDashboardGet);
    expect(invoke).toHaveBeenNthCalledWith(2, ipcChannels.settingsRouteSave, {
      route: {
        primaryProfileId: null,
        chatProfileId: null,
        agentProfileId: null,
        visionProfileId: null,
        fallbackProfileIds: [],
        allowCrossProviderFallback: false
      }
    });
    expect(invoke).toHaveBeenNthCalledWith(3, ipcChannels.settingsIncognitoSet, {
      incognito: true
    });
    expect(invoke).toHaveBeenNthCalledWith(4, ipcChannels.settingsPetAlwaysOnTopSave, {
      enabled: true
    });
    expect(invoke).toHaveBeenNthCalledWith(5, ipcChannels.settingsLocalModelEnabledSet, {
      enabled: true
    });
  });
});

describe('preload 公开 API', () => {
  test('自然文件问句与普通聊天均只传正文', async () => {
    await exposedApi!.submitMessage('note.txt 里面写了什么？');
    await exposedApi!.submitMessage('你好');
    expect(invoke.mock.calls).toEqual([
      [ipcChannels.chatSubmit, { text: 'note.txt 里面写了什么？' }],
      [ipcChannels.chatSubmit, { text: '你好' }]
    ]);
  });

  test('恢复快照从固定 IPC 通道返回合法 Main 结果', async () => {
    invoke.mockResolvedValueOnce({ fallbackErrorCode: null, issues: [] });
    await expect(exposedApi?.getCharacterRecoverySnapshot()).resolves.toEqual({
      fallbackErrorCode: null,
      issues: []
    });
    expect(invoke).toHaveBeenCalledWith(ipcChannels.characterRecoverySnapshotGet, {});
  });

  test('恢复快照拒绝含有私有路径字段的 Main 返回值', async () => {
    invoke.mockResolvedValueOnce({
      fallbackErrorCode: null,
      issues: [],
      markerPath: 'C:\\private'
    });
    await expect(exposedApi?.getCharacterRecoverySnapshot()).rejects.toThrow();
  });

  test('新对话与历史披露只映射固定白名单通道', async () => {
    await exposedApi?.resetConversation();
    await exposedApi?.resolveHistoryDisclosure('request-1', 'current_message_only');

    expect(invoke).toHaveBeenNthCalledWith(1, ipcChannels.conversationReset);
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      ipcChannels.conversationDisclosureResolve,
      { requestId: 'request-1', decision: 'current_message_only' }
    );
  });

  test('公开键严格等于既有白名单加两个会话入口', () => {
    expect(Object.keys(exposedApi ?? {})).toEqual([
      'getStatus',
      'getSettings',
      'saveProvider',
      'testProvider',
      'chooseAuthorizedRoot',
      'clearLocalData',
      'getSettingsDashboard',
      'saveProviderProfile',
      'deleteProviderProfile',
      'testProviderProfile',
      'saveModelRoute',
      'savePrivacySettings',
      'getWorkshopLayout',
      'saveWorkshopLayout',
      'savePetAlwaysOnTop',
      'setLocalModelEnabled',
      'setIncognitoSession',
      'revokeAuthorizedRoot',
      'submitMessage',
      'cancelTask',
      'confirmAction',
      'cancelAction',
      'resetConversation',
      'resolveHistoryDisclosure',
      'resolveCapabilityAuthorization',
      'onTaskEvent',
      'onLocalModelStatus',
      'listCharacters',
      'createCharacter',
      'duplicateCharacter',
      'getCharacterDraft',
      'getCharacterMigrationReview',
      'saveCharacterDraft',
      'chooseCharacterSources',
      'listCharacterSources',
      'readCharacterSource',
      'publishCharacter',
      'activateCharacter',
      'deleteCharacter',
      'importCharacterPackage',
      'exportCharacterPackage',
      'getCharacterRuntimeSnapshot',
      'getCharacterRecoverySnapshot',
      'readCharacterRuntimeAsset',
      'subscribeCharacterEvents',
      'getCharacterMotionSnapshot',
      'subscribeCharacterMotion',
      'reportCharacterActionFeedback',
      'setPetMousePassthrough',
      'beginPetDrag',
      'updatePetDrag',
      'endPetDrag',
      'commitPetViewport',
      'onPetGeometryRender',
      'recordPetInteractionProbeEvent',
      'getPetInteractionProbe',
      'getCharacterBehaviorProbe',
      'getCharacterMotionDeltaProbe',
      'openChat',
      'openSettings',
      'openCharacterWorkshop',
      'onCharacterWorkshopFlushRequested',
      'hideChat',
      'quit'
    ]);
  });

  test('不再暴露目录空间控制入口', () => {
    const apiKeys = Object.keys(exposedApi ?? {});
    const removedKeys = [
      'getHabitatDashboard',
      'chooseAndAddHabitatDirectory',
      'setHabitatDirectoryEnabled',
      'removeHabitatDirectory',
      'saveHabitatPreferences',
      'enterHabitatDirectory',
      'summonHabitat',
      'recallHabitat'
    ];

    expect(apiKeys).not.toEqual(expect.arrayContaining(removedKeys));
    for (const removedKey of removedKeys) expect(apiKeys).not.toContain(removedKey);
  });
});

describe('TaskEvent preload 运行时边界', () => {
  const validTaskPermissionEvent = {
    type: 'task_permission_required',
    actionId: 'permission-file-1',
    summary: '删除 safe.txt',
    request: {
      action: 'delete',
      resources: ['safe.txt']
    }
  } as const;

  const getTaskEventHandler = () => {
    const handler = on.mock.calls
      .filter(([channel]) => channel === ipcChannels.taskEvent)
      .at(-1)?.[1] as ((event: unknown, payload: unknown) => void) | undefined;
    expect(handler).toBeTypeOf('function');
    return handler;
  };

  test.each([
    { type: 'phase', phase: 'thinking' },
    { type: 'assistant_message_start', turnId: 'turn-1' },
    { type: 'assistant_message_delta', turnId: 'turn-1', delta: '你好' },
    { type: 'assistant_message_commit', turnId: 'turn-1', text: '你好' },
    validTaskPermissionEvent
  ])('合法 TaskEvent 解析后只通知一次监听者', event => {
    const listener = vi.fn();
    exposedApi!.onTaskEvent(listener);
    const handler = getTaskEventHandler();

    handler?.({}, event);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });

  test.each([
    { type: 'unknown' },
    { type: 'assistant_message_delta', turnId: '', delta: '你好' },
    { type: 'assistant_message_delta', turnId: 'turn-1', delta: '' },
    { type: 'assistant_message_start', turnId: 't'.repeat(129) },
    { type: 'assistant_message_delta', turnId: 'turn-1', delta: 'x'.repeat(4_001) },
    { type: 'assistant_message_commit', turnId: 'turn-1', text: 'x'.repeat(4_001) },
    { type: 'assistant_message_commit', turnId: 'turn-1', text: '你好', secret: true },
    { type: 'phase', phase: 'thinking', unexpected: true },
    { type: 'task_permission_required', actionId: '', summary: '无效许可', request: { action: 'delete', resources: ['safe.txt'] } },
    {
      ...validTaskPermissionEvent,
      request: { ...validTaskPermissionEvent.request, absolutePath: 'C:\\private' }
    }
  ])('畸形 TaskEvent 静默丢弃且不进入 Renderer listener', payload => {
    const listener = vi.fn();
    const consoleLog = vi.spyOn(console, 'log');
    const consoleWarn = vi.spyOn(console, 'warn');
    const consoleError = vi.spyOn(console, 'error');
    exposedApi!.onTaskEvent(listener);
    const handler = getTaskEventHandler();

    handler?.({}, payload);

    expect(listener).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
    consoleError.mockRestore();
  });

  test('退订只移除同一个 taskEvent handler', () => {
    const release = exposedApi!.onTaskEvent(vi.fn());
    const handler = getTaskEventHandler();
    removeListener.mockClear();

    release();

    expect(removeListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith(ipcChannels.taskEvent, handler);
  });
});

describe('受限桌宠窗口交互 preload API', () => {
  test('播放反馈只映射固定令牌、动作和状态字段', async () => {
    await exposedApi?.reportCharacterActionFeedback({
      playbackToken: 'behavior-token-2',
      actionId: 'thinking-loop',
      status: 'completed',
      path: 'C:\\private'
    } as never);

    expect(invoke).toHaveBeenCalledWith(ipcChannels.characterActionFeedback, {
      playbackToken: 'behavior-token-2',
      actionId: 'thinking-loop',
      status: 'completed'
    });
  });

  test('固定命令与只读探针只映射到固定通道和固定负载', async () => {
    await exposedApi?.setPetMousePassthrough(true);
    exposedApi?.beginPetDrag();
    exposedApi?.updatePetDrag();
    exposedApi?.endPetDrag();
    await exposedApi?.recordPetInteractionProbeEvent?.('mouse_hit');
    await exposedApi?.getPetInteractionProbe?.();
    await exposedApi?.getCharacterBehaviorProbe?.();
    await expect(exposedApi?.getCharacterMotionDeltaProbe?.()).resolves.toEqual({
      moved: false,
      horizontal: 0,
      vertical: 0
    });

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      ipcChannels.petMousePassthroughSet,
      { ignore: true }
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'pet-window:e2e-interaction-probe-record',
      'mouse_hit'
    );
    expect(send.mock.calls).toEqual([
      [ipcChannels.petDragBegin],
      [ipcChannels.petDragUpdate],
      [ipcChannels.petDragEnd]
    ]);
    expect(invoke).toHaveBeenNthCalledWith(3, ipcChannels.petInteractionProbeGet);
    expect(await exposedApi?.getCharacterBehaviorProbe?.()).toEqual({
      revision: 0,
      stateId: '',
      actionId: null,
      playbackStatus: null
    });
  });

  test('几何 API 只转发窗口局部 viewport 并校验 Main 渲染事件', async () => {
    await exposedApi?.commitPetViewport?.({
      viewportInWindowDip: { x: 20, y: 10, width: 100, height: 100 }
    });
    const listener = vi.fn();
    const unsubscribe = exposedApi?.onPetGeometryRender?.(listener);
    const registration = on.mock.calls.find(call => call[0] === ipcChannels.petGeometryRender);
    const handler = registration?.[1] as ((event: unknown, payload: unknown) => void) | undefined;

    expect(invoke).toHaveBeenNthCalledWith(1, ipcChannels.petViewportCommit, {
      viewportInWindowDip: { x: 20, y: 10, width: 100, height: 100 }
    });
    handler?.({}, {
      revision: 3,
      scale: 1.1,
      visualBoundsInWindowDip: { x: 30, y: 20, width: 60, height: 80 }
    });
    handler?.({}, {
      revision: 3,
      scale: 1.1,
      visualBoundsInWindowDip: { x: 30, y: 20, width: 60, height: 80 },
      globalFootAnchor: { x: 300, y: 400 }
    });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe?.();
    expect(removeListener).toHaveBeenCalledWith(ipcChannels.petGeometryRender, handler);
  });

  test('行为探针保留真实状态且不让旧令牌反馈污染新调度', async () => {
    const behaviorListener = on.mock.calls.find(
      ([channel]) => channel === ipcChannels.characterMotionEvent
    )?.[1] as ((event: unknown, payload: unknown) => void) | undefined;
    expect(behaviorListener).toBeTypeOf('function');

    behaviorListener?.({}, {
      type: 'behavior-action', playback: { mode: 'once', durationMs: 1000 },
      revision: 1,
      stateId: 'idle',
      actionId: 'idle-main',
      playbackToken: 'behavior-token-old'
    });
    let finishFeedback: (() => void) | undefined;
    invoke.mockImplementationOnce(() => new Promise<undefined>(resolve => {
      finishFeedback = () => resolve(undefined);
    }));
    const oldFeedback = exposedApi!.reportCharacterActionFeedback({
      playbackToken: 'behavior-token-old',
      actionId: 'idle-main',
      status: 'completed'
    });
    behaviorListener?.({}, {
      type: 'behavior-action', playback: { mode: 'once', durationMs: 1000 },
      revision: 2,
      stateId: 'idle',
      actionId: 'idle-main',
      playbackToken: 'behavior-token-new'
    });
    finishFeedback?.();
    await oldFeedback;

    expect(await exposedApi?.getCharacterBehaviorProbe?.()).toEqual({
      revision: 2,
      stateId: 'idle',
      actionId: 'idle-main',
      playbackStatus: 'scheduled'
    });
  });

  test('运动差值探针以首个合法快照为基线且不公开绝对位置', async () => {
    const motionListener = on.mock.calls.find(
      ([channel]) => channel === ipcChannels.characterMotionEvent
    )?.[1] as ((event: unknown, payload: unknown) => void) | undefined;
    expect(motionListener).toBeTypeOf('function');
    motionListener?.({}, { type: 'snapshot', snapshot: {
      revision: 1,
      timestampMs: 100,
      position: { x: 100, y: 200 },
      target: { x: 100, y: 200 },
      direction: 'right',
      moving: false,
      carrying: false
    } });
    motionListener?.({}, { type: 'snapshot', snapshot: {
      revision: 2,
      timestampMs: 200,
      position: { x: 94, y: 212 },
      target: { x: 94, y: 212 },
      direction: 'left',
      moving: false,
      carrying: false
    } });

    const probe = await exposedApi?.getCharacterMotionDeltaProbe?.();
    expect(probe).toEqual({ moved: true, horizontal: -6, vertical: 12 });
    expect(Object.keys(probe ?? {}).sort()).toEqual(['horizontal', 'moved', 'vertical']);
  });

  test('当前令牌的终态不被延迟返回的 started 覆盖', async () => {
    const behaviorListener = on.mock.calls.find(
      ([channel]) => channel === ipcChannels.characterMotionEvent
    )?.[1] as ((event: unknown, payload: unknown) => void) | undefined;
    behaviorListener?.({}, {
      type: 'behavior-action', playback: { mode: 'once', durationMs: 1000 },
      revision: 3,
      stateId: 'thinking',
      actionId: 'thinking-loop',
      playbackToken: 'behavior-token-current'
    });

    let finishStarted: (() => void) | undefined;
    invoke.mockImplementationOnce(() => new Promise<undefined>(resolve => {
      finishStarted = () => resolve(undefined);
    }));
    const started = exposedApi!.reportCharacterActionFeedback({
      playbackToken: 'behavior-token-current',
      actionId: 'thinking-loop',
      status: 'started'
    });
    await exposedApi!.reportCharacterActionFeedback({
      playbackToken: 'behavior-token-current',
      actionId: 'thinking-loop',
      status: 'completed'
    });
    expect((await exposedApi?.getCharacterBehaviorProbe?.())?.playbackStatus).toBe('completed');

    finishStarted?.();
    await started;

    expect((await exposedApi?.getCharacterBehaviorProbe?.())?.playbackStatus).toBe('completed');
  });
});
