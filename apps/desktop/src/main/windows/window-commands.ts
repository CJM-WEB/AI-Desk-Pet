/** 窗口命令只依赖正式 BrowserWindow 所需的最小职责面。 */
export interface ChatWindowCommandTarget {
  isDestroyed(): boolean;
  hide(): void;
  show(): void;
  focus(): void;
}

export interface WindowCommandControllerOptions<TWindow extends ChatWindowCommandTarget> {
  getChatWindow(): TWindow;
  ensureChatWindow(): Promise<TWindow>;
  positionChat(window: TWindow): void;
  ensureCharacterWorkshopWindow(): Promise<TWindow>;
}

export interface WindowCommandController {
  showChat(): Promise<void>;
  hideChat(): void;
  showCharacterWorkshop(): Promise<void>;
}

export interface LoadBeforePublishTarget {
  isDestroyed(): boolean;
  destroy(): void;
}

export interface CharacterBroadcastTarget {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
}

export interface PetVisibilityTarget {
  isDestroyed(): boolean;
  isVisible(): boolean;
  hide(): void;
  show(): void;
}

type HabitatTrayState = 'desktop' | 'folder-hidden' | 'folder-visible' | 'folder-lost';

interface HabitatCommandSnapshot {
  state: HabitatTrayState;
  directoryId: string | null;
}

export type PetSummonResult =
  | { status: 'visible' }
  | {
      status: 'error';
      errorCode: 'HABITAT_DIRECTORY_UNAVAILABLE' | 'HABITAT_SUMMON_FAILED';
      canRecall: true;
    };

export interface HabitatTrayMenuItem {
  label: string;
  enabled?: boolean;
  submenu?: HabitatTrayMenuItem[];
  click?: () => void;
}

const DEFAULT_SUMMON_TIMEOUT_MS = 5_000;

/** 托盘与后续空间菜单复用同一普通桌宠显示/隐藏命令。 */
export function createPetVisibilityCommand(pet: PetVisibilityTarget): () => void {
  return () => {
    if (pet.isDestroyed()) return;
    if (pet.isVisible()) pet.hide();
    else pet.show();
  };
}

/** shell.openPath 的非空字符串同样表示失败，且不能把系统详情向外透传。 */
export function createVerifiedDirectoryOpener(
  openPath: (absolutePath: string) => Promise<string>
): (absolutePath: string) => Promise<void> {
  return async absolutePath => {
    try {
      const errorMessage = await openPath(absolutePath);
      if (errorMessage !== '') throw new Error('OPEN_PATH_FAILED');
    } catch {
      throw new Error('HABITAT_SUMMON_FAILED');
    }
  };
}

/**
 * 呼唤只等待由 HabitatService 认可的准确目录事件；超时不改变隐藏状态。
 */
export function createPetSummonController(options: {
  habitat: {
    snapshot(): HabitatCommandSnapshot;
    summon(): Promise<unknown>;
  };
  waitForExactExplorer(
    directoryId: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<boolean>;
  timeoutMs?: number;
}): { summon(): Promise<PetSummonResult> } {
  return {
    async summon() {
      const before = options.habitat.snapshot();
      if (before.state === 'folder-lost') {
        return {
          status: 'error',
          errorCode: 'HABITAT_DIRECTORY_UNAVAILABLE',
          canRecall: true
        };
      }
      if (before.state === 'desktop') {
        try {
          await options.habitat.summon();
          return { status: 'visible' };
        } catch {
          return { status: 'error', errorCode: 'HABITAT_SUMMON_FAILED', canRecall: true };
        }
      }
      if (before.directoryId === null) {
        return { status: 'error', errorCode: 'HABITAT_SUMMON_FAILED', canRecall: true };
      }

      const abort = new AbortController();
      const timeoutMs = options.timeoutMs ?? DEFAULT_SUMMON_TIMEOUT_MS;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const timedOut = new Promise<boolean>(resolve => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        });
        const exactMatch = options.waitForExactExplorer(
          before.directoryId,
          timeoutMs,
          abort.signal
        );
        const summonAndWait = Promise.all([
          Promise.resolve().then(() => options.habitat.summon()),
          exactMatch
        ]).then(([, matched]) => matched);
        const matched = await Promise.race([summonAndWait, timedOut]);
        const after = options.habitat.snapshot();
        return matched
          && after.state === 'folder-visible'
          && after.directoryId === before.directoryId
          ? { status: 'visible' }
          : { status: 'error', errorCode: 'HABITAT_SUMMON_FAILED', canRecall: true };
      } catch {
        return { status: 'error', errorCode: 'HABITAT_SUMMON_FAILED', canRecall: true };
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        abort.abort();
      }
    }
  };
}

