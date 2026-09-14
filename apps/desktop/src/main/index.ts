import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

// Main 使用 ESM 构建，所有相邻资源继续相对实际模块目录解析。
const __dirname = import.meta.dirname;
import { ModelRouter } from '@myself/agent-core';
import {
  providerCatalog,
  taskEventSchema,
  type ProviderProfileV2,
  type TaskEvent
} from '@myself/shared-types';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type MouseInputEvent,
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
import { ConversationSessionStore } from './conversation/conversation-session-store';
import { ModelChangeCoordinator, conversationModelIdentity, type ModelConfiguration } from './settings/model-change-coordinator';
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
import { ensureOfficialDefaultCharacter, ensureOfficialDefaultCharacterInstalled } from './characters/official-default-character';
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
  createBubbleWindow,
  createPetWindow,
  createSettingsWindow,
  setPetWindowPosition
} from './windows/window-manager';
import { ChatPresentationBridge, registerChatPresentationIpc } from './windows/chat-presentation-bridge';
import { waitForRendererReady } from './windows/renderer-ready';
import { ChatPresentationWindowController } from './windows/chat-presentation-windows';
import { createChatPointerObserver } from './windows/chat-native-pointer';
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

type RendererView = 'pet' | 'chat' | 'bubble' | 'settings' | 'characters';

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
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'), { query: { view } });
  }
  // 页面导航成功后继续等待首个视图提交，按需加载完成前不显示空窗口。
  await waitForRendererReady(window.webContents);
}

