import { contextBridge, ipcRenderer } from 'electron';
import type { PublicSettings, TaskEvent } from '@myself/shared-types';
import { ipcChannels } from '../shared/ipc-channels';
import type {
  CharacterCreateInput,
  CharacterEvent,
  CharacterExportResult,
  CharacterImportResult,
  CharacterPublishInput,
  CharacterRuntimeSnapshot,
  CharacterSourceChoiceResult,
  CharacterSummaryDto,
  CharacterWorkshopSourceDto
} from '../shared/character-ipc';
import { characterRecoverySnapshotResultSchema } from '../shared/character-ipc';
import {
  characterMotionEventSchema,
  characterMotionSnapshotResultSchema,
  type CharacterBehaviorProbe,
  type CharacterMotionEvent,
  type CharacterMotionSnapshot
} from '../shared/character-motion-ipc';
import type {
  LocalDataScope,
  McpServerInput,
  MyselfApi,
  PrivacySettingsDto,
  SaveProviderProfileInput
} from '../shared/myself-api';
import type { ModelRouteConfig } from '@myself/shared-types';

const e2eProbeEnabled = process.argv.includes('--myself-e2e-probe');
let behaviorProbe: CharacterBehaviorProbe = {
  revision: 0,
  primaryStateId: '',
  modifierStateIds: [],
  actionId: null,
  playbackStatus: null
};
let behaviorProbePlaybackToken: string | null = null;

if (e2eProbeEnabled) {
  // preload 在 Main 初始化行为服务前监听，因此不会遗漏首个待机动作。
  ipcRenderer.on(ipcChannels.characterMotionEvent, (_event, payload: unknown) => {
    const parsed = characterMotionEventSchema.safeParse(payload);
    if (!parsed.success || parsed.data.type !== 'behavior-action') return;
    behaviorProbePlaybackToken = parsed.data.playbackToken;
    behaviorProbe = {
      revision: parsed.data.revision,
      primaryStateId: parsed.data.stateId,
      modifierStateIds: [...(parsed.data.modifierStateIds ?? [])],
      actionId: parsed.data.actionId,
      playbackStatus: 'scheduled'
    };
  });
}

