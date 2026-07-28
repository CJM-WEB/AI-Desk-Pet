import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  modelRouteConfigSchema,
  storedProviderProfileV2Schema,
  type PublicSettings
} from '@myself/shared-types';
import { privacySettingsSchema } from '../storage/settings-store';
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
  if (url.username || url.password) return false;
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
  hasReportedFailure(error: unknown): boolean;
  cancelActive(): void;
  confirm(actionId: string): Promise<void>;
  cancelAction(actionId: string): void;
}

export function registerAgentIpc(ipcMain: IpcMain, service: AgentIpcService): void {
  replaceHandler(ipcMain, ipcChannels.chatSubmit, async (_event, raw) => {
    const { text } = chatSubmitSchema.parse(raw);
    try {
      await service.submit(text);
    } catch (error) {
      // 仅吞掉已发布任务事件的错误，其他 IPC 故障继续交给 Renderer 兜底。
      if (!service.hasReportedFailure(error)) throw error;
    }
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

const identifierSchema = z.string().trim().min(1).max(128);
const profileSaveSchema = z.object({
  profile: storedProviderProfileV2Schema,
  secret: z.string().min(1).optional(),
  persistSecret: z.boolean()
}).strict();
const profileIdSchema = z.object({ profileId: identifierSchema }).strict();
const routeSaveSchema = z.object({ route: modelRouteConfigSchema }).strict();
const serverIdSchema = z.object({ serverId: identifierSchema }).strict();
const stdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string().min(1), z.string()).optional(),
  inheritEnv: z.array(z.string().min(1)).optional()
}).strict();
const httpTransportSchema = z.object({
  type: z.literal('http'),
  url: providerUrlSchema,
  headers: z.record(z.string().min(1), z.string()).optional()
}).strict();
const mcpUpsertSchema = z.object({
  id: identifierSchema,
  enabled: z.boolean(),
  transport: z.discriminatedUnion('type', [stdioTransportSchema, httpTransportSchema])
}).strict();
const mcpConfirmationSchema = z.object({
  serverId: identifierSchema,
  fingerprint: z.string().min(1).max(256)
}).strict();
const serverToggleSchema = z.object({
  serverId: identifierSchema,
  enabled: z.boolean()
}).strict();
const toolToggleSchema = z.object({
  serverId: identifierSchema,
  toolName: identifierSchema,
  enabled: z.boolean()
}).strict();
const toolAuthorizationSchema = z.object({
  serverId: identifierSchema,
  toolName: identifierSchema
}).strict();
const incognitoSchema = z.object({ incognito: z.boolean() }).strict();

export interface AdvancedSettingsIpcService {
  getDashboard(): Promise<unknown>;
  saveProviderProfile(input: z.infer<typeof profileSaveSchema>): Promise<unknown>;
  deleteProviderProfile(profileId: string): Promise<unknown>;
  saveModelRoute(route: z.infer<typeof modelRouteConfigSchema>): Promise<unknown>;
  testProviderProfile(profileId: string): Promise<unknown>;
  upsertMcpServer(input: z.infer<typeof mcpUpsertSchema>): Promise<unknown>;
  confirmMcpLaunch(serverId: string, fingerprint: string): Promise<unknown>;
  testMcpServer(serverId: string): Promise<unknown>;
  setMcpServerEnabled(serverId: string, enabled: boolean): Promise<unknown>;
  setMcpToolEnabled(serverId: string, toolName: string, enabled: boolean): Promise<unknown>;
  authorizeMcpToolReadOnly(serverId: string, toolName: string): Promise<unknown>;
  revokeMcpToolReadOnly(serverId: string, toolName: string): Promise<unknown>;
  deleteMcpServer(serverId: string): Promise<unknown>;
  savePrivacySettings(input: z.infer<typeof privacySettingsSchema>): Promise<unknown>;
  setIncognitoSession(incognito: boolean): Promise<unknown>;
  revokeAuthorizedRoot(): Promise<unknown>;
}

export interface AdvancedSettingsLifecycle {
  onConfigurationChanged(): void;
}

function inputError(): Error & { code: string } {
  return Object.assign(new Error('SETTINGS_INPUT_INVALID'), {
    code: 'SETTINGS_INPUT_INVALID'
  });
}

function parseInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw inputError();
  return parsed.data;
}

export function registerAdvancedSettingsIpc(
  ipcMain: IpcMain,
  service: AdvancedSettingsIpcService,
  lifecycle?: AdvancedSettingsLifecycle
): void {
  const changed = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = await operation();
    lifecycle?.onConfigurationChanged();
    return result;
  };

  replaceHandler(ipcMain, ipcChannels.settingsDashboardGet, async () => service.getDashboard());
  replaceHandler(ipcMain, ipcChannels.settingsProfileSave, async (_event, raw) => {
    const input = parseInput(profileSaveSchema, raw);
    return changed(() => service.saveProviderProfile(input));
  });
  replaceHandler(ipcMain, ipcChannels.settingsProfileDelete, async (_event, raw) => {
    const { profileId } = parseInput(profileIdSchema, raw);
    return changed(() => service.deleteProviderProfile(profileId));
  });
  replaceHandler(ipcMain, ipcChannels.settingsProfileTest, async (_event, raw) => {
    const { profileId } = parseInput(profileIdSchema, raw);
    return service.testProviderProfile(profileId);
  });
  replaceHandler(ipcMain, ipcChannels.settingsRouteSave, async (_event, raw) => {
    const { route } = parseInput(routeSaveSchema, raw);
    return changed(() => service.saveModelRoute(route));
  });
  replaceHandler(ipcMain, ipcChannels.settingsMcpUpsert, async (_event, raw) => {
    const input = parseInput(mcpUpsertSchema, raw);
    return changed(() => service.upsertMcpServer(input));
  });
  replaceHandler(ipcMain, ipcChannels.settingsMcpConfirmLaunch, async (_event, raw) => {
    const { serverId, fingerprint } = parseInput(mcpConfirmationSchema, raw);
    return changed(() => service.confirmMcpLaunch(serverId, fingerprint));
  });
  replaceHandler(ipcMain, ipcChannels.settingsMcpTest, async (_event, raw) => {
    const { serverId } = parseInput(serverIdSchema, raw);
    return service.testMcpServer(serverId);
  });
  replaceHandler(ipcMain, ipcChannels.settingsMcpServerToggle, async (_event, raw) => {
    const { serverId, enabled } = parseInput(serverToggleSchema, raw);
    return changed(() => service.setMcpServerEnabled(serverId, enabled));
  });
  replaceHandler(ipcMain, ipcChannels.settingsMcpToolToggle, async (_event, raw) => {
    const { serverId, toolName, enabled } = parseInput(toolToggleSchema, raw);
    return changed(() => service.setMcpToolEnabled(serverId, toolName, enabled));
  });
  replaceHandler(ipcMain, ipcChannels.settingsMcpToolAuthorizeRead, async (_event, raw) => {
    const { serverId, toolName } = parseInput(toolAuthorizationSchema, raw);
    return changed(() => service.authorizeMcpToolReadOnly(serverId, toolName));
  });
  replaceHandler(ipcMain, ipcChannels.settingsMcpToolRevokeRead, async (_event, raw) => {
    const { serverId, toolName } = parseInput(toolAuthorizationSchema, raw);
    return changed(() => service.revokeMcpToolReadOnly(serverId, toolName));
  });
  replaceHandler(ipcMain, ipcChannels.settingsMcpDelete, async (_event, raw) => {
    const { serverId } = parseInput(serverIdSchema, raw);
    return changed(() => service.deleteMcpServer(serverId));
  });
  replaceHandler(ipcMain, ipcChannels.settingsPrivacySave, async (_event, raw) => {
    const input = parseInput(privacySettingsSchema, raw);
    return changed(() => service.savePrivacySettings(input));
  });
  replaceHandler(ipcMain, ipcChannels.settingsIncognitoSet, async (_event, raw) => {
    const { incognito } = parseInput(incognitoSchema, raw);
    return changed(() => service.setIncognitoSession(incognito));
  });
  replaceHandler(ipcMain, ipcChannels.settingsRootRevoke, async () => (
    changed(() => service.revokeAuthorizedRoot())
  ));
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