async function createApplicationWindows(
  startupCleanup: ReturnType<typeof createStartupCleanupStack>,
  applicationQuit: ReturnType<typeof createApplicationQuitCoordinator>
): Promise<void> {
  try {
  Menu.setApplicationMenu(null);
  // 窗口与托盘共用多尺寸官方图标，开发和安装版均从固定应用资源读取。
  const applicationIcon = join(app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'), 'icon.ico');
  app.on('browser-window-created', (_event, window) => window.setIcon(applicationIcon));
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
  startupCleanup.add(() => { if (!chat.isDestroyed()) chat.destroy(); });
  // 设置首次打开才创建；加载事务复用同一候选，隐藏后保留未提交字段。
  const settingsWindows = createLoadBeforePublishWindow<BrowserWindow>({
    create: () => {
      const candidate = createSettingsWindow(BrowserWindow, preload);
      startupCleanup.add(() => { if (!candidate.isDestroyed()) candidate.destroy(); });
      return candidate;
    },
    prepare: window => hideOnClose(window),
    load: window => loadRenderer(window, 'settings')
  });
  const getCurrentChatWebContents = (): WebContents | null => {
    if (chat.isDestroyed() || chat.webContents.isDestroyed()) return null;
    return chat.webContents;
  };

  // 原聊天仍是唯一业务 owner；气泡仅展示，历史直接复用透明聊天内容层。
  let bubble = createBubbleWindow(BrowserWindow, preload);
  // 每个原生资源创建后立即登记，后续构造/IPC注册失败也不会遗留窗口。
  startupCleanup.add(() => { if (!bubble.isDestroyed()) bubble.destroy(); });
  let presentation!: ChatPresentationWindowController;
  let presentationTimer: ReturnType<typeof setInterval> | undefined;
  let presentationClosing = false;
  let presentationClose: Promise<void> | null = null;
  const presentationReleases: (() => void)[] = [];
  const presentationBridge = new ChatPresentationBridge({
    getChat: getCurrentChatWebContents,
    getBubble: () => bubble.isDestroyed() || bubble.webContents.isDestroyed() ? null : bubble.webContents,
    onReady: surface => presentation.markReady(surface),
    onLayout: layout => presentation.setLayout(layout)
  });
  const pointerObserver = createChatPointerObserver({
    resourceRoot: app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'),
    onPointerDown: point => presentation.onPointerDown(point),
    onFailure: () => presentation.onPointerFailure()
  });
  presentation = new ChatPresentationWindowController({
    getChat: () => chat,
    getBubble: () => bubble,
    getPetVisible: () => !pet.isDestroyed() && pet.isVisible(),
    getCursorScreenPoint: () => screen.getCursorScreenPoint(),
    getDisplayNearestPoint: point => screen.getDisplayNearestPoint(point),
    screenToDipPoint: point => screen.screenToDipPoint(point),
    sendCommand: command => presentationBridge.sendCommand(command),
    sendBubbleCommand: command => presentationBridge.sendCommand(command, 'bubble'),
    onBubbleUnavailable: () => { bubbleCrashed = true; presentationBridge.invalidateBubble(); },
    pointer: pointerObserver
  });
  const releasePresentationIpc = registerChatPresentationIpc(ipcMain, presentationBridge);
  const closePresentation = (): Promise<void> => {
    if (presentationClose) return presentationClose;
    presentationClosing = true;
    clearInterval(presentationTimer);
    for (const release of presentationReleases.splice(0)) release();
    releasePresentationIpc(); presentationBridge.dispose();
    presentationClose = presentation.dispose().finally(() => {
      if (!bubble.isDestroyed()) bubble.destroy();
    });
    return presentationClose;
  };
  startupCleanup.add(closePresentation);

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
  // 先恢复可能中断的内置安装，其他角色写入必须在旧事务恢复后才能开放。
  await characterStore.installOfficialDefaultCharacter();
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
  try {
    await ensureOfficialDefaultCharacterInstalled(characterStore, defaultResources);
  } catch {
    // 默认升级失败仍允许当前健康角色启动，失败材料由安装恢复模块保留。
    console.warn('默认角色升级未完成，保留当前可用角色。', 'CHARACTER_DEFAULT_UPGRADE_FAILED');
  }
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
  const localEncryption = {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (value: string) => safeStorage.encryptStringAsync(value),
    decryptString: async (value: Buffer) => (await safeStorage.decryptStringAsync(value)).result
  };
  const secrets = new SecretStore(join(storageDirectory, 'provider-secret.bin'), localEncryption);
  const conversationSession = new ConversationSessionStore(
    join(storageDirectory, 'current-conversation.bin'), localEncryption, {
      onPersistenceChanged: () => {
        // 只更新聊天快照中的保存提示，不投递任务失败、不撤销确认卡，也不把错误再写入自身。
        const target = getCurrentChatWebContents();
        if (target && !target.isDestroyed()) {
          target.send(ipcChannels.conversationSnapshot, conversationSession.snapshot());
        }
      }
    }
  );
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
  let startNewConversation: (() => Promise<void>) | null = null;
  let newConversationPromise: Promise<void> | null = null;
  let shuttingDown = false;
  const readModelConfiguration = async (): Promise<ModelConfiguration> => ({
    ...await settingsStore.getProviderSettings(),
    localModelEnabled: localModelService.isEnabled()
  });
  const modelChanges = new ModelChangeCoordinator({
    readConfiguration: readModelConfiguration,
    confirmModelChange: async signal => {
      if (shuttingDown) return false;
      const result = await dialog.showMessageBox(await ensureSettingsWindow(), {
        type: 'question', title: '切换模型', message: '确定切换模型吗？',
        detail: '切换模型会开启新对话，当前聊天内容将被清空。',
        buttons: ['取消', '切换模型'], defaultId: 0, cancelId: 0, noLink: true, signal
      });
      return !shuttingDown && result.response === 1;
    },
    invalidateConfiguration: async () => {
      if (shuttingDown || !resetLocalModelConversation) throw new Error('CONVERSATION_CLOSED');
      await newConversationPromise;
      await resetLocalModelConversation();
    },
    onModelChanged: async () => {
      if (!startNewConversation) throw new Error('CONVERSATION_NOT_READY');
      await startNewConversation();
    }
  });
  let localModelStatus: LocalModelPublicStatus = localModelRuntime.getStatus();
  // 状态投影在 Main 完成严格校验；Renderer 永远不接触端口、令牌、路径、PID 或原始 stderr。
  const publishLocalModelStatus = (status: LocalModelPublicStatus): void => {
    localModelStatus = localModelPublicStatusSchema.parse(status);
    for (const window of [chat, settingsWindows.getCurrent()]) {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
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
    modelChanges,
    publishStatus: publishLocalModelStatus
  });
  startupCleanup.add(() => localModelService.close());
  await conversationSession.initialize(conversationModelIdentity(await readModelConfiguration()));
  startupCleanup.add(() => conversationSession.flush());
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
    modelChanges,
    onIncognitoChanged: enabled => conversationSession.setIncognito(enabled),
    localModel: {
      getStatus: () => localModelStatus,
      setEnabled: enabled => localModelService.setEnabled(enabled)
    },
    applyPetAlwaysOnTop: enabled => explorerCoordinator.setPetAlwaysOnTop(enabled),
    applyCharacterBehaviorSettings: snapshot => characterBehaviorDirector.applyBehaviorSettings(snapshot),
    applyAutonomousMoodEnabled: enabled => {
      characterProactivityRuntime.noteUserInteraction();
      characterBehaviorDirector.noteUserInteraction('control');
      characterProactivityRuntime.setAutonomousMoodEnabled(enabled);
    }
  });
  startupCleanup.add(() => desktopSettingsService.close());
  const activeGeometryManifest = await characterStore.getActiveManifestV3();
  const startupPlacement = await settingsStore.getPetPlacementState(activeGeometryManifest.id);
  if (startupPlacement.kind === 'pending-legacy') {
    // pending 只在 Main 私下恢复旧窗口左上角；首次真实 viewport 成功后才 CAS 清除。
    setPetWindowPosition(pet, startupPlacement.windowPosition);
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
    window: {
      getBounds: () => pet.getBounds(),
      setPosition: (x, y) => setPetWindowPosition(pet, { x, y })
    },
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
  // 窗口先完成加载以接收播放事件；首次输入等待角色目录就绪，避免大素材启动时拿到空候选。
  let finishCharacterInitialization!: () => void;
  const characterInitialized = new Promise<void>(resolve => { finishCharacterInitialization = resolve; });
  startupCleanup.add(() => finishCharacterInitialization());
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
    ready: characterInitialized,
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
    characterBehaviorDirector.noteUserInteraction('control');
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
    // 到达先让持续模式接续真实目标，避免中间的 moving=false 先把同一行走动画撤成待机。
    // 续行可能同步发布更新快照；后续表现和广播一律读取 Motion 的最新事实。
    if (!snapshot.moving) characterBehaviorDirector.handleMotionSnapshot(snapshot);
    const current = characterMotion.getSnapshot();
    characterBehavior.handleMovement(current);
    // 方向可能在 moving 布尔不变时改变；几何 binding 仍须进入 Main FIFO。
    void petGeometry.refreshBinding().catch(() => undefined);
    if (current.moving) characterBehaviorDirector.handleMotionSnapshot(current);
    if (!pet.isDestroyed() && !pet.webContents.isDestroyed()) {
      pet.webContents.send(ipcChannels.characterMotionEvent, {
        type: 'snapshot',
        snapshot: current
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
    // 真实窗口统一按绘制级节拍推进，连续积分只在原生边界取整。
    tickIntervalMs: 1_000 / 60,
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
  const hideOnClose = (window: BrowserWindow, requestHide: () => void = () => window.hide()): void => {
    window.on('close', event => {
      if (isQuitting) return;
      event.preventDefault();
        requestHide();
    });
  };
  hideOnClose(chat, () => presentation.requestClose());

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
    create: () => {
      const candidate = createCharacterWorkshopWindow(BrowserWindow, preload);
      startupCleanup.add(() => { if (!candidate.isDestroyed()) candidate.destroy(); });
      return candidate;
    },
    prepare: window => workshopCloseHandshake.bindWindow(window, () => isQuitting),
    load: window => loadRenderer(window, 'characters')
  });
  const quitApplication = (): void => app.quit();
  const e2eCharacterDialogs = e2eBoundary
    ? createE2eCharacterDialogAdapter(e2eBoundary)
    : null;

  let chatLoaded = false;
  let chatCrashed = false;
  let chatLoading: Promise<BrowserWindow> | null = null;
  let bubbleLoaded = false;
  let bubbleCrashed = false;
  let bubbleLoading: Promise<BrowserWindow> | null = null;
  const bindPresentationWindow = (window: BrowserWindow, surface: 'island' | 'bubble'): void => {
    const mouse = (_event: Electron.Event, input: MouseInputEvent): void => {
      if (presentationClosing || window !== (surface === 'island' ? chat : bubble)) return;
      try { presentation.onMouseEvent(surface, input); }
      catch { console.error('更新聊天窗口穿透失败。', 'CHAT_PRESENTATION_UNAVAILABLE'); }
    };
    const failed = (): void => {
      if (presentationClosing || window !== (surface === 'island' ? chat : bubble)) return;
      presentation.markUnavailable(surface);
      if (surface === 'island') chatCrashed = true; else bubbleCrashed = true;
      // 展示窗口故障仅打开原聊天回退入口，不批准、清空或取消原任务。
      void ensureChatWindow().then(() => presentation.requestOpen()).catch(() => {
        console.error('聊天窗口暂不可用。', 'CHAT_PRESENTATION_UNAVAILABLE');
      });
    };
    const loading = (): void => {
      if (presentationClosing || window !== (surface === 'island' ? chat : bubble)) return;
      if (surface === 'island') { presentationBridge.clear(); presentation.clear(); }
      presentation.markUnavailable(surface);
    };
    window.on('closed', failed);
    window.webContents.on('render-process-gone', failed);
    window.webContents.on('did-start-loading', loading);
    window.webContents.on('before-mouse-event', mouse);
    presentationReleases.push(() => {
      window.removeListener('closed', failed);
      window.webContents.removeListener('render-process-gone', failed);
      window.webContents.removeListener('did-start-loading', loading);
      window.webContents.removeListener('before-mouse-event', mouse);
    });
  };
  const ensureChatWindow = (): Promise<BrowserWindow> => {
    if (chatLoading) return chatLoading;
    if (!chat.isDestroyed() && chatLoaded && !chatCrashed) return Promise.resolve(chat);
    if (chat.isDestroyed() || chatCrashed) {
      const old = chat;
      chat = createChatWindow(BrowserWindow, preload);
      hideOnClose(chat, () => presentation.requestClose());
      bindPresentationWindow(chat, 'island');
      if (!old.isDestroyed()) old.destroy();
      chatCrashed = false;
    }
    const candidate = chat;
    chatLoading = loadRenderer(candidate, 'chat').then(() => {
      if (candidate.isDestroyed() || candidate !== chat) throw new Error('CHAT_PRESENTATION_UNAVAILABLE');
      chatLoaded = true; return candidate;
    }).finally(() => { chatLoading = null; });
    return chatLoading;
  };
  const ensureBubbleWindow = (): Promise<BrowserWindow> => {
    if (bubbleLoading) return bubbleLoading;
    if (!bubble.isDestroyed() && bubbleLoaded && !bubbleCrashed) return Promise.resolve(bubble);
    if (bubble.isDestroyed() || bubbleCrashed) {
      const old = bubble;
      bubble = createBubbleWindow(BrowserWindow, preload); bindPresentationWindow(bubble, 'bubble');
      if (!old.isDestroyed()) old.destroy();
      bubbleCrashed = false;
    }
    const candidate = bubble;
    bubbleLoading = loadRenderer(candidate, 'bubble').then(() => {
      if (candidate.isDestroyed() || candidate !== bubble) throw new Error('CHAT_PRESENTATION_UNAVAILABLE');
      bubbleLoaded = true; return candidate;
    }).finally(() => { bubbleLoading = null; });
    return bubbleLoading;
  };
  bindPresentationWindow(chat, 'island'); bindPresentationWindow(bubble, 'bubble');
  const ensureSettingsWindow = settingsWindows.ensure;
  const ensureCharacterWorkshopWindow = characterWorkshopWindows.ensure;
  const windowCommands = createWindowCommandController({
    getChatWindow: () => chat,
    ensureChatWindow,
    openChat: () => { void ensureBubbleWindow().catch(() => presentation.markUnavailable('bubble')); presentation.requestOpen(); },
    closeChat: () => presentation.requestClose(),
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

  tray = new Tray(applicationIcon);
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
      [pet, chat, settingsWindows.getCurrent(), characterWorkshopWindows.getCurrent()],
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
    const validated = taskEventSchema.parse(event);
    // Main 先接纳同一正式事件，再投递窗口；恢复快照与实时正文始终有单一顺序。
    conversationSession.observe(validated);
    conversationEventProjection.publish(validated);
    // 只订阅既有 reset 结果清理展示；不进入会话、角色或权限决策。
    if (validated.type === 'conversation_reset') { presentationBridge.clear(); presentation.clear(); }
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
    history: conversationSession.history,
    readProviderSettings: () => {
      if (modelChanges.isChanging() || newConversationPromise || shuttingDown) {
        throw new Error('CONVERSATION_CLOSED');
      }
      return localModelService.providerSettingsSnapshot();
    },
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
      { inputByteBudget: isBuiltinLocalProviderProfile(profile) ? 19_200 : 64 * 1024,
        singleSlot: isBuiltinLocalProviderProfile(profile) }
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
  startNewConversation = () => {
    if (newConversationPromise) return newConversationPromise;
    // 新对话清空与模型身份写入完成之前，不接纳下一轮，避免异步保存清掉新消息。
    const operation = Promise.resolve().then(async () => {
      characterProactivityRuntime.invalidate();
      const identity = conversationModelIdentity(await readModelConfiguration());
      await conversationCoordinator.resetConversation();
      await conversationSession.reset(identity);
    });
    const tracked = operation.finally(() => { if (newConversationPromise === tracked) newConversationPromise = null; });
    newConversationPromise = tracked;
    return tracked;
  };
  const requestNewConversation = () => {
    if (modelChanges.isChanging() || shuttingDown) throw new Error('CONVERSATION_TRANSITION_PENDING');
    return startNewConversation!();
  };
  const conversationIpcService = {
    submit: async (text: string): Promise<void> => {
      if (modelChanges.isChanging() || newConversationPromise || shuttingDown) {
        throw new Error('CONVERSATION_TRANSITION_PENDING');
      }
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
    cancelActive: () => {
      characterProactivityRuntime.noteUserInteraction();
      characterBehaviorDirector.noteUserInteraction('control');
      return conversationCoordinator.cancelActive();
    },
    resolveFileAction: (actionId: string, decision: 'confirm' | 'cancel') => {
      characterProactivityRuntime.noteUserInteraction();
      characterBehaviorDirector.noteUserInteraction('control');
      return conversationCoordinator.resolveFileAction(actionId, decision);
    },
    resolveHistoryDisclosure: (
      requestId: string,
      decision: 'share_once' | 'current_message_only'
    ) => {
      characterProactivityRuntime.noteUserInteraction();
      characterBehaviorDirector.noteUserInteraction('control');
      return conversationCoordinator.resolveHistoryDisclosure(requestId, decision);
    },
    resolveCapabilityAuthorization: (
      requestId: string,
      decision: 'confirm' | 'cancel'
    ) => {
      characterProactivityRuntime.noteUserInteraction();
      characterBehaviorDirector.noteUserInteraction('control');
      return conversationCoordinator.resolveCapabilityAuthorization(requestId, decision);
    },
    getConversationSnapshot: () => conversationSession.snapshot(),
    resetConversation: () => {
      characterProactivityRuntime.noteUserInteraction();
      characterBehaviorDirector.noteUserInteraction('control');
      return requestNewConversation();
    }
  };
  registerAgentIpc(ipcMain, conversationIpcService, getCurrentChatWebContents);

  const shutdownApplication = createMainShutdownTransaction({
    beforeExplorerClose: async () => {
      shuttingDown = true;
      const failures: unknown[] = [];
      // 待确认切换按取消关闭；已接纳提交先结算。Runtime 同时关闭，解除可能仍在等待的模型启动。
      const modelResults = await Promise.allSettled([modelChanges.close(), localModelService.close()]);
      for (const result of modelResults) if (result.status === 'rejected') failures.push(result.reason);
      try { await newConversationPromise; } catch (error) { failures.push(error); }
      // 切换收尾后封闭会话；失败时仍继续冲刷存储与设置，避免阻断后续关闭事务。
      try {
        await conversationComposition.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await conversationSession.flush();
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
      closePresentation,
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
  const resetForConfigurationChange = () => resetLocalModelConversation!();
  registerSettingsIpc(ipcMain, settingsStore, secrets, {
    onProviderChanged: resetForConfigurationChange,
    onAuthorizedRootChanged: resetForConfigurationChange,
    onConversationCleared: requestNewConversation
  }, settingsActions, modelChanges);
  registerAdvancedSettingsIpc(ipcMain, desktopSettingsService, {
    onConfigurationChanged: resetForConfigurationChange
  });

  await Promise.all([
    loadRenderer(pet, 'pet'),
    ensureChatWindow(),
    ensureBubbleWindow().catch(() => { presentation.markUnavailable('bubble'); presentation.requestOpen(); })
  ]);
  void localModelService.start().catch(error => {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'LOCAL_MODEL_START_FAILED';
    console.error('内置本地模型后台启动失败。', code);
  });
  await characterBehavior.initialize();
  finishCharacterInitialization();
  await petGeometry.initialize();
  // 只读现有视觉权威的相对包围框与当前原生位置，不回写宠物几何或移动状态。
  const updatePresentationGeometry = (): void => {
    if (presentationClosing) return;
    const snapshot = getPetGeometrySnapshot();
    if (pet.isDestroyed() || !snapshot) { presentation.updatePetGeometry(null); return; }
    const bounds = pet.getBounds(), visual = snapshot.visualBoundsInWindowDip;
    presentation.updatePetGeometry({ x: bounds.x + visual.x, y: bounds.y + visual.y, width: visual.width, height: visual.height });
  };
  const pollPresentation = (): void => {
    try { updatePresentationGeometry(); presentation.poll(); }
    catch { console.error('更新聊天窗口表现失败。', 'CHAT_PRESENTATION_UNAVAILABLE'); }
  };
  pet.on('move', pollPresentation); pet.on('show', pollPresentation);
  pet.on('hide', pollPresentation); pet.on('closed', pollPresentation);
  screen.on('display-metrics-changed', pollPresentation);
  screen.on('display-added', pollPresentation);
  screen.on('display-removed', pollPresentation);
  presentationReleases.push(() => {
    pet.removeListener('move', pollPresentation); pet.removeListener('show', pollPresentation);
    pet.removeListener('hide', pollPresentation); pet.removeListener('closed', pollPresentation);
    screen.removeListener('display-metrics-changed', pollPresentation);
    screen.removeListener('display-added', pollPresentation);
    screen.removeListener('display-removed', pollPresentation);
  });
  presentationTimer = setInterval(pollPresentation, 50); presentationTimer.unref(); pollPresentation();
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
