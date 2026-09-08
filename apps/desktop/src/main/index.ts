import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

// Main 使用 ESM 构建，所有相邻资源继续相对实际模块目录解析。
const __dirname = import.meta.dirname;
import { ModelRouter } from '@myself/agent-core';
import {
  providerCatalog,
  type ProviderProfileV2,
  type TaskEvent
} from '@myself/shared-types';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron';

declare const __MYSELF_BUILD_IDENTITY__: Readonly<{
  commitShortHash: string;
  buildRootCategory: 'primary_checkout' | 'linked_worktree' | 'source_archive';
}>;
import { CodingTaskService } from './agent/coding-task-service';
import { resolveCodingTaskResources } from './agent/coding-task-resources';
import { createCodingModelConnection } from './providers/coding-model-connection';
import { PrivacySessionRegistry } from './agent/disclosure-policy';
import { ConversationChatAdapter } from './conversation/conversation-chat-adapter';
import { CapabilityTaskAdapter } from './conversation/capability-task-adapter';
import { ConversationEventProjection } from
  './conversation/conversation-event-projection';
import { createMainConversationComposition } from
  './conversation/main-conversation-composition';
import {
  createCoalescedAsyncPublisher,
  createMainE2eExplorerBridge,
  createMainE2eExplorerLayer,
  loadMainE2eLocalModelRuntimeOptions,
  resolveMainE2eBoundary
} from './e2e-boundary';
import {
  registerAdvancedSettingsIpc,
  registerAgentIpc,
  registerCharacterIpc,
  registerCharacterMotionIpc,
  registerPetWindowInteractionIpc,
  registerSettingsIpc,
  registerWindowIpc
} from './ipc/register-ipc';
import { CharacterActions } from './characters/character-actions';
import { CharacterAssetService } from './characters/character-asset-service';
import { CharacterBehaviorService } from './characters/character-behavior-service';
import {
  CharacterBehaviorDirector,
  type CharacterBehaviorNotice
} from './characters/character-behavior-director';
import { createCharacterProactivityRuntime, createCharacterRuntimeClock } from
  './characters/character-proactivity-runtime';
import { CharacterPackageService } from './characters/character-package-service';
import { CharacterStore } from './characters/character-store';
import { ExplorerSpaceClient, buildExplorerBridgeSpawnSpec } from
  './explorer/explorer-space-client';
import type { ExplorerSnapshot } from './explorer/explorer-space-protocol';
import { ExplorerWindowLayerController } from
  './explorer/explorer-window-layer-controller';
import { ExplorerPetLayerCoordinator } from './explorer/explorer-pet-layer-coordinator';
import {
  createExplorerMainComposition,
  restorePetLayerPreference
} from './explorer/explorer-main-wiring';
import {
  createApplicationQuitCoordinator,
  createCharacterActivationCoordinator,
  createDetachedCloseController,
  createIntegrityCheckedExplorerPort,
  createMainShutdownTransaction,
  createStartupCleanupStack,
  createTrayRefreshController
} from './lifecycle/main-lifecycle';
import { prepareCharacterStartup } from './characters/character-startup';
import { createE2eCharacterDialogAdapter } from './characters/e2e-character-dialogs';
import { ensureOfficialDefaultCharacter } from './characters/official-default-character';
import { decodeNativeImageAlpha } from './characters/native-image-alpha-decoder';
import {
  createConservativePetGeometrySnapshot,
  PetVisualGeometryAuthority
} from './characters/pet-visual-geometry';
import {
  bindCharacterMotionWindow,
  CharacterMotionService,
  startCharacterMotionTimers
} from './characters/character-motion-service';
import { OpenAICompatibleProvider } from './providers/openai-provider';
import { LocalModelProvider } from './providers/local-model-provider';
import { ProviderRegistry } from './providers/provider-registry';
import { LocalModelRuntime } from './local-model/local-model-runtime';
import { LocalModelService } from './local-model/local-model-service';
import { BUILTIN_LOCAL_PROVIDER_CATALOG_ENTRY, isBuiltinLocalProviderProfile } from './local-model/local-model-route';
import { ipcChannels } from '../shared/ipc-channels';
import {
  localModelPublicStatusSchema,
  type LocalModelPublicStatus
} from '../shared/local-model-ipc';
import { SecretStore } from './storage/secret-store';
import { SettingsStore } from './storage/settings-store';
import { createSettingsActions } from './settings/settings-actions';
import { DesktopSettingsService } from './settings/desktop-settings-service';
import { assertProviderReady } from './settings/session-preflight';
import { PetGeometryCoordinator } from './windows/pet-geometry-coordinator';
import {
  bindPetWindowInteractionLifecycle,
  createCharacterWorkshopWindow,
  createChatWindow,
  createPetWindow,
  createSettingsWindow
} from './windows/window-manager';
import { PetWindowInteractionController } from
  './windows/pet-window-interaction-controller';
import {
  broadcastCharacterEvent,
  buildApplicationTrayMenu,
  createCharacterQuickSwitchCommand,
  createLoadBeforePublishWindow,
  createPetVisibilityCommand,
  createWindowCommandController
} from './windows/window-commands';
import {
  createCharacterWorkshopCloseHandshake
} from './windows/character-workshop-close';
import { configureSingleInstance } from './single-instance';

let tray: Tray | null = null;
let isQuitting = false;
let activeCapabilityTaskAdapter: CapabilityTaskAdapter | null = null;
let primaryPetWindow: BrowserWindow | null = null;

const e2eBoundary = resolveMainE2eBoundary({
  appIsPackaged: app.isPackaged,
  env: process.env
});
if (e2eBoundary) {
  // E2E 在部分 Windows 环境中没有可用 GPU 子进程，需在 app ready 前关闭硬件加速。
  app.disableHardwareAcceleration();
  app.setPath('userData', e2eBoundary.userDataDirectory);
}
const isPrimaryInstance = configureSingleInstance(app, () => primaryPetWindow);

const EXPLORER_SPACE_RESOURCE_NAMES = [
  'explorer-space-bridge.ps1',
  'explorer-space-shell-tab-helper.cs'
] as const;

