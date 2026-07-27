import { contextBridge, ipcRenderer } from 'electron';
import type { PublicSettings, TaskEvent } from '@myself/shared-types';
import { ipcChannels } from '../shared/ipc-channels';
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
  openChat: (): Promise<void> => ipcRenderer.invoke(ipcChannels.windowOpenChat),
  openSettings: (): Promise<void> => ipcRenderer.invoke(ipcChannels.windowOpenSettings),
  hideChat: (): Promise<void> => ipcRenderer.invoke(ipcChannels.windowHideChat),
  quit: (): Promise<void> => ipcRenderer.invoke(ipcChannels.appQuit)
};

contextBridge.exposeInMainWorld('myself', api);