const api: MyselfApi = {
  getStatus: () => ipcRenderer.invoke(ipcChannels.appGetStatus),
  getSettings: (): Promise<PublicSettings> => ipcRenderer.invoke(ipcChannels.settingsGet),
  saveProvider: (input: unknown): Promise<PublicSettings> => (
    ipcRenderer.invoke(ipcChannels.settingsSaveProvider, input)
  ),
  testProvider: () => ipcRenderer.invoke(ipcChannels.settingsTestProvider),
  chooseAuthorizedRoot: (): Promise<PublicSettings> => (
    ipcRenderer.invoke(ipcChannels.settingsChooseRoot)
  ),
  clearLocalData: (scope: LocalDataScope, profileId?: string): Promise<PublicSettings> => (
    ipcRenderer.invoke(
      ipcChannels.settingsClearLocalData,
      profileId === undefined ? { scope } : { scope, profileId }
    )
  ),
  getSettingsDashboard: () => ipcRenderer.invoke(ipcChannels.settingsDashboardGet),
  saveProviderProfile: (input: SaveProviderProfileInput) => (
    ipcRenderer.invoke(ipcChannels.settingsProfileSave, input)
  ),
  deleteProviderProfile: (profileId: string) => (
    ipcRenderer.invoke(ipcChannels.settingsProfileDelete, { profileId })
  ),
  testProviderProfile: (profileId: string) => (
    ipcRenderer.invoke(ipcChannels.settingsProfileTest, { profileId })
  ),
  saveModelRoute: (route: ModelRouteConfig) => (
    ipcRenderer.invoke(ipcChannels.settingsRouteSave, { route })
  ),
  upsertMcpServer: (input: McpServerInput) => (
    ipcRenderer.invoke(ipcChannels.settingsMcpUpsert, input)
  ),
  confirmMcpLaunch: (serverId: string, fingerprint: string) => (
    ipcRenderer.invoke(ipcChannels.settingsMcpConfirmLaunch, { serverId, fingerprint })
  ),
  testMcpServer: (serverId: string) => (
    ipcRenderer.invoke(ipcChannels.settingsMcpTest, { serverId })
  ),
  setMcpServerEnabled: (serverId: string, enabled: boolean) => (
    ipcRenderer.invoke(ipcChannels.settingsMcpServerToggle, { serverId, enabled })
  ),
  setMcpToolEnabled: (serverId: string, toolName: string, enabled: boolean) => (
    ipcRenderer.invoke(ipcChannels.settingsMcpToolToggle, { serverId, toolName, enabled })
  ),
  authorizeMcpToolReadOnly: (serverId: string, toolName: string) => (
    ipcRenderer.invoke(ipcChannels.settingsMcpToolAuthorizeRead, { serverId, toolName })
  ),
  revokeMcpToolReadOnly: (serverId: string, toolName: string) => (
    ipcRenderer.invoke(ipcChannels.settingsMcpToolRevokeRead, { serverId, toolName })
  ),
  deleteMcpServer: (serverId: string) => (
    ipcRenderer.invoke(ipcChannels.settingsMcpDelete, { serverId })
  ),
  savePrivacySettings: (input: PrivacySettingsDto) => (
    ipcRenderer.invoke(ipcChannels.settingsPrivacySave, input)
  ),
  savePetAlwaysOnTop: (enabled: boolean) => (
    ipcRenderer.invoke(ipcChannels.settingsPetAlwaysOnTopSave, { enabled })
  ),
  setIncognitoSession: (incognito: boolean) => (
    ipcRenderer.invoke(ipcChannels.settingsIncognitoSet, { incognito })
  ),
  revokeAuthorizedRoot: () => ipcRenderer.invoke(ipcChannels.settingsRootRevoke),
  submitMessage: (text: string): Promise<void> => (
    ipcRenderer.invoke(ipcChannels.chatSubmit, { text })
  ),
  cancelTask: (): Promise<void> => ipcRenderer.invoke(ipcChannels.chatCancel),
  confirmAction: (actionId: string): Promise<void> => (
    ipcRenderer.invoke(ipcChannels.actionConfirm, { actionId })
  ),
  cancelAction: (actionId: string): Promise<void> => (
    ipcRenderer.invoke(ipcChannels.actionCancel, { actionId })
  ),
  onTaskEvent: (listener: (event: TaskEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TaskEvent) => listener(payload);
    ipcRenderer.on(ipcChannels.taskEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.taskEvent, handler);
  },
  listCharacters: async (): Promise<CharacterSummaryDto[]> => {
    const result = await ipcRenderer.invoke(ipcChannels.characterList, {});
    return result.characters;
  },
  createCharacter: async (input: CharacterCreateInput) => {
    const result = await ipcRenderer.invoke(ipcChannels.characterCreate, input);
    return result.draft;
  },
  duplicateCharacter: async characterId => {
    const result = await ipcRenderer.invoke(ipcChannels.characterDuplicate, { characterId });
    return result.draft;
  },
  getCharacterDraft: async characterId => {
    const result = await ipcRenderer.invoke(ipcChannels.characterDraftGet, { characterId });
    return result.draft;
  },
  saveCharacterDraft: async (characterId, draft, draftRevision) => {
    await ipcRenderer.invoke(ipcChannels.characterDraftSave, {
      characterId,
      draft,
      draftRevision
    });
  },
  chooseCharacterSources: (characterId): Promise<CharacterSourceChoiceResult> => (
    ipcRenderer.invoke(ipcChannels.characterSourcesChoose, { characterId })
  ),
  listCharacterSources: async (
    characterId
  ): Promise<CharacterWorkshopSourceDto[]> => {
    const result = await ipcRenderer.invoke(
      ipcChannels.characterSourcesList,
      { characterId }
    );
    return result.sources;
  },
  readCharacterSource: async (characterId, assetId) => {
    const result = await ipcRenderer.invoke(ipcChannels.characterSourceRead, {
      characterId,
      assetId
    });
    return result.bytes;
  },
  publishCharacter: async (input: CharacterPublishInput) => {
    await ipcRenderer.invoke(ipcChannels.characterPublish, input);
  },
  activateCharacter: async (characterId, options) => {
    await ipcRenderer.invoke(ipcChannels.characterActivate, {
      characterId,
      ...(options?.confirmIncomplete ? { confirmIncomplete: true } : {})
    });
  },
  deleteCharacter: async characterId => {
    await ipcRenderer.invoke(ipcChannels.characterDelete, { characterId });
  },
  importCharacterPackage: (): Promise<CharacterImportResult> => (
    ipcRenderer.invoke(ipcChannels.characterPackageImport, {})
  ),
  exportCharacterPackage: (characterId): Promise<CharacterExportResult> => (
    ipcRenderer.invoke(ipcChannels.characterPackageExport, { characterId })
  ),
  getCharacterRuntimeSnapshot: async (): Promise<CharacterRuntimeSnapshot | null> => {
    const result = await ipcRenderer.invoke(ipcChannels.characterRuntimeSnapshotGet, {});
    return result.snapshot;
  },
  getCharacterRecoverySnapshot: async () => (
    characterRecoverySnapshotResultSchema.parse(
      await ipcRenderer.invoke(ipcChannels.characterRecoverySnapshotGet, {})
    )
  ),
  readCharacterRuntimeAsset: async assetId => {
    const result = await ipcRenderer.invoke(ipcChannels.characterRuntimeAssetRead, { assetId });
    return result.bytes;
  },
  subscribeCharacterEvents: (listener: (event: CharacterEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: CharacterEvent) => (
      listener(payload)
    );
    ipcRenderer.on(ipcChannels.characterEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.characterEvent, handler);
  },
  getCharacterMotionSnapshot: async (): Promise<CharacterMotionSnapshot> => {
    const result = await ipcRenderer.invoke(ipcChannels.characterMotionSnapshotGet, {});
    return characterMotionSnapshotResultSchema.parse(result).snapshot;
  },
  subscribeCharacterMotion: (
    listener: (event: CharacterMotionEvent) => void
  ): (() => void) => {
    const handler = (_event: unknown, payload: unknown): void => {
      const parsed = characterMotionEventSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(ipcChannels.characterMotionEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.characterMotionEvent, handler);
  },
  reportCharacterActionPlayed: async (playbackToken, actionId) => {
    await ipcRenderer.invoke(ipcChannels.characterActionPlayed, { playbackToken, actionId });
  },
  reportCharacterActionFeedback: async input => {
    await ipcRenderer.invoke(ipcChannels.characterActionPlayed, {
      playbackToken: input.playbackToken,
      actionId: input.actionId,
      status: input.status
    });
    if (
      e2eProbeEnabled
      && behaviorProbePlaybackToken === input.playbackToken
      && behaviorProbe.actionId === input.actionId
      && behaviorProbe.revision > 0
      // 当前令牌一旦进入终态，乱序返回的 started 或其他终态不得改写结果。
      && behaviorProbe.playbackStatus !== 'completed'
      && behaviorProbe.playbackStatus !== 'interrupted'
      && behaviorProbe.playbackStatus !== 'failed'
    ) {
      behaviorProbe = { ...behaviorProbe, playbackStatus: input.status };
    }
  },
  reportCharacterActionMilestone: async input => {
    await ipcRenderer.invoke(ipcChannels.characterActionMilestone, {
      playbackToken: input.playbackToken,
      actionId: input.actionId,
      kind: input.kind,
      frameId: input.frameId
    });
  },
  setPetMousePassthrough: async ignore => {
    await ipcRenderer.invoke(ipcChannels.petMousePassthroughSet, { ignore });
  },
  beginPetDrag: async () => {
    await ipcRenderer.invoke(ipcChannels.petDragBegin);
  },
  endPetDrag: async () => {
    await ipcRenderer.invoke(ipcChannels.petDragEnd);
  },
  openPetContextMenu: async () => {
    await ipcRenderer.invoke(ipcChannels.petContextMenuOpen);
  },
  ...(e2eProbeEnabled
    ? {
        getPetInteractionProbe: async () => (
          ipcRenderer.invoke(ipcChannels.petInteractionProbeGet)
        ),
        getCharacterBehaviorProbe: async () => structuredClone(behaviorProbe)
      }
    : {}),
  openChat: (): Promise<void> => ipcRenderer.invoke(ipcChannels.windowOpenChat),
  openSettings: (): Promise<void> => ipcRenderer.invoke(ipcChannels.windowOpenSettings),
  openCharacterWorkshop: (): Promise<void> => (
    ipcRenderer.invoke(ipcChannels.windowOpenCharacterWorkshop, {})
  ),
  onCharacterWorkshopFlushRequested: listener => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      if (!payload || typeof payload !== 'object') return;
      const token = (payload as Record<string, unknown>)['token'];
      if (typeof token !== 'string' || token.length === 0) return;

      void (async () => {
        let ok = true;
        try {
          await listener();
        } catch {
          ok = false;
        }
        try {
          ipcRenderer.send(
            ipcChannels.characterWorkshopFlushAcknowledgement,
            { token, ok }
          );
        } catch {
          // Renderer 已进入销毁阶段时，Main 的固定超时会继续放行退出。
        }
      })();
    };
    ipcRenderer.on(ipcChannels.characterWorkshopFlushRequest, handler);
    return () => (
      ipcRenderer.removeListener(ipcChannels.characterWorkshopFlushRequest, handler)
    );
  },
  hideChat: (): Promise<void> => ipcRenderer.invoke(ipcChannels.windowHideChat),
  quit: (): Promise<void> => ipcRenderer.invoke(ipcChannels.appQuit)
};

contextBridge.exposeInMainWorld('myself', api);
