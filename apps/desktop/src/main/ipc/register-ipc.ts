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
  profileId: z.string().optional(),
  displayName: z.string().trim().min(1),
  baseUrl: providerUrlSchema,
  model: z.string().trim().min(1),
  secret: z.string().min(1),
  persistSecret: z.boolean()
}).strict();

const clearLocalDataSchema = z.object({
  scope: z.enum(['conversation', 'audit', 'secret', 'all']),
  profileId: z.string().optional()
}).strict();

const chatSubmitSchema = z.object({
  text: z.string().trim().min(1).max(4_000)
}).strict();

const actionIdSchema = z.object({
  actionId: z.string().min(1)
}).strict();

export interface AgentIpcService {
  submit(text: string): Promise<void>;
  cancelActive(): void;
  confirm(actionId: string): Promise<void>;
  cancelAction(actionId: string): void;
}

export function registerAgentIpc(ipcMain: IpcMain, service: AgentIpcService): void {
  replaceHandler(ipcMain, ipcChannels.chatSubmit, async (_event, raw) => {
    const { text } = chatSubmitSchema.parse(raw);
    await service.submit(text);
  });
  replaceHandler(ipcMain, ipcChannels.chatCancel, () => service.cancelActive());
  replaceHandler(ipcMain, ipcChannels.actionConfirm, async (_event, raw) => {
    const { actionId } = actionIdSchema.parse(raw);
    await service.confirm(actionId);
  });
  replaceHandler(ipcMain, ipcChannels.actionCancel, (_event, raw) => {
    const { actionId } = actionIdSchema.parse(raw);
    service.cancelAction(actionId);
  });
}

export interface SettingsIpcStore {
  getPublic(): Promise<PublicSettings>;
  saveProviderMetadata(input: {
    id: string;
    displayName: string;
    baseUrl: string;
    model: string;
  }): Promise<void>;
  clearAll(): Promise<void>;
}

export interface SettingsIpcSecrets {
  save(profileId: string, secret: string, persist: boolean): Promise<void>;
  clear(profileId: string): Promise<void>;
  clearAll(): Promise<void>;
}

export interface SettingsIpcLifecycle {
  onProviderChanged(): void;
  onAuthorizedRootChanged?(): void;
}

export interface SettingsIpcActions {
  testProvider(): Promise<{ ok: boolean; message: string }>;
  chooseAuthorizedRoot(): Promise<void>;
}

export function registerSettingsIpc(
  ipcMain: IpcMain,
  settings: SettingsIpcStore,
  secrets: SettingsIpcSecrets,
  lifecycle?: SettingsIpcLifecycle,
  actions?: SettingsIpcActions
): void {
  replaceHandler(ipcMain, ipcChannels.settingsGet, () => settings.getPublic());
  replaceHandler(ipcMain, ipcChannels.settingsTestProvider, async () => {
    if (!actions) throw new Error('SETTINGS_ACTION_UNAVAILABLE');
    return actions.testProvider();
  });
  replaceHandler(ipcMain, ipcChannels.settingsChooseRoot, async () => {
    if (!actions) throw new Error('SETTINGS_ACTION_UNAVAILABLE');
    await actions.chooseAuthorizedRoot();
    lifecycle?.onAuthorizedRootChanged?.();
    return settings.getPublic();
  });
  replaceHandler(ipcMain, ipcChannels.settingsSaveProvider, async (_event, raw) => {
    const input = saveProviderSchema.parse(raw);
    const profileId = input.profileId ?? 'default';
    await secrets.save(profileId, input.secret, input.persistSecret);
    await settings.saveProviderMetadata({
      id: profileId,
      displayName: input.displayName,
      baseUrl: input.baseUrl,
      model: input.model
    });
    lifecycle?.onProviderChanged();
    return settings.getPublic();
  });
  replaceHandler(ipcMain, ipcChannels.settingsClearLocalData, async (_event, raw) => {
    const { scope, profileId } = clearLocalDataSchema.parse(raw);
    if (scope === 'all') {
      await settings.clearAll();
      lifecycle?.onAuthorizedRootChanged?.();
    }
    if (scope === 'secret') {
      await secrets.clear(profileId ?? 'default');
      lifecycle?.onProviderChanged();
    }
    if (scope === 'all') {
      await secrets.clearAll();
      lifecycle?.onProviderChanged();
    }
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
