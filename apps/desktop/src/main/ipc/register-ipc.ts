import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { PublicSettings } from '@myself/shared-types';
import { z } from 'zod';
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
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, handler);
}

const providerUrlSchema = z.string().url().refine(value => {
  const url = new URL(value);
  if (url.protocol === 'https:') return true;
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  return url.protocol === 'http:' && loopbackHosts.has(url.hostname);
}, 'PROVIDER_URL_REQUIRES_HTTPS');

const saveProviderSchema = z.object({
  displayName: z.string().trim().min(1),
  baseUrl: providerUrlSchema,
  model: z.string().trim().min(1),
  secret: z.string().min(1),
  persistSecret: z.boolean()
}).strict();

const clearLocalDataSchema = z.object({
  scope: z.enum(['conversation', 'audit', 'secret', 'all'])
}).strict();

export interface SettingsIpcStore {
  getPublic(): Promise<PublicSettings>;
  saveProviderMetadata(input: {
    id: string;
    displayName: string;
    baseUrl: string;
    model: string;
  }): Promise<void>;
}

export interface SettingsIpcSecrets {
  save(secret: string, persist: boolean): Promise<void>;
  clear(): Promise<void>;
}

export function registerSettingsIpc(
  ipcMain: IpcMain,
  settings: SettingsIpcStore,
  secrets: SettingsIpcSecrets
): void {
  replaceHandler(ipcMain, ipcChannels.settingsGet, () => settings.getPublic());
  replaceHandler(ipcMain, ipcChannels.settingsSaveProvider, async (_event, raw) => {
    const input = saveProviderSchema.parse(raw);
    await secrets.save(input.secret, input.persistSecret);
    await settings.saveProviderMetadata({
      id: 'default',
      displayName: input.displayName,
      baseUrl: input.baseUrl,
      model: input.model
    });
    return settings.getPublic();
  });
  replaceHandler(ipcMain, ipcChannels.settingsClearLocalData, async (_event, raw) => {
    const { scope } = clearLocalDataSchema.parse(raw);
    if (scope === 'secret' || scope === 'all') await secrets.clear();
    return settings.getPublic();
  });
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
