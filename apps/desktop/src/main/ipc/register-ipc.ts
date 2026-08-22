import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import {
  type HistoryDisclosureDecision,
  modelRouteConfigSchema,
  storedProviderProfileV2Schema,
  type PublicSettings
} from '@myself/shared-types';
import { privacySettingsSchema } from '../storage/settings-store';
import { z } from 'zod';
import { ipcChannels } from '../../shared/ipc-channels';
import {
  characterBytesResultSchema,
  characterActivateInputSchema,
  characterCreateInputSchema,
  characterDraftResultSchema,
  characterDraftSaveInputSchema,
  characterEmptyInputSchema,
  characterExportResultSchema,
  characterIdInputSchema,
  characterImportResultSchema,
  characterListResultSchema,
  characterMutationResultSchema,
  characterPublishInputSchema,
  characterRecoverySnapshotResultSchema,
  characterRuntimeAssetReadInputSchema,
  characterRuntimeSnapshotResultSchema,
  characterSourceChoiceResultSchema,
  characterSourceReadInputSchema,
  characterSourceSchema,
  characterSummarySchema,
  characterSourcesResultSchema,
  type CharacterPublishInput,
  type CharacterRecoverySnapshotDto,
  type CharacterRuntimeSnapshot,
  type CharacterWorkshopSourceDto
} from '../../shared/character-ipc';
import type { CharacterDraftV2 } from '@myself/character-runtime';
import { petMousePassthroughInputSchema } from '../../shared/pet-window-interaction';
import {
  characterActionFeedbackInputSchema,
  characterActionMilestoneInputSchema,
  characterMotionEmptyInputSchema,
  characterActionPlayedInputSchema,
  characterMotionSnapshotResultSchema,
  type CharacterActionFeedbackInput,
  type CharacterActionMilestoneInput,
  type CharacterMotionSnapshot
} from '../../shared/character-motion-ipc';

export type WindowIpcActions = {
  openChat(): unknown;
  openSettings(): unknown;
  openCharacterWorkshop(): unknown;
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

const historyDisclosureSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  decision: z.enum(['share_once', 'current_message_only'])
}).strict();
const emptyArgumentsSchema = z.tuple([]);

export interface AgentIpcService {
  submit(text: string): Promise<void>;
  hasReportedFailure(error: unknown): boolean;
  cancelActive(): void;
  resolveFileAction(actionId: string, decision: 'confirm' | 'cancel'): Promise<void>;
  resolveHistoryDisclosure(
    requestId: string,
    decision: HistoryDisclosureDecision
  ): Promise<void>;
  resetConversation(): Promise<void>;
}

function assertCurrentChatSender(
  event: Pick<IpcMainInvokeEvent, 'sender'>,
  getCurrentChatWebContents: () => WebContents | null
): void {
  const current = getCurrentChatWebContents();
  if (!current || current.isDestroyed() || event.sender !== current) {
    throw new Error('AGENT_IPC_SENDER_INVALID');
  }
}