/** 生产桥只信任固定清单中的两个逐文件 SHA-256，任何缺失或多余项都失败关闭。 */
async function verifyExplorerSpaceResourceIntegrity(resourceRoot: string): Promise<void> {
  try {
    const manifestPath = join(resourceRoot, 'windows', 'explorer-space-integrity.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      version?: unknown;
      files?: unknown;
    };
    if (
      manifest.version !== 1
      || !manifest.files
      || typeof manifest.files !== 'object'
      || Array.isArray(manifest.files)
    ) throw new Error('MANIFEST_INVALID');
    const files = manifest.files as Record<string, unknown>;
    if (
      Object.keys(files).length !== EXPLORER_SPACE_RESOURCE_NAMES.length
      || !EXPLORER_SPACE_RESOURCE_NAMES.every(name => (
        typeof files[name] === 'string' && /^[a-f0-9]{64}$/u.test(files[name])
      ))
    ) throw new Error('MANIFEST_INVALID');
    for (const name of EXPLORER_SPACE_RESOURCE_NAMES) {
      const content = await readFile(join(resourceRoot, 'windows', name));
      if (createHash('sha256').update(content).digest('hex') !== files[name]) {
        throw new Error('HASH_MISMATCH');
      }
    }
  } catch {
    throw new Error('EXPLORER_SPACE_RESOURCE_INTEGRITY_FAILED');
  }
}

let e2eRecycleAttempt = 0;

/** E2E 只把目标搬入受校验的临时目录，并用空标记记录调用次数，绝不触碰系统回收站。 */
async function moveToE2eRecycleBin(absolutePath: string): Promise<void> {
  if (!e2eBoundary) throw new Error('E2E_RECYCLE_BOUNDARY_UNAVAILABLE');
  e2eRecycleAttempt += 1;
  await writeFile(
    join(e2eBoundary.recycleBinDirectory, `.attempt-${e2eRecycleAttempt}`),
    '',
    { flag: 'wx' }
  );
  try {
    await access(join(e2eBoundary.recycleBinDirectory, '.force-failure'));
    throw new Error('E2E_RECYCLE_BIN_FORCED_FAILURE');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await rename(
    absolutePath,
    join(e2eBoundary.recycleBinDirectory, `${e2eRecycleAttempt}-${basename(absolutePath)}`)
  );
}

type RendererView = 'pet' | 'chat' | 'settings' | 'characters';

function rendererUrl(view: RendererView): string | null {
  const developmentUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!developmentUrl) return null;
  const url = new URL(developmentUrl);
  url.searchParams.set('view', view);
  return url.toString();
}

async function loadRenderer(
  window: BrowserWindow,
  view: RendererView
): Promise<void> {
  const url = rendererUrl(view);
  if (url) {
    await window.loadURL(url);
    return;
  }
  await window.loadFile(join(__dirname, '../renderer/index.html'), { query: { view } });
}

function createTrayImage() {
  const image = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8ZkAAAAASUVORK5CYII='
  );
  return image.resize({ width: 16, height: 16 });
}

function positionChatNearPet(pet: BrowserWindow, chat: BrowserWindow): void {
  const petBounds = pet.getBounds();
  const chatBounds = chat.getBounds();
  const display = screen.getDisplayNearestPoint({ x: petBounds.x, y: petBounds.y });
  const workArea = display.workArea;
  const gap = 8;
  const left = petBounds.x - chatBounds.width - gap;
  const right = petBounds.x + petBounds.width + gap;
  const x = left >= workArea.x ? left : Math.min(right, workArea.x + workArea.width - chatBounds.width);
  const y = Math.min(
    Math.max(petBounds.y, workArea.y),
    workArea.y + workArea.height - chatBounds.height
  );
  chat.setPosition(x, y);
}

