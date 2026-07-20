import type { IpcMain } from 'electron';
import { ipcChannels } from '../../shared/ipc-channels';

export type WindowIpcActions = {
  openChat(): unknown;
  openSettings(): unknown;
  hideChat(): unknown;
  quit(): unknown;
};

function replaceHandler(
  ipcMain: IpcMain,
  channel: string,
  handler: () => unknown
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, handler);
}

export function registerWindowIpc(
  ipcMain: IpcMain,
  version: string,
  actions: WindowIpcActions
): void {
  replaceHandler(ipcMain, ipcChannels.appGetStatus, () => ({ version, ready: true }));
  replaceHandler(ipcMain, ipcChannels.windowOpenChat, () => actions.openChat());
  replaceHandler(ipcMain, ipcChannels.windowOpenSettings, () => actions.openSettings());
  replaceHandler(ipcMain, ipcChannels.windowHideChat, () => actions.hideChat());
  replaceHandler(ipcMain, ipcChannels.appQuit, () => actions.quit());
}