export function registerAgentIpc(
  ipcMain: IpcMain,
  service: AgentIpcService,
  getCurrentChatWebContents: () => WebContents | null
): void {
  replaceHandler(ipcMain, ipcChannels.chatSubmit, async (event, raw) => {
    assertCurrentChatSender(event, getCurrentChatWebContents);
    const { text } = chatSubmitSchema.parse(raw);
    try {
      await service.submit(text);
    } catch (error) {
      // 仅吞掉已发布任务事件的错误，其他 IPC 故障继续交给 Renderer 兜底。
      if (!service.hasReportedFailure(error)) throw error;
    }
  });
  replaceHandler(ipcMain, ipcChannels.chatCancel, event => {
    assertCurrentChatSender(event, getCurrentChatWebContents);
    return service.cancelActive();
  });
  replaceHandler(ipcMain, ipcChannels.actionConfirm, async (event, raw) => {
    assertCurrentChatSender(event, getCurrentChatWebContents);
    const { actionId } = actionIdSchema.parse(raw);
    await service.resolveFileAction(actionId, 'confirm');
  });
  replaceHandler(ipcMain, ipcChannels.actionCancel, async (event, raw) => {
    assertCurrentChatSender(event, getCurrentChatWebContents);
    const { actionId } = actionIdSchema.parse(raw);
    await service.resolveFileAction(actionId, 'cancel');
  });
  replaceHandler(ipcMain, ipcChannels.conversationDisclosureResolve, async (event, raw) => {
    assertCurrentChatSender(event, getCurrentChatWebContents);
    const { requestId, decision } = historyDisclosureSchema.parse(raw);
    await service.resolveHistoryDisclosure(requestId, decision);
  });
  replaceHandler(ipcMain, ipcChannels.conversationReset, async (event, ...args) => {
    assertCurrentChatSender(event, getCurrentChatWebContents);
    emptyArgumentsSchema.parse(args);
    await service.resetConversation();
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
const incognitoSchema = z.object({ incognito: z.boolean() }).strict();
const petAlwaysOnTopSaveSchema = z.object({ enabled: z.boolean() }).strict();

export interface AdvancedSettingsIpcService {
  getDashboard(): Promise<unknown>;
  saveProviderProfile(input: z.infer<typeof profileSaveSchema>): Promise<unknown>;
  deleteProviderProfile(profileId: string): Promise<unknown>;
  saveModelRoute(route: z.infer<typeof modelRouteConfigSchema>): Promise<unknown>;
  testProviderProfile(profileId: string): Promise<unknown>;
  savePrivacySettings(input: z.infer<typeof privacySettingsSchema>): Promise<unknown>;
  savePetAlwaysOnTop(enabled: boolean): Promise<unknown>;
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
  replaceHandler(ipcMain, ipcChannels.settingsPrivacySave, async (_event, raw) => {
    const input = parseInput(privacySettingsSchema, raw);
    return changed(() => service.savePrivacySettings(input));
  });
  replaceHandler(ipcMain, ipcChannels.settingsPetAlwaysOnTopSave, async (_event, raw) => {
    const { enabled } = parseInput(petAlwaysOnTopSaveSchema, raw);
    return service.savePetAlwaysOnTop(enabled);
  });
  replaceHandler(ipcMain, ipcChannels.settingsIncognitoSet, async (_event, raw) => {
    const { incognito } = parseInput(incognitoSchema, raw);
    return changed(() => service.setIncognitoSession(incognito));
  });
  replaceHandler(ipcMain, ipcChannels.settingsRootRevoke, async () => (
    changed(() => service.revokeAuthorizedRoot())
  ));
}

export interface CharacterIpcService {
  listCharacters(): Promise<Array<z.input<typeof characterSummarySchema>>>;
  createCharacter(input: { name: string }): Promise<CharacterDraftV2>;
  duplicateCharacter(characterId: string): Promise<CharacterDraftV2>;
  getCharacterDraft(characterId: string): Promise<CharacterDraftV2>;
  saveCharacterDraft(
    characterId: string,
    draft: CharacterDraftV2,
    draftRevision: string
  ): Promise<void>;
  chooseCharacterSources(
    characterId: string,
    selectedPaths: readonly string[]
  ): Promise<unknown[]>;
  listCharacterSources(characterId: string): Promise<CharacterWorkshopSourceDto[]>;
  readCharacterSource(characterId: string, assetId: string): Promise<Uint8Array>;
  publishCharacter(input: CharacterPublishInput): Promise<void>;
  activateCharacter(characterId: string, confirmIncomplete?: boolean): Promise<void>;
  deleteCharacter(characterId: string): Promise<void>;
  importCharacterPackage(packagePath: string): Promise<string>;
  exportCharacterPackage(
    characterId: string,
    destination: string
  ): Promise<'exported' | 'recovery-exported'>;
  getCharacterRuntimeSnapshot(): Promise<CharacterRuntimeSnapshot | null>;
  readCharacterRuntimeAsset(assetId: string): Promise<Uint8Array>;
}

export interface CharacterIpcDialogs {
  chooseCharacterSources(): Promise<{
    canceled: boolean;
    filePaths: string[];
  }>;
  chooseCharacterPackage(): Promise<{
    canceled: boolean;
    filePaths: string[];
  }>;
  chooseCharacterExportDestination(characterId: string): Promise<{
    canceled: boolean;
    filePath?: string;
  }>;
}

export interface CharacterMotionIpcService {
  getSnapshot(): CharacterMotionSnapshot;
  applyPlaybackFeedback(feedback: CharacterActionFeedbackInput): void | Promise<void>;
}

export interface CharacterActionTransactionObserver {
  onPlaybackStarted(playbackToken: string, actionId: string): boolean | void;
  onPlaybackTerminal(
    playbackToken: string,
    actionId: string,
    terminal: Exclude<CharacterActionFeedbackInput['status'], 'started'>
  ): boolean | void;
  onCommitFrame(playbackToken: string, actionId: string, frameId: string): boolean;
}

function characterInputError(): Error & { code: string } {
  return Object.assign(new Error('CHARACTER_INPUT_INVALID'), {
    code: 'CHARACTER_INPUT_INVALID'
  });
}

function characterPublicError(error: unknown): Error & { code: string } {
  const code = (
    error instanceof Error
    && /^CHARACTER_[A-Z0-9_]+$/u.test(error.message)
  )
    ? error.message
    : 'CHARACTER_OPERATION_FAILED';
  return Object.assign(new Error(code), { code });
}

function parseCharacterInput<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown
): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw characterInputError();
  return parsed.data as z.output<S>;
}

async function characterOperation<S extends z.ZodTypeAny>(
  schema: S,
  operation: () => Promise<unknown>
): Promise<z.output<S>> {
  try {
    return schema.parse(await operation()) as z.output<S>;
  } catch (error) {
    throw characterPublicError(error);
  }
}

/** 角色 IPC 只注册固定命令，并在 Main 内完成 dialog 路径选择。 */
export function registerCharacterIpc(
  ipcMain: IpcMain,
  service: CharacterIpcService,
  dialogs: CharacterIpcDialogs,
  recoverySnapshot: CharacterRecoverySnapshotDto
): void {
  replaceHandler(ipcMain, ipcChannels.characterList, async (_event, raw) => {
    parseCharacterInput(characterEmptyInputSchema, raw);
    return characterOperation(characterListResultSchema, async () => ({
      characters: await service.listCharacters()
    }));
  });
  replaceHandler(ipcMain, ipcChannels.characterCreate, async (_event, raw) => {
    const input = parseCharacterInput(characterCreateInputSchema, raw);
    return characterOperation(characterDraftResultSchema, async () => ({
      draft: await service.createCharacter(input)
    }));
  });
  replaceHandler(ipcMain, ipcChannels.characterDuplicate, async (_event, raw) => {
    const { characterId } = parseCharacterInput(characterIdInputSchema, raw);
    return characterOperation(characterDraftResultSchema, async () => ({
      draft: await service.duplicateCharacter(characterId)
    }));
  });
  replaceHandler(ipcMain, ipcChannels.characterDraftGet, async (_event, raw) => {
    const { characterId } = parseCharacterInput(characterIdInputSchema, raw);
    return characterOperation(characterDraftResultSchema, async () => ({
      draft: await service.getCharacterDraft(characterId)
    }));
  });
  replaceHandler(ipcMain, ipcChannels.characterDraftSave, async (_event, raw) => {
    const { characterId, draft, draftRevision } = parseCharacterInput(
      characterDraftSaveInputSchema,
      raw
    );
    return characterOperation(characterMutationResultSchema, async () => {
      await service.saveCharacterDraft(characterId, draft, draftRevision);
      return { ok: true };
    });
  });
  replaceHandler(ipcMain, ipcChannels.characterSourcesChoose, async (_event, raw) => {
    const { characterId } = parseCharacterInput(characterIdInputSchema, raw);
    return characterOperation(characterSourceChoiceResultSchema, async () => {
      const selected = await dialogs.chooseCharacterSources();
      if (selected.canceled) return { kind: 'cancelled' };
      const sources = await service.chooseCharacterSources(
        characterId,
        selected.filePaths
      );
      return {
        kind: 'selected',
        sources: z.array(characterSourceSchema).parse(sources)
      };
    });
  });
  replaceHandler(ipcMain, ipcChannels.characterSourcesList, async (_event, raw) => {
    const { characterId } = parseCharacterInput(characterIdInputSchema, raw);
    return characterOperation(characterSourcesResultSchema, async () => ({
      sources: await service.listCharacterSources(characterId)
    }));
  });
  replaceHandler(ipcMain, ipcChannels.characterSourceRead, async (_event, raw) => {
    const { characterId, assetId } = parseCharacterInput(
      characterSourceReadInputSchema,
      raw
    );
    return characterOperation(characterBytesResultSchema, async () => ({
      bytes: await service.readCharacterSource(characterId, assetId)
    }));
  });
  replaceHandler(ipcMain, ipcChannels.characterPublish, async (_event, raw) => {
    const input = parseCharacterInput(characterPublishInputSchema, raw);
    return characterOperation(characterMutationResultSchema, async () => {
      await service.publishCharacter(input);
      return { ok: true };
    });
  });
  replaceHandler(ipcMain, ipcChannels.characterActivate, async (_event, raw) => {
    const { characterId, confirmIncomplete } = parseCharacterInput(
      characterActivateInputSchema,
      raw
    );
    return characterOperation(characterMutationResultSchema, async () => {
      if (confirmIncomplete) {
        await service.activateCharacter(characterId, true);
      } else {
        await service.activateCharacter(characterId);
      }
      return { ok: true };
    });
  });
  replaceHandler(ipcMain, ipcChannels.characterDelete, async (_event, raw) => {
    const { characterId } = parseCharacterInput(characterIdInputSchema, raw);
    return characterOperation(characterMutationResultSchema, async () => {
      await service.deleteCharacter(characterId);
      return { ok: true };
    });
  });
  replaceHandler(ipcMain, ipcChannels.characterPackageImport, async (_event, raw) => {
    parseCharacterInput(characterEmptyInputSchema, raw);
    return characterOperation(characterImportResultSchema, async () => {
      const selected = await dialogs.chooseCharacterPackage();
      if (selected.canceled) return { kind: 'cancelled' };
      const packagePath = selected.filePaths[0];
      if (!packagePath) throw new Error('CHARACTER_PACKAGE_SELECTION_INVALID');
      return {
        kind: 'imported',
        characterId: await service.importCharacterPackage(packagePath)
      };
    });
  });
  replaceHandler(ipcMain, ipcChannels.characterPackageExport, async (_event, raw) => {
    const { characterId } = parseCharacterInput(characterIdInputSchema, raw);
    return characterOperation(characterExportResultSchema, async () => {
      const selected = await dialogs.chooseCharacterExportDestination(characterId);
      if (selected.canceled) return { kind: 'cancelled' };
      if (!selected.filePath) {
        throw new Error('CHARACTER_PACKAGE_SELECTION_INVALID');
      }
      const kind = await service.exportCharacterPackage(
        characterId,
        selected.filePath
      );
      return { kind };
    });
  });
  replaceHandler(
    ipcMain,
    ipcChannels.characterRuntimeSnapshotGet,
    async (_event, raw) => {
      parseCharacterInput(characterEmptyInputSchema, raw);
      return characterOperation(characterRuntimeSnapshotResultSchema, async () => ({
        snapshot: await service.getCharacterRuntimeSnapshot()
      }));
    }
  );
  replaceHandler(
    ipcMain,
    ipcChannels.characterRecoverySnapshotGet,
    async (_event, raw) => {
      parseCharacterInput(characterEmptyInputSchema, raw);
      return characterOperation(
        characterRecoverySnapshotResultSchema,
        async () => recoverySnapshot
      );
    }
  );
  replaceHandler(
    ipcMain,
    ipcChannels.characterRuntimeAssetRead,
    async (_event, raw) => {
      const { assetId } = parseCharacterInput(characterRuntimeAssetReadInputSchema, raw);
      return characterOperation(characterBytesResultSchema, async () => ({
        bytes: await service.readCharacterRuntimeAsset(assetId)
      }));
    }
  );
}

/** Renderer 只能读取 Main 权威快照，不能提交坐标或目标位置。 */
export function registerCharacterMotionIpc(
  ipcMain: IpcMain,
  service: CharacterMotionIpcService,
  petWebContents: WebContents,
  transactionObserver?: CharacterActionTransactionObserver
): void {
  replaceHandler(
    ipcMain,
    ipcChannels.characterMotionSnapshotGet,
    async (_event, raw) => {
      parseCharacterInput(characterMotionEmptyInputSchema, raw);
      return characterOperation(characterMotionSnapshotResultSchema, async () => ({
        snapshot: service.getSnapshot()
      }));
    }
  );
  replaceHandler(
    ipcMain,
    ipcChannels.characterActionPlayed,
    async (event, raw) => {
      if (event.sender !== petWebContents) {
        throw new Error('CHARACTER_PLAYBACK_SENDER_INVALID');
      }
      const report = parseCharacterInput(
        z.union([
          characterActionFeedbackInputSchema,
          characterActionPlayedInputSchema
        ]),
        raw
      );
      await service.applyPlaybackFeedback({
        ...report,
        status: 'status' in report ? report.status : 'started'
      });
      const status = 'status' in report ? report.status : 'started';
      if (status === 'started') {
        transactionObserver?.onPlaybackStarted(report.playbackToken, report.actionId);
      } else {
        transactionObserver?.onPlaybackTerminal(report.playbackToken, report.actionId, status);
      }
      return { ok: true };
    }
  );
  replaceHandler(
    ipcMain,
    ipcChannels.characterActionMilestone,
    async (event, raw) => {
      if (event.sender !== petWebContents) {
        throw new Error('CHARACTER_PLAYBACK_SENDER_INVALID');
      }
      const milestone: CharacterActionMilestoneInput = parseCharacterInput(
        characterActionMilestoneInputSchema,
        raw
      );
      if (!transactionObserver) {
        throw new Error('CHARACTER_ACTION_MILESTONE_UNAVAILABLE');
      }
      const accepted = transactionObserver.onCommitFrame(
        milestone.playbackToken,
        milestone.actionId,
        milestone.frameId
      );
      if (!accepted) throw new Error('CHARACTER_ACTION_MILESTONE_REJECTED');
      return { ok: true };
    }
  );
}

type PetWindowInteractionControllerActions = {
  setPassthrough(ignore: boolean): void;
  beginDrag(): void;
  endDrag(reason: 'released' | 'cancelled' | 'timeout' | 'disposed'): void;
  dispose(): void;
  getProbe?(): { passthrough: boolean; dragging: boolean };
};

function assertPetWindowSender(
  event: IpcMainInvokeEvent,
  petWebContents: WebContents
): void {
  if (event.sender !== petWebContents || petWebContents.isDestroyed()) {
    throw new Error('PET_WINDOW_INTERACTION_SENDER_INVALID');
  }
}

function assertNoPetInteractionInput(args: readonly unknown[]): void {
  if (args.length !== 0) {
    throw new Error('PET_WINDOW_INTERACTION_INPUT_INVALID');
  }
}

/** 桌宠窗口交互只接受固定命令，坐标与菜单实现全部留在 Main。 */
export function registerPetWindowInteractionIpc(
  ipcMain: IpcMain,
  controller: PetWindowInteractionControllerActions,
  petWebContents: WebContents,
  openContextMenu: () => unknown,
  options: { enableE2eProbe?: boolean } = {}
): void {
  replaceHandler(
    ipcMain,
    ipcChannels.petMousePassthroughSet,
    async (event, ...args) => {
      assertPetWindowSender(event, petWebContents);
      if (args.length !== 1) {
        throw new Error('PET_WINDOW_INTERACTION_INPUT_INVALID');
      }
      const parsed = petMousePassthroughInputSchema.safeParse(args[0]);
      if (!parsed.success) {
        throw new Error('PET_WINDOW_INTERACTION_INPUT_INVALID');
      }
      controller.setPassthrough(parsed.data.ignore);
    }
  );
  replaceHandler(ipcMain, ipcChannels.petDragBegin, async (event, ...args) => {
    assertPetWindowSender(event, petWebContents);
    assertNoPetInteractionInput(args);
    controller.beginDrag();
  });
  replaceHandler(ipcMain, ipcChannels.petDragEnd, async (event, ...args) => {
    assertPetWindowSender(event, petWebContents);
    assertNoPetInteractionInput(args);
    controller.endDrag('released');
  });
  replaceHandler(ipcMain, ipcChannels.petContextMenuOpen, async (event, ...args) => {
    assertPetWindowSender(event, petWebContents);
    assertNoPetInteractionInput(args);
    await openContextMenu();
  });
  if (options.enableE2eProbe) {
    replaceHandler(
      ipcMain,
      ipcChannels.petInteractionProbeGet,
      async (event, ...args) => {
        assertPetWindowSender(event, petWebContents);
        assertNoPetInteractionInput(args);
        const probe = controller.getProbe?.();
        if (!probe) throw new Error('PET_WINDOW_INTERACTION_PROBE_UNAVAILABLE');
        return {
          passthrough: Boolean(probe.passthrough),
          dragging: Boolean(probe.dragging)
        };
      }
    );
  }
}

export function registerWindowIpc(
  ipcMain: IpcMain,
  version: string,
  actions: WindowIpcActions
): void {
  replaceHandler(ipcMain, ipcChannels.appGetStatus, () => ({ version, ready: true }));
  replaceHandler(ipcMain, ipcChannels.windowOpenChat, () => actions.openChat());
  replaceHandler(ipcMain, ipcChannels.windowOpenSettings, () => actions.openSettings());
  replaceHandler(
    ipcMain,
    ipcChannels.windowOpenCharacterWorkshop,
    async (_event, raw) => {
      parseCharacterInput(characterEmptyInputSchema, raw);
      return actions.openCharacterWorkshop();
    }
  );
  replaceHandler(ipcMain, ipcChannels.windowHideChat, () => actions.hideChat());
  replaceHandler(ipcMain, ipcChannels.appQuit, () => actions.quit());
}
