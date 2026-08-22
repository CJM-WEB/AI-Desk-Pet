import { createHash } from 'node:crypto';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { AgentLoop } from '@myself/agent-core';
import { FileToolService, PathPolicy } from '@myself/file-tools';
import { providerCatalog, type TaskEvent } from '@myself/shared-types';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron';
import { AgentService } from './agent/agent-service';
import { PendingActionStore } from './agent/pending-action-store';
import { createMainAgentSession } from './agent/main-agent-session-factory';
import { PowerShellTool } from './agent/powershell-tool';
import { PrivacySessionRegistry } from './agent/disclosure-policy';
import { ConversationChatAdapter } from './conversation/conversation-chat-adapter';
import { CapabilityTaskAdapter } from './conversation/capability-task-adapter';
import { ConversationEventProjection } from
  './conversation/conversation-event-projection';
import { createMainConversationComposition } from
  './conversation/main-conversation-composition';
import {
  createMainE2eExplorerBridge,
  createMainE2eExplorerLayer,
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
import {
  bindCharacterMotionWindow,
  CharacterMotionService,
  startCharacterMotionTimers
} from './characters/character-motion-service';
import { OpenAICompatibleProvider } from './providers/openai-provider';
import { ProviderRegistry } from './providers/provider-registry';
import { ipcChannels } from '../shared/ipc-channels';
import { SecretStore } from './storage/secret-store';
import { SettingsStore } from './storage/settings-store';
import { createSettingsActions } from './settings/settings-actions';
import { DesktopSettingsService } from './settings/desktop-settings-service';
import {
  createPetPositionController,
  restorePetPosition
} from './windows/pet-position';
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
let e2eRecycleAttempt = 0;

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
  let e2eStateWrite = Promise.resolve();
  const publishMainE2eState = (): Promise<void> => {
    if (!e2eBoundary || !e2eExplorer) return Promise.resolve();
    e2eStateRevision += 1;
    const state = {
      revision: e2eStateRevision,
      petWindowVisible: pet.isVisible(),
      petWindowAlwaysOnTop: pet.isAlwaysOnTop(),
      processedExplorerEventRevision,
      processedExplorerEvent,
      bridge: e2eExplorer.inspection(),
      layer: e2eExplorerLayer!.inspection()
    };
    const staged = `${e2eBoundary.mainStateFile}.tmp`;
    const write = e2eStateWrite.then(async () => {
      await writeFile(staged, `${JSON.stringify(state)}\n`, 'utf8');
      await rename(staged, e2eBoundary.mainStateFile);
    });
    e2eStateWrite = write.catch(() => undefined);
    return write;
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
    await e2eStateWrite;
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
  const characterStore = new CharacterStore(charactersDirectory);
  const characterAssetService = new CharacterAssetService(charactersDirectory);
  const characterPackageService = new CharacterPackageService(charactersDirectory, {
    store: characterStore,
    assetService: characterAssetService
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
      const snapshot = await characterActions.getCharacterRuntimeSnapshot();
      return snapshot
        ? { activeCharacterId: snapshot.activeCharacterId }
        : null;
    },
    ensureOfficialDefaultCharacter: async () => {
      try {
        await ensureOfficialDefaultCharacter(characterStore, defaultResources);
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
  const characterBehaviorSettings = await settingsStore.getCharacterBehaviorSettings();
  await restorePetLayerPreference({
    read: () => settingsStore.getPetAlwaysOnTop(),
    apply: enabled => explorerCoordinator.setPetAlwaysOnTop(enabled),
    reportError: code => console.error('恢复桌宠图层偏好失败。', code)
  });
  const providerRegistry = new ProviderRegistry(providerCatalog);
  const privacySessions = new PrivacySessionRegistry();
  const desktopSettingsService = new DesktopSettingsService({
    settings: settingsStore,
    secrets,
    providers: providerRegistry,
    privacySessions,
    sessionId: 'desktop-session',
    applyPetAlwaysOnTop: enabled => explorerCoordinator.setPetAlwaysOnTop(enabled),
    applyCharacterBehaviorSettings: snapshot => characterBehaviorDirector.applyBehaviorSettings(snapshot)
  });
  startupCleanup.add(() => desktopSettingsService.close());
  const primaryDisplay = screen.getPrimaryDisplay();
  const workAreas = [
    primaryDisplay.workArea,
    ...screen.getAllDisplays()
      .filter(display => display.id !== primaryDisplay.id)
      .map(display => display.workArea)
  ];
  const petBounds = pet.getBounds();
  // 桌宠只持久化普通桌面坐标，Explorer 图层调整不改变位置模型。
  const petPosition = restorePetPosition(
    (await settingsStore.getPublic()).petPosition,
    { width: petBounds.width, height: petBounds.height },
    workAreas
  );
  pet.setPosition(petPosition.x, petPosition.y);
  const reportPetPositionError = (error: unknown): void => {
    console.error('保存桌宠位置失败。', error);
  };
  const petPositionController = createPetPositionController({
    window: pet,
    savePosition: position => settingsStore.savePetPosition(position),
    onError: reportPetPositionError
  });
  const characterMotion = new CharacterMotionService({
    window: pet,
    getWorkAreas: () => screen.getAllDisplays().map(display => display.workArea)
  });
  const reportCharacterBehaviorError = (
    code: 'CHARACTER_BEHAVIOR_V2_UNAVAILABLE'
  ): void => {
    console.error('更新角色行为失败。', code);
  };
  const characterBehavior = new CharacterBehaviorService({
    store: characterStore,
    motion: characterMotion,
    reportError: reportCharacterBehaviorError
  });
  let publishCharacterBehaviorNotice = (_notice: CharacterBehaviorNotice): void => undefined;
  const characterBehaviorDirector = new CharacterBehaviorDirector({
    behavior: characterBehavior,
    motion: characterMotion,
    initialGeneration: 'startup',
    initialSettings: characterBehaviorSettings,
    saveMovementStopped: stopped => desktopSettingsService.saveMovementStopped(stopped),
    publishNotice: notice => publishCharacterBehaviorNotice(notice)
  });
  const characterSwitching = createCharacterActivationCoordinator({
    activateInStore: activateCharacterInStore,
    reloadBehavior: () => characterBehaviorDirector.handleActiveCharacterChanged()
  });
  characterActions.activateCharacter = (characterId, confirmIncomplete) => (
    characterSwitching.activate(characterId, confirmIncomplete)
  );
  let refreshTray = async (): Promise<void> => undefined;
  const petWindowInteraction = new PetWindowInteractionController({
    window: pet,
    screen,
    motion: {
      beginUserMove: () => {
        activeCapabilityTaskAdapter?.invalidateFileTaskPlaybackGrant();
        characterBehavior.handleUserInteraction();
        characterMotion.beginUserMove();
        characterBehaviorDirector.setDragging(true);
      },
      endUserMove: () => {
        try {
          characterMotion.endUserMove();
        } finally {
          characterBehaviorDirector.setDragging(false);
        }
      }
    }
  });
  const releasePetWindowInteraction = bindPetWindowInteractionLifecycle(
    pet,
    petWindowInteraction
  );
  const releaseMotionWindowEvents = bindCharacterMotionWindow(pet, characterMotion);
  registerCharacterMotionIpc(ipcMain, {
    getSnapshot: () => characterMotion.getSnapshot(),
    applyPlaybackFeedback: feedback => {
      characterBehaviorDirector.applyPlaybackFeedback({
        ...feedback,
        occurredAtMs: performance.now()
      });
    }
  }, pet.webContents, {
    onPlaybackStarted: (playbackToken, actionId) => (
      activeCapabilityTaskAdapter?.onPlaybackStarted(playbackToken, actionId) ?? false
    ),
    onPlaybackTerminal: (playbackToken, actionId, terminal) => (
      activeCapabilityTaskAdapter?.onPlaybackTerminal(playbackToken, actionId, terminal) ?? false
    ),
    onCommitFrame: (playbackToken, actionId, frameId) => (
      activeCapabilityTaskAdapter?.onCommitFrame(playbackToken, actionId, frameId) ?? false
    )
  });
  const releaseMotionEvents = characterMotion.subscribe(snapshot => {
    characterBehavior.handleMovement(snapshot);
    if (!pet.isDestroyed() && !pet.webContents.isDestroyed()) {
      pet.webContents.send(ipcChannels.characterMotionEvent, {
        type: 'snapshot',
        snapshot
      });
    }
  });
  const releaseBehaviorEvents = characterBehavior.subscribe(event => {
    if (!pet.isDestroyed() && !pet.webContents.isDestroyed()) {
      pet.webContents.send(ipcChannels.characterMotionEvent, event);
    }
  });
  const motionRuntime = startCharacterMotionTimers({
    tick: () => characterMotion.tick(),
    poll: () => {
      characterBehaviorDirector.handleIdleDue();
      activeCapabilityTaskAdapter?.advanceFileTaskTransaction();
    },
    isDestroyed: () => pet.isDestroyed(),
    tickIntervalMs: 50,
    idleIntervalMs: 500
  });
  const conversationClose = createDetachedCloseController({
    onError: () => console.error(
      '桌宠窗口关闭后的会话清理失败。',
      'CONVERSATION_CLOSE_INCOMPLETE'
    )
  });
  let characterRuntimeReleased = false;
  const releaseCharacterRuntime = (): void => {
    if (characterRuntimeReleased) return;
    characterRuntimeReleased = true;
    conversationClose.close();
    activeCapabilityTaskAdapter = null;
    releasePetWindowInteraction();
    motionRuntime.destroy();
    releaseMotionEvents();
    releaseBehaviorEvents();
    void characterBehaviorDirector.close();
    releaseMotionWindowEvents();
  };
  startupCleanup.add(releaseCharacterRuntime);
  pet.once('closed', releaseCharacterRuntime);
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
  const openPetContextMenu = () => tray?.popUpContextMenu(contextMenu);
  registerPetWindowInteractionIpc(
    ipcMain,
    petWindowInteraction,
    pet.webContents,
    openPetContextMenu,
    { enableE2eProbe: Boolean(e2eBoundary) }
  );
  characterActions.subscribeCharacterEvents(event => {
    if (event.type === 'active-character-changed') {
      activeCapabilityTaskAdapter?.invalidateFileTaskPlaybackGrant();
    }
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
    catalog: providerCatalog,
    privacySessions,
    sessionId,
    readProviderSettings: () => settingsStore.getProviderSettings(),
    readAuthorizedRootPath: () => settingsStore.getAuthorizedRootPath(),
    readPrivacySettings: () => settingsStore.getPrivacySettings(),
    behavior: characterBehaviorDirector,
    createChatAdapter: profile => new ConversationChatAdapter(providerRegistry.create(
      profile,
      () => secrets.readForProviderCall(profile.id)
    )),
    createAgentService: ({
      snapshot,
      generation,
      primaryProfile,
      fallbackProfiles,
      emit
    }) => {
      const loop = new AgentLoop();
      const pendingActions = new PendingActionStore({
        onDiscard: execution => loop.discard(execution.continuationToken)
      });
      return new AgentService({
        loop,
        pending: pendingActions,
        createSession: () => createMainAgentSession({
          taskKind: snapshot.taskKind,
          authorizedRootPath: snapshot.authorizedRootPath,
          generation,
          fileDisclosureAllowed: snapshot.privacySettings.dataCategories.file,
          provider: providerRegistry.create(
            primaryProfile,
            () => secrets.readForProviderCall(primaryProfile.id)
          ),
          fallbackProviders: fallbackProfiles
            .filter(fallback => fallback.hasStoredSecret)
            .map(fallback => providerRegistry.create(
              fallback,
              () => secrets.readForProviderCall(fallback.id)
            )),
          createFileTools: async () => {
            const policy = await PathPolicy.create(snapshot.authorizedRootPath);
            return new FileToolService(policy, {
              moveToRecycleBin: e2eBoundary
                ? absolutePath => moveToE2eRecycleBin(absolutePath)
                : absolutePath => shell.trashItem(absolutePath)
            });
          },
          createPowerShellTool: () => new PowerShellTool()
        }),
        emit,
        emitBehaviorIntent: intent => characterBehaviorDirector.handleAgentBehaviorIntent(intent),
        taskCarry: {
          beginTaskCarry: () => characterBehavior.beginTaskCarry(),
          endTaskCarry: () => characterBehavior.endTaskCarry()
        }
      });
    },
    emit: emitConversationEvent
  });
  const conversationCoordinator = conversationComposition.coordinator;
  activeCapabilityTaskAdapter = conversationComposition.capabilityTasks;
  conversationClose.activate(() => conversationComposition.close());
  startupCleanup.add(() => conversationComposition.close());
  const conversationIpcService = {
    submit: async (text: string): Promise<void> => {
      reportedSubmitErrorCode = null;
      await conversationCoordinator.submit(text);
    },
    hasReportedFailure: (error: unknown): boolean => (
      error instanceof Error
      && 'code' in error
      && typeof error.code === 'string'
      && error.code === reportedSubmitErrorCode
    ),
    cancelActive: () => conversationCoordinator.cancelActive(),
    resolveFileAction: (actionId: string, decision: 'confirm' | 'cancel') => (
      conversationCoordinator.resolveFileAction(actionId, decision)
    ),
    resolveHistoryDisclosure: (
      requestId: string,
      decision: 'share_once' | 'current_message_only'
    ) => conversationCoordinator.resolveHistoryDisclosure(requestId, decision),
    resetConversation: () => conversationCoordinator.resetConversation()
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
    position: petPositionController,
    services: [
      () => workshopCloseHandshake.flush(characterWorkshopWindows.getCurrent()),
      () => desktopSettingsService.close(),
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
    void conversationComposition.resetForConfigurationChange().catch(error => {
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
  await characterBehavior.initialize();
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