function runTrayCommand(
  command: () => Promise<unknown>,
  reportError: (code: string) => void
): () => void {
  return () => {
    void command().catch(() => reportError('HABITAT_OPERATION_FAILED'));
  };
}

/** 根据 Habitat 稳定状态构造托盘空间命令，不暴露绝对路径。 */
export function buildHabitatTrayMenu(options: {
  snapshot: HabitatCommandSnapshot;
  directories: Array<{ id: string; displayName: string; enabled: boolean }>;
  enterDirectory(directoryId: string): Promise<unknown>;
  summon(): Promise<PetSummonResult>;
  recall(): Promise<unknown>;
  togglePetVisibility(): void;
  reportError(code: string): void;
}): HabitatTrayMenuItem[] {
  if (options.snapshot.state === 'desktop') {
    const submenu = options.directories
      .filter(directory => directory.enabled)
      .map(directory => ({
        label: directory.displayName,
        click: runTrayCommand(
          () => options.enterDirectory(directory.id),
          options.reportError
        )
      }));
    return [
      {
        label: '藏到目录',
        enabled: submenu.length > 0,
        submenu
      },
      {
        label: '显示/隐藏桌宠',
        click: options.togglePetVisibility
      }
    ];
  }

  const summon = options.snapshot.state === 'folder-lost'
    ? () => options.reportError('HABITAT_DIRECTORY_UNAVAILABLE')
    : () => {
        void options.summon()
          .then(result => {
            if (result.status === 'error') options.reportError(result.errorCode);
          })
          .catch(() => options.reportError('HABITAT_OPERATION_FAILED'));
      };
  return [
    { label: '呼唤桌宠', click: summon },
    {
      label: '召回桌面',
      click: runTrayCommand(options.recall, options.reportError)
    }
  ];
}

/**
 * 窗口创建与加载形成单一事务：加载成功前不发布候选，失败后允许重新创建。
 */
export function createLoadBeforePublishWindow<
  TWindow extends LoadBeforePublishTarget
>(options: {
  create(): TWindow;
  prepare(window: TWindow): void;
  load(window: TWindow): Promise<void>;
}): {
  getCurrent(): TWindow | null;
  ensure(): Promise<TWindow>;
} {
  let current: TWindow | null = null;
  let inFlight: Promise<TWindow> | null = null;

  return {
    getCurrent: () => current,
    ensure: () => {
      if (current && !current.isDestroyed()) return Promise.resolve(current);
      current = null;
      if (inFlight) return inFlight;

      const candidate = options.create();
      try {
        options.prepare(candidate);
      } catch (error) {
        if (!candidate.isDestroyed()) candidate.destroy();
        return Promise.reject(error);
      }

      let creation: Promise<TWindow> | null = null;
      creation = (async () => {
        try {
          await options.load(candidate);
          current = candidate;
          return candidate;
        } catch (error) {
          if (!candidate.isDestroyed()) candidate.destroy();
          if (current === candidate) current = null;
          throw error;
        } finally {
          if (inFlight === creation) inFlight = null;
        }
      })();
      inFlight = creation;
      return creation;
    }
  };
}

/** 角色事件逐目标检查并隔离发送故障。 */
export function broadcastCharacterEvent(
  targets: readonly (CharacterBroadcastTarget | null)[],
  channel: string,
  payload: unknown
): void {
  for (const target of targets) {
    try {
      if (
        !target
        || target.isDestroyed()
        || target.webContents.isDestroyed()
      ) {
        continue;
      }
      target.webContents.send(channel, payload);
    } catch {
      // 某个窗口已并发销毁或发送失败时，继续通知其他目标。
    }
  }
}

/** 快速切换菜单显式接住异步拒绝，旧菜单项失效时不会产生未处理 Promise。 */
export function createCharacterQuickSwitchCommand(
  characterId: string,
  activate: (characterId: string) => Promise<void>,
  reportError: (error: unknown) => void
): () => void {
  return () => {
    void activate(characterId).catch(reportError);
  };
}

/** 统一 Main、托盘与正式 IPC 的聊天窗口显示/隐藏语义。 */
export function createWindowCommandController<TWindow extends ChatWindowCommandTarget>(
  options: WindowCommandControllerOptions<TWindow>
): WindowCommandController {
  return {
    async showChat() {
      const chat = await options.ensureChatWindow();
      options.positionChat(chat);
      chat.show();
      chat.focus();
    },
    hideChat() {
      const chat = options.getChatWindow();
      if (!chat.isDestroyed()) chat.hide();
    },
    async showCharacterWorkshop() {
      const workshop = await options.ensureCharacterWorkshopWindow();
      workshop.show();
      workshop.focus();
    }
  };
}
