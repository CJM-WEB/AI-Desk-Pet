import type {
  HistoryDisclosureDecision,
  ModelRouteConfig,
  ProviderCatalogEntry,
  ProviderProfileV2,
  PublicSettings,
  StoredProviderProfileV2,
  TaskEvent
} from '@myself/shared-types';
import type { CharacterDraftV2 } from '@myself/character-runtime';
import type {
  CharacterCreateInput,
  CharacterEvent,
  CharacterExportResult,
  CharacterImportResult,
  CharacterPublishInput,
  CharacterRecoverySnapshotDto,
  CharacterRuntimeSnapshot,
  CharacterSourceChoiceResult,
  CharacterSummaryDto,
  CharacterWorkshopSourceDto
} from './character-ipc';
import type {
  CharacterActionFeedbackInput,
  CharacterBehaviorProbe,
  CharacterMotionDeltaProbe,
  CharacterMotionEvent,
  CharacterMotionSnapshot
} from './character-motion-ipc';
import type {
  PetWindowInteractionApi,
  PetViewportCommitInput
} from './pet-window-interaction';
import type { PetGeometryRenderView } from './character-motion-ipc';
import type { LocalModelPublicStatus } from './local-model-ipc';

export type LocalDataScope = 'conversation' | 'audit' | 'secret' | 'all';

export interface SaveProviderInput {
  profileId?: string;
  displayName: string;
  baseUrl: string;
  model: string;
  secret: string;
  persistSecret: boolean;
}

export interface PrivacySettingsDto {
  dataCategories: {
    file: boolean;
    memory: boolean;
  };
  longTermMemory: boolean;
  proactivityMode: 'passive' | 'assistive' | 'autonomous';
}

export interface PrivacyRuntimeSupportDto {
  dataCategories: {
    file: boolean;
    memory: boolean;
  };
  longTermMemory: boolean;
  proactivity: boolean;
}

export interface SettingsDashboardDto {
  catalog: ProviderCatalogEntry[];
  profiles: ProviderProfileV2[];
  route: ModelRouteConfig;
  privacy: PrivacySettingsDto;
  privacyRuntimeSupport: PrivacyRuntimeSupportDto;
  petAlwaysOnTop: boolean;
  localModel: LocalModelPublicStatus;
  authorizedRoot: PublicSettings['authorizedRoot'];
}

export interface SaveProviderProfileInput {
  profile: StoredProviderProfileV2;
  secret?: string;
  persistSecret: boolean;
}

export interface MyselfApi extends PetWindowInteractionApi {
  commitPetViewport(input: PetViewportCommitInput): Promise<void>;
  onPetGeometryRender(listener: (view: PetGeometryRenderView) => void): () => void;
  getStatus(): Promise<{ version: string; ready: boolean }>;
  getSettings(): Promise<PublicSettings>;
  saveProvider(input: SaveProviderInput): Promise<PublicSettings>;
  testProvider(): Promise<{ ok: boolean; message: string }>;
  chooseAuthorizedRoot(): Promise<PublicSettings>;
  clearLocalData(scope: LocalDataScope, profileId?: string): Promise<PublicSettings>;
  getSettingsDashboard(): Promise<SettingsDashboardDto>;
  saveProviderProfile(input: SaveProviderProfileInput): Promise<SettingsDashboardDto>;
  deleteProviderProfile(profileId: string): Promise<SettingsDashboardDto>;
  testProviderProfile(profileId: string): Promise<{ ok: boolean; message: string }>;
  saveModelRoute(route: ModelRouteConfig): Promise<SettingsDashboardDto>;
  savePrivacySettings(input: PrivacySettingsDto): Promise<SettingsDashboardDto>;
  savePetAlwaysOnTop(enabled: boolean): Promise<SettingsDashboardDto>;
  setLocalModelEnabled(enabled: boolean): Promise<SettingsDashboardDto>;
  setIncognitoSession(incognito: boolean): Promise<{ incognito: boolean }>;
  revokeAuthorizedRoot(): Promise<SettingsDashboardDto>;
  submitMessage(text: string): Promise<void>;
  cancelTask(): Promise<void>;
  confirmAction(actionId: string): Promise<void>;
  cancelAction(actionId: string): Promise<void>;
  resetConversation(): Promise<void>;
  resolveHistoryDisclosure(
    requestId: string,
    decision: HistoryDisclosureDecision
  ): Promise<void>;
  onTaskEvent(listener: (event: TaskEvent) => void): () => void;
  onLocalModelStatus(listener: (status: LocalModelPublicStatus) => void): () => void;
  listCharacters(): Promise<CharacterSummaryDto[]>;
  createCharacter(input: CharacterCreateInput): Promise<CharacterDraftV2>;
  duplicateCharacter(characterId: string): Promise<CharacterDraftV2>;
  getCharacterDraft(characterId: string): Promise<CharacterDraftV2>;
  saveCharacterDraft(
    characterId: string,
    draft: CharacterDraftV2,
    draftRevision: string
  ): Promise<void>;
  chooseCharacterSources(characterId: string): Promise<CharacterSourceChoiceResult>;
  listCharacterSources(characterId: string): Promise<CharacterWorkshopSourceDto[]>;
  readCharacterSource(characterId: string, assetId: string): Promise<Uint8Array>;
  publishCharacter(input: CharacterPublishInput): Promise<void>;
  activateCharacter(
    characterId: string,
    options?: { confirmIncomplete?: boolean }
  ): Promise<void>;
  deleteCharacter(characterId: string): Promise<void>;
  importCharacterPackage(): Promise<CharacterImportResult>;
  exportCharacterPackage(characterId: string): Promise<CharacterExportResult>;
  getCharacterRuntimeSnapshot(): Promise<CharacterRuntimeSnapshot | null>;
  getCharacterRecoverySnapshot(): Promise<CharacterRecoverySnapshotDto>;
  readCharacterRuntimeAsset(assetId: string): Promise<Uint8Array>;
  subscribeCharacterEvents(listener: (event: CharacterEvent) => void): () => void;
  getCharacterMotionSnapshot(): Promise<CharacterMotionSnapshot>;
  subscribeCharacterMotion(listener: (event: CharacterMotionEvent) => void): () => void;
  reportCharacterActionFeedback(input: CharacterActionFeedbackInput): Promise<void>;
  getCharacterBehaviorProbe?(): Promise<CharacterBehaviorProbe>;
  getCharacterMotionDeltaProbe?(): Promise<CharacterMotionDeltaProbe>;
  openChat(): Promise<void>;
  openSettings(): Promise<void>;
  openCharacterWorkshop(): Promise<void>;
  onCharacterWorkshopFlushRequested(
    listener: () => Promise<void>
  ): () => void;
  hideChat(): Promise<void>;
  quit(): Promise<void>;
}