async function createApplicationWindows(
  startupCleanup: ReturnType<typeof createStartupCleanupStack>,
  applicationQuit: ReturnType<typeof createApplicationQuitCoordinator>
): Promise<void> {
  try {
  Menu.setApplicationMenu(null);
  const preload = join(__dirname, '../preload/index.cjs');
  const pet = createPetWindow(BrowserWindow, preload, {
    enableE2eProbe: Boolean(e2eBoundary)
  });
  primaryPetWindow = pet;
  startupCleanup.add(() => {
    if (pet.isDestroyed()) return;
    pet.hide();
    pet.destroy();
  });
  pet.once('closed', () => {
    if (primaryPetWindow === pet) primaryPetWindow = null;
  });
  let chat = createChatWindow(BrowserWindow, preload);
  let settings = createSettingsWindow(BrowserWindow, preload);
  const getCurrentChatWebContents = (): WebContents | null => {
    if (chat.isDestroyed() || chat.webContents.isDestroyed()) return null;
    return chat.webContents;
  };

  // Explorer 桥接只提供窗口事实，桌宠可见性始终由普通窗口流程管理。
  const storageDirectory = app.getPath('userData');
  const e2eExplorer = e2eBoundary
    ? createMainE2eExplorerBridge({
        eventFile: e2eBoundary.explorerEventFile
      })
    : null;
  const e2eExplorerLayer = e2eBoundary ? createMainE2eExplorerLayer() : null;
  let e2eStateRevision = 0;
  let processedExplorerEventRevision = 0;
  let processedExplorerEvent: string | null = null;
  let inspectPetGeometryForE2e = async (): Promise<object | null> => null;
  let inspectPetNativeDraggingForE2e = (): boolean => false;
  const e2eStatePublisher = createCoalescedAsyncPublisher(async () => {
    if (!e2eBoundary || !e2eExplorer) return;
    e2eStateRevision += 1;
    const revision = e2eStateRevision;
    const staged = `${e2eBoundary.mainStateFile}.tmp`;
    const state = {
      revision,
      // 构建身份由 Vite 在编译期注入，禁止从运行目录反推或公开绝对路径。
      buildIdentity: __MYSELF_BUILD_IDENTITY__,
      petWindowVisible: pet.isVisible(),
      petWindowAlwaysOnTop: pet.isAlwaysOnTop(),
      // 仅向隔离 E2E 状态文件公开数值边界，用于区分 Main 尺寸事实与 Chromium DPI 取整。
      petWindowBoundsDip: pet.getBounds(),
      petNativeDragging: inspectPetNativeDraggingForE2e(),
      processedExplorerEventRevision,
      processedExplorerEvent,
      bridge: e2eExplorer.inspection(),
      layer: e2eExplorerLayer!.inspection(),
      geometry: await inspectPetGeometryForE2e().catch(() => null)
    };
    await writeFile(staged, `${JSON.stringify(state)}\n`, 'utf8');
    await rename(staged, e2eBoundary.mainStateFile);
  });
  const publishMainE2eState = (): Promise<void> => {
    if (!e2eBoundary || !e2eExplorer) return Promise.resolve();
    return e2eStatePublisher.publish();
  };
  const completeMainE2eObservation = (observation: object): void => {
    const completed = e2eExplorer?.completeObservation(observation);
    // 并发事件按脚本序号保留最新完成证据，禁止较早的异步完成覆盖后续事件。
    if (!completed || completed.revision <= processedExplorerEventRevision) return;
    processedExplorerEventRevision = completed.revision;
    processedExplorerEvent = completed.event;
  };
  const e2eStateTimer = e2eBoundary
    ? setInterval(() => { void publishMainE2eState(); }, 20)
    : undefined;
  e2eStateTimer?.unref?.();
  startupCleanup.add(async () => {
    if (e2eStateTimer !== undefined) clearInterval(e2eStateTimer);
    await e2eStatePublisher.close();
  });
  const explorerResourceRoot = app.isPackaged
    ? process.resourcesPath
    : join(__dirname, '../../resources');
  const explorer: ExplorerSpaceClient | ReturnType<typeof createMainE2eExplorerBridge> = e2eBoundary
    ? e2eExplorer!
    : new ExplorerSpaceClient({
      spawnSpec: buildExplorerBridgeSpawnSpec({
        windowsDirectory: process.env.SystemRoot ?? 'C:\\Windows',
        resourceRoot: explorerResourceRoot,
        tempDirectory: app.getPath('temp')
      })
    });
  const explorerPort = e2eBoundary
    ? explorer
    : createIntegrityCheckedExplorerPort({
        verify: () => verifyExplorerSpaceResourceIntegrity(explorerResourceRoot),
        explorer
      });
  const explorerLayer = e2eBoundary
    ? e2eExplorerLayer!
    : new ExplorerWindowLayerController({ window: pet });
  const explorerCoordinator = new ExplorerPetLayerCoordinator({
    layer: explorerLayer,
    setAlwaysOnTop: enabled => pet.setAlwaysOnTop(enabled),
    reportError: code => console.error('调整 Explorer 图层失败。', code)
  });
  const explorerComposition = createExplorerMainComposition({
    bridge: explorerPort,
    coordinator: explorerCoordinator,
    showPet: () => pet.showInactive(),
    reportError: code => console.error('Explorer 图层桥不可用，不影响聊天、文件与 PowerShell 能力。', code)
  });
  startupCleanup.add(() => explorerComposition.close());
  explorer.on('snapshot', observation => {
    const handling = explorerComposition.onExplorerSnapshot(observation as ExplorerSnapshot);
    void handling.then(
      () => {
        completeMainE2eObservation(observation);
        return publishMainE2eState();
      },
      () => {
        console.error('处理 Explorer 观察失败。', 'EXPLORER_BRIDGE_FAILED');
      }
    );
  });
  explorer.on('error', error => {
    void explorerComposition.onExplorerError(error).then(
      () => {
        completeMainE2eObservation(error);
        return publishMainE2eState();
      },
      () => {
        console.error('处理 Explorer 观察失败。', 'EXPLORER_BRIDGE_FAILED');
      }
    );
  });
  const charactersDirectory = join(storageDirectory, 'characters');
  const geometryMigration = {
    decodeAlpha: decodeNativeImageAlpha,
    reportDiagnostic: (code: 'CHARACTER_RESOURCE_GEOMETRY_FALLBACK') => {
      console.warn(`角色视觉几何使用保守范围：${code}`);
    }
  };
  const characterStore = new CharacterStore(charactersDirectory, { geometryMigration });
  const characterAssetService = new CharacterAssetService(charactersDirectory);
  const characterPackageService = new CharacterPackageService(charactersDirectory, {
    store: characterStore,
    assetService: characterAssetService,
    geometryMigration
  });
  const characterActions = new CharacterActions({
    store: characterStore,
    assets: characterAssetService,
    packages: characterPackageService
  });
  const activateCharacterInStore = characterActions.activateCharacter.bind(characterActions);
  const recoveredCorruptCharacterIndex = await characterStore.recoverCorruptIndex();
  for (const warning of recoveredCorruptCharacterIndex.warnings) {
    console.warn(`角色索引恢复警告：${warning}`);
  }
  const packageRecoveryReport = await characterPackageService.initialize();
  const defaultResources = app.isPackaged
    ? join(app.getAppPath(), 'resources/characters/default')
    : join(__dirname, '../../resources/characters/default');
  const characterStartup = await prepareCharacterStartup({
    indexRecovered: recoveredCorruptCharacterIndex.recovered,
    packageRecoveryReport
  }, {
    validateActiveRuntime: async () => {
      const summaries = await characterActions.listCharacters();
      if (!summaries.some(character => character.active)) {
        return { kind: 'missing' } as const;
      }
      const snapshot = await characterActions.getCharacterRuntimeSnapshot();
      return snapshot
        ? { kind: 'ready', activeCharacterId: snapshot.activeCharacterId } as const
        : { kind: 'unavailable' } as const;
    },
    ensureOfficialDefaultCharacter: async () => {
      try {
        await ensureOfficialDefaultCharacter(
          characterStore,
          defaultResources,
          geometryMigration
        );
        return { activeCharacterId: 'builtin-default' };
      } catch {
        console.error('准备官方默认角色失败。', 'CHARACTER_DEFAULT_PREPARATION_FAILED');
        throw new Error('CHARACTER_DEFAULT_PREPARATION_FAILED');
      }
    },
    loadFinalIndex: () => characterStore.list(),
    getTransactionRecoveryReport: () => characterStore.getTransactionRecoveryReport()
  });
  const characterRecoverySnapshot = characterStartup.recoverySnapshot;
  if (characterRecoverySnapshot.fallbackErrorCode) {
    console.error(`角色启动恢复：${characterRecoverySnapshot.fallbackErrorCode}`);
  }
  const secrets = new SecretStore(join(storageDirectory, 'provider-secret.bin'), {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: value => safeStorage.encryptStringAsync(value),
    decryptString: async value => (await safeStorage.decryptStringAsync(value)).result
  });
  const settingsStore = new SettingsStore(
    join(storageDirectory, 'settings.json'),
    profileId => secrets.hasStoredSecret(profileId)
  );
  const localModelRuntimeOptions = e2eBoundary?.localModelFixture
    ? await loadMainE2eLocalModelRuntimeOptions(e2eBoundary.localModelFixture)
    : {
        root: app.isPackaged
          ? join(process.resourcesPath, 'local-model')
          : join(__dirname, '../../resources/local-model'),
        applicationVersion: app.getVersion(),
        cachePath: join(storageDirectory, 'local-model-validation-cache.json'),
        tokenRoot: join(app.getPath('temp'), 'ai-pet-local-model')
      };
  const localModelRuntime = new LocalModelRuntime(localModelRuntimeOptions);
  let resetLocalModelConversation: (() => Promise<void>) | null = null;
  let localModelStatus: LocalModelPublicStatus = localModelRuntime.getStatus();
  // 状态投影在 Main 完成严格校验；Renderer 永远不接触端口、令牌、路径、PID 或原始 stderr。
  const publishLocalModelStatus = (status: LocalModelPublicStatus): void => {
    localModelStatus = localModelPublicStatusSchema.parse(status);
    for (const window of [chat, settings]) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(ipcChannels.localModelStatus, localModelStatus);
      }
    }
  };
  const localModelSettings = await settingsStore.getLocalModelSettings();
  const localModelService = new LocalModelService({
    // 既有 E2E 继续使用云 Provider；只有专用本地夹具显式开启内存路由。
    initialEnabled: e2eBoundary
      ? e2eBoundary.localModelFixture !== undefined
      : localModelSettings.enabled,
    runtime: localModelRuntime,
    readCloudProviderSettings: () => settingsStore.getProviderSettings(),
    saveEnabled: enabled => settingsStore.saveLocalModelEnabled(enabled),
    resetForConfigurationChange: () => {
      if (!resetLocalModelConversation) throw new Error('LOCAL_MODEL_CONVERSATION_NOT_READY');
      return resetLocalModelConversation();
    },
    publishStatus: publishLocalModelStatus
  });
  startupCleanup.add(() => localModelService.close());
  const characterBehaviorSettings = await settingsStore.getCharacterBehaviorSettings();
  await restorePetLayerPreference({
    read: () => settingsStore.getPetAlwaysOnTop(),
    apply: enabled => explorerCoordinator.setPetAlwaysOnTop(enabled),
    reportError: code => console.error('恢复桌宠图层偏好失败。', code)
  });
  const mainProviderCatalog = [...providerCatalog, BUILTIN_LOCAL_PROVIDER_CATALOG_ENTRY];
  const providerRegistry = new ProviderRegistry(
    mainProviderCatalog,
    () => new LocalModelProvider(localModelRuntime),
    {
      // 私有诊断对象已在 Provider 边界收敛为四个非敏感字段。
      sink: diagnostic => console.warn('模型响应格式故障。', diagnostic)
    }
  );
  const createChatProvider = (profile: ProviderProfileV2) => providerRegistry.create(
    profile,
    () => secrets.readForProviderCall(profile.id)
  );
  const privacySessions = new PrivacySessionRegistry();
  const desktopSettingsService = new DesktopSettingsService({
    settings: settingsStore,
    secrets,
    providers: providerRegistry,
    privacySessions,
    sessionId: 'desktop-session',
    localModel: {
      getStatus: () => localModelStatus,
      setEnabled: enabled => localModelService.setEnabled(enabled)
    },
    applyPetAlwaysOnTop: enabled => explorerCoordinator.setPetAlwaysOnTop(enabled),
    applyCharacterBehaviorSettings: snapshot => characterBehaviorDirector.applyBehaviorSettings(snapshot),
    applyAutonomousMoodEnabled: enabled => {
      characterProactivityRuntime.noteUserInteraction();
      characterProactivityRuntime.setAutonomousMoodEnabled(enabled);
    }
  });
  startupCleanup.add(() => desktopSettingsService.close());
  const activeGeometryManifest = await characterStore.getActiveManifestV3();
  const startupPlacement = await settingsStore.getPetPlacementState(activeGeometryManifest.id);
  if (startupPlacement.kind === 'pending-legacy') {
    // pending 只在 Main 私下恢复旧窗口左上角；首次真实 viewport 成功后才 CAS 清除。
    pet.setPosition(startupPlacement.windowPosition.x, startupPlacement.windowPosition.y);
  }
  const petGeometryAuthority = new PetVisualGeometryAuthority(activeGeometryManifest.id);
  const getPetGeometrySnapshot = () => {
    const committed = petGeometryAuthority.getSnapshot();
    if (committed) return committed;
    try {
      const bounds = pet.getBounds();
      const display = screen.getDisplayNearestPoint({
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height
      });
      return createConservativePetGeometrySnapshot({
        characterId: activeGeometryManifest.id,
        windowBoundsDip: bounds,
        displayId: String(display.id)
      });
    } catch {
      return null;
    }
  };
  const characterMotion = new CharacterMotionService({
    window: pet,
    getDisplays: () => screen.getAllDisplays().map(display => ({
      id: String(display.id),
      workAreaDip: display.workArea
    })),
    getGeometrySnapshot: getPetGeometrySnapshot
  });
  inspectPetNativeDraggingForE2e = () => characterMotion.isUserMoving();
  const reportCharacterBehaviorError = (
    code: 'CHARACTER_BEHAVIOR_V3_UNAVAILABLE'
  ): void => {
    console.error('更新角色行为失败。', code);
  };
  const reportCharacterMotionTimerError = (
    code: 'CHARACTER_MOTION_TIMER_FAILED'
  ): void => {
    console.error('角色运动定时器异常，已停止。', code);
  };
  const characterRuntimeClock = createCharacterRuntimeClock();
  const characterBehavior = new CharacterBehaviorService({
    store: characterStore,
    motion: characterMotion,
    now: characterRuntimeClock.now,
    reportError: reportCharacterBehaviorError
  });
  const petGeometry = new PetGeometryCoordinator({
    window: pet,
    authority: petGeometryAuthority,
    settings: settingsStore,
    getGeometryBinding: () => characterBehavior.getGeometryBinding(),
    displays: () => screen.getAllDisplays().map(display => ({
      id: String(display.id),
      workAreaDip: display.workArea
    })),
    primaryDisplayId: () => String(screen.getPrimaryDisplay().id),
    publishRenderView: view => {
      if (!pet.isDestroyed() && !pet.webContents.isDestroyed()) {
        pet.webContents.send(ipcChannels.petGeometryRender, view);
      }
    },
    expectProgrammaticPosition: point => characterMotion.expectProgrammaticPosition(point),
    isLayoutBlocked: () => (
      characterMotion.getSnapshot().moving || characterMotion.isUserMoving()
    ),
    isUserMoving: () => characterMotion.isUserMoving()
  });
  if (e2eBoundary) {
    inspectPetGeometryForE2e = async () => {
      if (petGeometry.isLayoutInFlight()) return null;
      const relative = petGeometry.inspectRelativeGeometry();
      const snapshot = petGeometryAuthority.getSnapshot();
      if (
        !relative
        || !relative.settled
        || !snapshot
        || relative.revision !== snapshot.revision
        || pet.isDestroyed()
      ) {
        return null;
      }
      const actualBounds = pet.getBounds();
      const currentSnapshot = petGeometryAuthority.getSnapshot();
      const currentRelative = petGeometry.inspectRelativeGeometry();
      if (
        petGeometry.isLayoutInFlight()
        || !currentSnapshot
        || !currentRelative
        || !currentRelative.settled
        || currentSnapshot.characterId !== snapshot.characterId
        || currentSnapshot.revision !== snapshot.revision
        || currentRelative.revision !== relative.revision
        || currentRelative.revision !== currentSnapshot.revision
        || actualBounds.width !== currentSnapshot.windowBoundsDip.width
        || actualBounds.height !== currentSnapshot.windowBoundsDip.height
      ) return null;
      if (actualBounds.width <= 0 || actualBounds.height <= 0) return null;
      const visual = currentSnapshot.visualBoundsInWindowDip;
      const globalVisual = {
        x: actualBounds.x + visual.x,
        y: actualBounds.y + visual.y,
        width: visual.width,
        height: visual.height
      };
      const boundsEpsilonDip = 1e-6;
      const outOfBounds = !screen.getAllDisplays().some(display => (
        globalVisual.x >= display.workArea.x - boundsEpsilonDip
        && globalVisual.y >= display.workArea.y - boundsEpsilonDip
        && globalVisual.x + globalVisual.width <= display.workArea.x + display.workArea.width + boundsEpsilonDip
        && globalVisual.y + globalVisual.height <= display.workArea.y + display.workArea.height + boundsEpsilonDip
      ));
      const ratio = (value: number, size: number): number => (
        Number((value / size).toFixed(6))
      );
      return {
        revision: currentRelative.revision,
        scaleTick: currentRelative.scaleTick,
        visualBoundsInWindowRatio: {
          x: ratio(visual.x, actualBounds.width),
          y: ratio(visual.y, actualBounds.height),
          width: ratio(visual.width, actualBounds.width),
          height: ratio(visual.height, actualBounds.height)
        },
        outOfBounds
      };
    };
  }
  const persistMovedPetGeometry = (): void => {
    petGeometry.handleWindowMoved();
    // moved 的其他监听器会在本轮结束拖动；微任务随后收敛视口与持久位置。
    queueMicrotask(() => { void petGeometry.resumePendingLayout().catch(() => undefined); });
  };
  pet.on('move', persistMovedPetGeometry);
  pet.on('moved', persistMovedPetGeometry);
  startupCleanup.add(() => {
    pet.removeListener('move', persistMovedPetGeometry);
    pet.removeListener('moved', persistMovedPetGeometry);
  });
  let publishCharacterBehaviorNotice = (_notice: CharacterBehaviorNotice): void => undefined;
  const characterBehaviorDirector = new CharacterBehaviorDirector({
    now: characterRuntimeClock.now,
    behavior: characterBehavior,
    motion: characterMotion,
    initialGeneration: 'startup',
    initialSettings: characterBehaviorSettings,
    saveMovementMode: (mode, isCurrent) => desktopSettingsService.saveMovementMode(mode, isCurrent),
    publishNotice: notice => publishCharacterBehaviorNotice(notice)
  });
  const characterProactivityRuntime = createCharacterProactivityRuntime({
    director: characterBehaviorDirector,
    advanceBehavior: () => characterBehaviorDirector.advance(),
    now: characterRuntimeClock.now,
    autonomousMoodEnabled: (await settingsStore.getPrivacySettings()).autonomousMoodEnabled,
    requestAutonomousDecision: input => conversationComposition.requestAutonomousDecision(input)
  });
  // 休眠边沿只推进同一宿主时钟一次；恢复时不补发动画或模型调用队列。
  const suspendCharacterRuntime = () => { characterRuntimeClock.suspend(); characterProactivityRuntime.suspend(); };
  const resumeCharacterRuntime = () => { characterRuntimeClock.resume(); characterProactivityRuntime.resume(); };
  powerMonitor.on('suspend', suspendCharacterRuntime);
  powerMonitor.on('resume', resumeCharacterRuntime);
  const releaseCharacterClockEvents = () => {
    powerMonitor.removeListener('suspend', suspendCharacterRuntime);
    powerMonitor.removeListener('resume', resumeCharacterRuntime);
  };
  startupCleanup.add(releaseCharacterClockEvents);
  // 组合创建后立即进入启动清理栈；Service 初始化前 Scheduler 尚未 start。
  startupCleanup.add(() => characterProactivityRuntime.close());
  const characterSwitching = createCharacterActivationCoordinator({
    activateInStore: activateCharacterInStore,
    reloadBehavior: () => characterBehaviorDirector.handleActiveCharacterChanged()
  });
  characterActions.activateCharacter = (characterId, confirmIncomplete) => {
    characterProactivityRuntime.noteUserInteraction();
    return characterSwitching.activate(characterId, confirmIncomplete);
  };
  let refreshTray = async (): Promise<void> => undefined;
  // 命中角色的按下即沿 petDragBegin 到达此处，未移动的真实点击也算互动；两种拖拽来源按边沿去重。
  const notePetInteraction = () => {
    if (characterBehaviorDirector.getActivityBlockers().dragging) return;
    characterProactivityRuntime.noteUserInteraction();
    characterBehavior.handleUserInteraction();
    characterBehaviorDirector.setDragging(true);
  };
  const petWindowInteraction = new PetWindowInteractionController({
    window: pet,
    getCursorScreenPoint: () => screen.getCursorScreenPoint(),
    onDragStarted: () => {
      characterMotion.beginUserMove(undefined, 'controller');
      notePetInteraction();
    },
    onDragEnded: () => {
      characterMotion.endUserMove('controller');
      characterBehaviorDirector.setDragging(false);
      void petGeometry.resumePendingLayout().catch(() => undefined);
    }
  });
  const releasePetWindowInteraction = bindPetWindowInteractionLifecycle(
    pet,
    petWindowInteraction
  );
  const releaseMotionWindowEvents = bindCharacterMotionWindow(pet, characterMotion, {
    onUserMoveStarted: () => {
      notePetInteraction();
    },
    onUserMoveEnded: () => {
      characterBehaviorDirector.setDragging(false);
      void petGeometry.resumePendingLayout().catch(() => undefined);
    }
  });
  registerCharacterMotionIpc(ipcMain, {
    getSnapshot: () => characterMotion.getSnapshot(),
    applyPlaybackFeedback: feedback => {
      characterBehaviorDirector.applyPlaybackFeedback({
        ...feedback,
        occurredAtMs: characterRuntimeClock.now()
      });
    }
  }, pet.webContents);
  const releaseMotionEvents = characterMotion.subscribe(snapshot => {
    characterBehavior.handleMovement(snapshot);
    // 方向可能在 moving 布尔不变时改变；几何 binding 仍须进入 Main FIFO。
    void petGeometry.refreshBinding().catch(() => undefined);
    characterBehaviorDirector.handleMotionSnapshot(snapshot);
    if (!pet.isDestroyed() && !pet.webContents.isDestroyed()) {
      pet.webContents.send(ipcChannels.characterMotionEvent, {
        type: 'snapshot',
        snapshot
      });
    }
  });
  const releaseBehaviorEvents = characterBehavior.subscribe(event => {
    void petGeometry.refreshBinding().catch(() => undefined);
    if (!pet.isDestroyed() && !pet.webContents.isDestroyed()) {
      pet.webContents.send(ipcChannels.characterMotionEvent, event);
    }
  });
  const motionRuntime = startCharacterMotionTimers({
    tick: () => {
      if (petGeometry.isLayoutInFlight()) return;
      const snapshot = characterMotion.tick();
      if (!snapshot.moving) {
        void petGeometry.resumePendingLayout().catch(() => undefined);
      }
    },
    poll: () => characterProactivityRuntime.poll(),
    isDestroyed: () => pet.isDestroyed(),
    tickIntervalMs: 50,
    idleIntervalMs: 500,
    reportError: reportCharacterMotionTimerError
  });
  const conversationClose = createDetachedCloseController({
    onError: () => console.error(
      '桌宠窗口关闭后的会话清理失败。',
      'CONVERSATION_CLOSE_INCOMPLETE'
    )
  });
  let characterRuntimeReleased = false;
  const releaseCharacterRuntime = async (): Promise<void> => {
    if (characterRuntimeReleased) return;
    characterRuntimeReleased = true;
    conversationClose.close();
    activeCapabilityTaskAdapter = null;
    releasePetWindowInteraction();
    motionRuntime.destroy();
    releaseMotionEvents();
    releaseBehaviorEvents();
    releaseCharacterClockEvents();
    await characterProactivityRuntime.close();
    await characterBehaviorDirector.close();
    releaseMotionWindowEvents();
  };
  startupCleanup.add(releaseCharacterRuntime);
  pet.once('closed', () => { void releaseCharacterRuntime(); });
  const hideOnClose = (window: BrowserWindow): void => {
    window.on('close', event => {
      if (isQuitting) return;
      event.preventDefault();
      window.hide();
    });
  };
  hideOnClose(chat);
  hideOnClose(settings);

  const reportCharacterWorkshopFlushError = (error: unknown): void => {
    console.error('角色工作室关闭前保存失败。', error);
  };
  const workshopCloseHandshake = createCharacterWorkshopCloseHandshake({
    ipcMain,
    requestChannel: ipcChannels.characterWorkshopFlushRequest,
    acknowledgementChannel: ipcChannels.characterWorkshopFlushAcknowledgement,
    reportError: reportCharacterWorkshopFlushError
  });
  const characterWorkshopWindows = createLoadBeforePublishWindow({
    create: () => createCharacterWorkshopWindow(BrowserWindow, preload),
    prepare: window => workshopCloseHandshake.bindWindow(window, () => isQuitting),
    load: window => loadRenderer(window, 'characters')
  });
  const quitApplication = (): void => app.quit();
  const e2eCharacterDialogs = e2eBoundary
    ? createE2eCharacterDialogAdapter(e2eBoundary)
    : null;

  const ensureChatWindow = async (): Promise<BrowserWindow> => {
    if (!chat.isDestroyed()) return chat;
    chat = createChatWindow(BrowserWindow, preload);
    hideOnClose(chat);
    await loadRenderer(chat, 'chat');
    return chat;
  };
  const ensureSettingsWindow = async (): Promise<BrowserWindow> => {
    if (!settings.isDestroyed()) return settings;
    settings = createSettingsWindow(BrowserWindow, preload);
    hideOnClose(settings);
    await loadRenderer(settings, 'settings');
    return settings;
  };
  const ensureCharacterWorkshopWindow = characterWorkshopWindows.ensure;
  const windowCommands = createWindowCommandController({
    getChatWindow: () => chat,
    ensureChatWindow,
    positionChat: chatWindow => positionChatNearPet(pet, chatWindow),
    ensureCharacterWorkshopWindow
  });
  const togglePetVisibility = createPetVisibilityCommand({
    isDestroyed: () => pet.isDestroyed(),
    isVisible: () => pet.isVisible(),
    hide: () => pet.hide(),
    show: () => pet.showInactive()
  });
  const showSettings = async (): Promise<void> => {
    const settingsWindow = await ensureSettingsWindow();
    settingsWindow.show();
    settingsWindow.focus();
  };
  const reportCharacterUiError = (error: unknown): void => {
    console.error('更新角色界面失败。', error);
  };
  const buildContextMenu = async (): Promise<Menu> => {
    const installedCharacters = await characterActions.listCharacters().catch(() => []);
    const quickSwitchItems: MenuItemConstructorOptions[] = installedCharacters.map(
      character => ({
        label: character.name,
        type: 'radio',
        checked: character.active,
        click: createCharacterQuickSwitchCommand(
          character.id,
          id => characterActions.activateCharacter(id),
          reportCharacterUiError
        )
      })
    );
    return Menu.buildFromTemplate(buildApplicationTrayMenu({
      togglePetVisibility,
      openChat: () => void windowCommands.showChat(),
      openCharacterWorkshop: () => void windowCommands.showCharacterWorkshop(),
      quickSwitchItems,
      openSettings: () => void showSettings(),
      quit: () => void quitApplication()
    }));
  };
  let contextMenu = await buildContextMenu();

  tray = new Tray(createTrayImage());
  tray.setToolTip('AI Pet 桌宠');
  tray.setContextMenu(contextMenu);
  const trayRefreshController = createTrayRefreshController({
    build: buildContextMenu,
    publish: menu => {
      contextMenu = menu;
      tray?.setContextMenu(menu);
    }
  });
  refreshTray = () => trayRefreshController.refresh();
  tray.on('double-click', () => void windowCommands.showChat());
  const openPetContextMenu = (): void => {
    tray?.popUpContextMenu(contextMenu);
  };
  pet.webContents.on('context-menu', openPetContextMenu);
  startupCleanup.add(() => {
    pet.webContents.removeListener('context-menu', openPetContextMenu);
  });
  registerPetWindowInteractionIpc(
    ipcMain,
    petWindowInteraction,
    pet.webContents,
    {
      enableE2eProbe: Boolean(e2eBoundary),
      geometry: {
        commitViewport: input => petGeometry.commitViewport(input)
      }
    }
  );
  characterActions.subscribeCharacterEvents(event => {
    broadcastCharacterEvent(
      [pet, chat, settings, characterWorkshopWindows.getCurrent()],
      ipcChannels.characterEvent,
      event
    );
    void refreshTray().catch(reportCharacterUiError);
  });

  registerWindowIpc(ipcMain, app.getVersion(), {
    openChat: windowCommands.showChat,
    openSettings: showSettings,
    openCharacterWorkshop: windowCommands.showCharacterWorkshop,
    hideChat: windowCommands.hideChat,
    quit: () => void quitApplication()
  });
  registerCharacterIpc(ipcMain, characterActions, {
    chooseCharacterSources: async () => {
      const owner = await ensureCharacterWorkshopWindow();
      return e2eCharacterDialogs
        ? e2eCharacterDialogs.chooseSources()
        : dialog.showOpenDialog(owner, {
        title: '选择角色源图片',
        properties: ['openFile', 'multiSelections'],
        filters: [{
          name: '角色图片',
          extensions: ['png', 'webp']
        }]
      });
    },
    chooseCharacterPackage: async () => {
      const owner = await ensureCharacterWorkshopWindow();
      return e2eCharacterDialogs
        ? e2eCharacterDialogs.choosePackage()
        : dialog.showOpenDialog(owner, {
        title: '导入角色包',
        properties: ['openFile'],
        filters: [{
          name: 'AI Pet 角色包',
          extensions: ['zip']
        }]
      });
    },
    chooseCharacterExportDestination: async characterId => {
      const owner = await ensureCharacterWorkshopWindow();
      return e2eCharacterDialogs
        ? e2eCharacterDialogs.chooseExportDestination()
        : dialog.showSaveDialog(owner, {
        title: '导出角色包',
        defaultPath: `${characterId}.zip`,
        filters: [{
          name: 'AI Pet 角色包',
          extensions: ['zip']
        }]
      });
    }
  }, characterRecoverySnapshot);

  const sessionId = 'desktop-session';
  privacySessions.register(sessionId, { incognito: false });
  let reportedSubmitErrorCode: string | null = null;
  const conversationEventProjection = new ConversationEventProjection({
    getChatTarget: getCurrentChatWebContents,
    getPetTarget: () => (
      pet.isDestroyed() || pet.webContents.isDestroyed() ? null : pet.webContents
    ),
    behavior: characterBehaviorDirector,
    reportDeliveryFailure: target => console.error(
      '投递会话公开事件失败。',
      target === 'chat'
        ? 'CHAT_TASK_EVENT_DELIVERY_FAILED'
        : 'PET_TASK_EVENT_DELIVERY_FAILED'
    )
  });
  const emitConversationEvent = (event: TaskEvent): void => {
    const validated = conversationEventProjection.publish(event);
    if (validated.type === 'error') reportedSubmitErrorCode = validated.code;
  };
  publishCharacterBehaviorNotice = notice => emitConversationEvent({
    type: 'error',
    code: notice.code,
    message: notice.message
  });
  const conversationComposition = createMainConversationComposition({
    autonomy: characterBehaviorDirector,
    catalog: mainProviderCatalog,
    privacySessions,
    sessionId,
    readProviderSettings: () => localModelService.providerSettingsSnapshot(),
    assertProviderReady: profile => assertProviderReady(profile, localModelStatus),
    readAuthorizedRootPath: () => settingsStore.getAuthorizedRootPath(),
    readPrivacySettings: () => settingsStore.getPrivacySettings(),
    behavior: characterBehaviorDirector,
    createChatAdapter: profile => new ConversationChatAdapter(
      createChatProvider(profile),
      (error, correlationId) => providerRegistry.reportResponseError(
        profile,
        error,
        correlationId
      ),
      { inputByteBudget: isBuiltinLocalProviderProfile(profile) ? 19_200 : 64 * 1024 }
    ),
    createCodingTaskService: ({ snapshot, primaryProfile, emit, emitTrustedToolResult }) => new CodingTaskService({
      sessionOptions: async () => {
        const dataDirectory = join(app.getPath('userData'), 'coding-tasks');
        await mkdir(dataDirectory, { recursive: true });
        return {
          directory: snapshot.authorizedRootPath, dataDirectory,
          approvedCommands: snapshot.approvedCommands,
          model: createCodingModelConnection(primaryProfile, {
            catalog: mainProviderCatalog,
            readSecret: () => secrets.readForProviderCall(primaryProfile.id),
            localModel: localModelRuntime
          }),
          ...await resolveCodingTaskResources({ appPath: app.isPackaged ? app.getAppPath() : join(__dirname, '../..'), isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }),
          trashFile: absolutePath => e2eBoundary
            ? moveToE2eRecycleBin(absolutePath)
            : shell.trashItem(absolutePath)
        };
      },
      emit, emitTrustedToolResult
    }),
    emit: emitConversationEvent
  });
  const conversationCoordinator = conversationComposition.coordinator;
  activeCapabilityTaskAdapter = conversationComposition.capabilityTasks;
  conversationClose.activate(() => conversationComposition.close());
  startupCleanup.add(() => conversationComposition.close());
  resetLocalModelConversation = async () => {
    characterProactivityRuntime.invalidate();
    characterProactivityRuntime.setAutonomousMoodEnabled((await settingsStore.getPrivacySettings()).autonomousMoodEnabled);
    await conversationComposition.resetForConfigurationChange();
  };
  const conversationIpcService = {
    submit: async (text: string): Promise<void> => {
      reportedSubmitErrorCode = null;
      characterProactivityRuntime.noteUserInteraction();
      await conversationCoordinator.submit(text);
    },
    hasReportedFailure: (error: unknown): boolean => (
      error instanceof Error
      && 'code' in error
      && typeof error.code === 'string'
      && error.code === reportedSubmitErrorCode
    ),
    cancelActive: () => { characterProactivityRuntime.noteUserInteraction(); return conversationCoordinator.cancelActive(); },
    resolveFileAction: (actionId: string, decision: 'confirm' | 'cancel') => {
      characterProactivityRuntime.noteUserInteraction();
      return conversationCoordinator.resolveFileAction(actionId, decision);
    },
    resolveHistoryDisclosure: (
      requestId: string,
      decision: 'share_once' | 'current_message_only'
    ) => {
      characterProactivityRuntime.noteUserInteraction();
      return conversationCoordinator.resolveHistoryDisclosure(requestId, decision);
    },
    resolveCapabilityAuthorization: (
      requestId: string,
      decision: 'confirm' | 'cancel'
    ) => {
      characterProactivityRuntime.noteUserInteraction();
      return conversationCoordinator.resolveCapabilityAuthorization(requestId, decision);
    },
    resetConversation: () => {
      characterProactivityRuntime.noteUserInteraction();
      characterProactivityRuntime.invalidate();
      return conversationCoordinator.resetConversation();
    }
  };
  registerAgentIpc(ipcMain, conversationIpcService, getCurrentChatWebContents);

  const shutdownApplication = createMainShutdownTransaction({
    beforeExplorerClose: async () => {
      const failures: unknown[] = [];
      // 会话必须最先封闭；失败时仍继续冲刷既有设置，避免阻断后续关闭事务。
      try {
        await conversationComposition.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await desktopSettingsService.freezeAndFlushPetAlwaysOnTop();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'CONVERSATION_SHUTDOWN_INCOMPLETE');
      }
    },
    coordinator: explorerCoordinator,
    bridge: explorerPort,
    position: petGeometry,
    services: [
      async () => { await workshopCloseHandshake.flush(characterWorkshopWindows.getCurrent()); },
      () => desktopSettingsService.close(),
      () => localModelService.close(),
      releaseCharacterRuntime
    ]
  });
  const settingsActions = createSettingsActions({
    settings: settingsStore,
    readSecret: () => secrets.readForProviderCall(),
    createProvider: (profile, readSecret) => new OpenAICompatibleProvider(profile, readSecret),
    selectDirectory: async () => {
      const owner = await ensureSettingsWindow();
      // E2E 仅替代 Main 内部目录选择的成功结果，Renderer 仍走正式白名单 API。
      const result = e2eBoundary
        ? { canceled: false, filePaths: [e2eBoundary.authorizedRootDirectory] }
        : await dialog.showOpenDialog(owner, {
          title: '选择 AI Pet 可以访问的工作目录',
          properties: ['openDirectory']
        });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }
  });
  const resetForConfigurationChange = (): void => {
    void resetLocalModelConversation?.().catch(error => {
      const code = error instanceof Error && 'code' in error ? error.code : 'UNKNOWN';
      console.error('配置变更后的会话清理失败。', code);
    });
  };
  registerSettingsIpc(ipcMain, settingsStore, secrets, {
    onProviderChanged: resetForConfigurationChange,
    onAuthorizedRootChanged: resetForConfigurationChange
  }, settingsActions);
  registerAdvancedSettingsIpc(ipcMain, desktopSettingsService, {
    onConfigurationChanged: resetForConfigurationChange
  });

  await Promise.all([
    loadRenderer(pet, 'pet'),
    loadRenderer(chat, 'chat'),
    loadRenderer(settings, 'settings'),
    ensureCharacterWorkshopWindow()
  ]);
  void localModelService.start().catch(error => {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'LOCAL_MODEL_START_FAILED';
    console.error('内置本地模型后台启动失败。', code);
  });
  await characterBehavior.initialize();
  await petGeometry.initialize();
  characterProactivityRuntime.start();
  await explorerComposition.start();
  if (!applicationQuit.activateNormal(shutdownApplication)) return;
  startupCleanup.dismiss();
  } finally {
    startupCleanup.seal();
  }
}

app.on('window-all-closed', () => {});

if (isPrimaryInstance) {
  const startupCleanup = createStartupCleanupStack();
  const applicationQuit = createApplicationQuitCoordinator({
    cleanupBootstrap: () => startupCleanup.run(),
    quit: () => app.quit(),
    onError: () => console.error('应用关闭失败。', 'APPLICATION_SHUTDOWN_INCOMPLETE')
  });
  // 首个窗口资源创建前即接管退出；成功启动后同一入口原子切换到完整关闭事务。
  app.on('before-quit', event => {
    isQuitting = true;
    void applicationQuit.handle(event);
  });
  void app.whenReady().then(async () => {
    await createApplicationWindows(startupCleanup, applicationQuit);
  }).catch(error => {
    primaryPetWindow?.hide();
    if (!applicationQuit.quitRequested()) console.error('应用启动失败。', error);
    void applicationQuit.exitAfterStartupFailure();
  });
}
