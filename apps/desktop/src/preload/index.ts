import { contextBridge, ipcRenderer } from 'electron';
import type { PublicSettings, TaskEvent } from '@myself/shared-types';
import { ipcChannels } from '../shared/ipc-channels';
import type { LocalDataScope, MyselfApi } from '../shared/myself-api';

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
