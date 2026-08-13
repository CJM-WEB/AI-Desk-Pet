import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ipcChannels } from '../src/shared/ipc-channels';
import type { MyselfApi } from '../src/shared/myself-api';

const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined);
const on = vi.fn();
let exposedApi: MyselfApi | undefined;

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: MyselfApi) => {
      exposedApi = api;
    }
  },
  ipcRenderer: { invoke, on }
}));

process.argv.push('--myself-e2e-probe');
await import('../src/preload/index');

beforeEach(() => {
  invoke.mockClear();
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
    await exposedApi?.authorizeMcpToolReadOnly('local-tools', 'echo');
    await exposedApi?.revokeMcpToolReadOnly('local-tools', 'echo');

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
    expect(invoke).toHaveBeenNthCalledWith(5, ipcChannels.settingsMcpToolAuthorizeRead, {
      serverId: 'local-tools',
      toolName: 'echo'
    });
    expect(invoke).toHaveBeenNthCalledWith(6, ipcChannels.settingsMcpToolRevokeRead, {
      serverId: 'local-tools',
      toolName: 'echo'
    });
  });
});

describe('preload 公开 API', () => {
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
      'upsertMcpServer',
      'confirmMcpLaunch',
      'testMcpServer',
      'setMcpServerEnabled',
      'setMcpToolEnabled',
      'authorizeMcpToolReadOnly',
      'revokeMcpToolReadOnly',
      'deleteMcpServer',
      'savePrivacySettings',
      'savePetAlwaysOnTop',
      'setIncognitoSession',
      'revokeAuthorizedRoot',
      'submitMessage',
      'cancelTask',
      'confirmAction',
      'cancelAction',
      'resetConversation',
      'resolveHistoryDisclosure',
      'onTaskEvent',
      'listCharacters',
      'createCharacter',
      'duplicateCharacter',
      'getCharacterDraft',
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
      'reportCharacterActionPlayed',
      'reportCharacterActionFeedback',
      'reportCharacterActionMilestone',
      'setPetMousePassthrough',
      'beginPetDrag',
      'endPetDrag',
      'openPetContextMenu',
      'getPetInteractionProbe',
      'getCharacterBehaviorProbe',
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

describe('受限桌宠窗口交互 preload API', () => {
  test('播放反馈只映射固定令牌、动作和状态字段', async () => {
    await exposedApi?.reportCharacterActionFeedback({
      playbackToken: 'behavior-token-2',
      actionId: 'thinking-loop',
      status: 'completed',
      path: 'C:\\private'
    } as never);

    expect(invoke).toHaveBeenCalledWith(ipcChannels.characterActionPlayed, {
      playbackToken: 'behavior-token-2',
      actionId: 'thinking-loop',
      status: 'completed'
    });
  });

  test('固定命令与只读探针只映射到固定通道和固定负载', async () => {
    await exposedApi?.setPetMousePassthrough(true);
    await exposedApi?.beginPetDrag();
    await exposedApi?.endPetDrag();
    await exposedApi?.openPetContextMenu();
    await exposedApi?.getPetInteractionProbe?.();
    await exposedApi?.getCharacterBehaviorProbe?.();

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      ipcChannels.petMousePassthroughSet,
      { ignore: true }
    );
    expect(invoke).toHaveBeenNthCalledWith(2, ipcChannels.petDragBegin);
    expect(invoke).toHaveBeenNthCalledWith(3, ipcChannels.petDragEnd);
    expect(invoke).toHaveBeenNthCalledWith(4, ipcChannels.petContextMenuOpen);
    expect(invoke).toHaveBeenNthCalledWith(5, ipcChannels.petInteractionProbeGet);
    expect(await exposedApi?.getCharacterBehaviorProbe?.()).toEqual({
      revision: 0,
      primaryStateId: '',
      modifierStateIds: [],
      actionId: null,
      playbackStatus: null
    });
  });

  test('行为探针保留修饰状态且不让旧令牌反馈污染新调度', async () => {
    const behaviorListener = on.mock.calls.find(
      ([channel]) => channel === ipcChannels.characterMotionEvent
    )?.[1] as ((event: unknown, payload: unknown) => void) | undefined;
    expect(behaviorListener).toBeTypeOf('function');

    behaviorListener?.({}, {
      type: 'behavior-action',
      revision: 1,
      stateId: 'idle',
      modifierStateIds: ['alert'],
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
      type: 'behavior-action',
      revision: 2,
      stateId: 'idle',
      modifierStateIds: ['focused'],
      actionId: 'idle-main',
      playbackToken: 'behavior-token-new'
    });
    finishFeedback?.();
    await oldFeedback;

    expect(await exposedApi?.getCharacterBehaviorProbe?.()).toEqual({
      revision: 2,
      primaryStateId: 'idle',
      modifierStateIds: ['focused'],
      actionId: 'idle-main',
      playbackStatus: 'scheduled'
    });
  });

  test('当前令牌的终态不被延迟返回的 started 覆盖', async () => {
    const behaviorListener = on.mock.calls.find(
      ([channel]) => channel === ipcChannels.characterMotionEvent
    )?.[1] as ((event: unknown, payload: unknown) => void) | undefined;
    behaviorListener?.({}, {
      type: 'behavior-action',
      revision: 3,
      stateId: 'thinking',
      modifierStateIds: [],
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

describe('角色动作提交帧 preload API', () => {
  test('只转发严格里程碑字段', async () => {
    await exposedApi?.reportCharacterActionMilestone({
      playbackToken: 'behavior-token-2',
      actionId: 'carry-action',
      kind: 'commit-frame',
      frameId: 'carry-commit',
      path: 'C:\\private',
      confirmationId: 'secret'
    } as never);

    expect(invoke).toHaveBeenCalledWith(ipcChannels.characterActionMilestone, {
      playbackToken: 'behavior-token-2',
      actionId: 'carry-action',
      kind: 'commit-frame',
      frameId: 'carry-commit'
    });
  });
});
