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
  CharacterSummaryDto
} from '../shared/character-ipc';
import {
  characterMotionEventSchema,
  characterMotionSnapshotResultSchema,
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
  saveCharacterDraft: async (characterId, draft) => {
    await ipcRenderer.invoke(ipcChannels.characterDraftSave, { characterId, draft });
  },
  chooseCharacterSources: (characterId): Promise<CharacterSourceChoiceResult> => (
    ipcRenderer.invoke(ipcChannels.characterSourcesChoose, { characterId })
  ),
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
  openChat: (): Promise<void> => ipcRenderer.invoke(ipcChannels.windowOpenChat),
  openSettings: (): Promise<void> => ipcRenderer.invoke(ipcChannels.windowOpenSettings),
  openCharacterWorkshop: (): Promise<void> => (
    ipcRenderer.invoke(ipcChannels.windowOpenCharacterWorkshop, {})
  ),
  hideChat: (): Promise<void> => ipcRenderer.invoke(ipcChannels.windowHideChat),
  quit: (): Promise<void> => ipcRenderer.invoke(ipcChannels.appQuit)
};

contextBridge.exposeInMainWorld('myself', api);
