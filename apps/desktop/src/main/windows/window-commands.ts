import type { MenuItemConstructorOptions } from 'electron';
import type { HabitatDirectoryOpenRequest } from '../habitat/habitat-service';

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

/** 普通桌宠显示/隐藏命令只读取窗口自身状态。 */
export function createPetVisibilityCommand(pet: PetVisibilityTarget): () => void {
  return () => {
    if (pet.isDestroyed()) return;
    if (pet.isVisible()) pet.hide();
    else pet.show();
  };
}

/** 生产托盘只组合普通窗口命令与角色切换，不再注入目录空间命令。 */
export function buildApplicationTrayMenu(options: {
  togglePetVisibility(): void;
  openChat(): void;
  openCharacterWorkshop(): void;
  quickSwitchItems: MenuItemConstructorOptions[];
  openSettings(): void;
  quit(): void;
}): MenuItemConstructorOptions[] {
  return [
    { label: '显示/隐藏桌宠', click: options.togglePetVisibility },
    { type: 'separator' },
    { label: '打开聊天', click: options.openChat },
    { label: '角色工作室', click: options.openCharacterWorkshop },
    {
      label: '切换角色',
      enabled: options.quickSwitchItems.length > 0,
      submenu: options.quickSwitchItems
    },
    { label: '设置', click: options.openSettings },
    { type: 'separator' },
    { label: '退出', click: options.quit }
  ];
}

/** opener 只从 Main 已复核记录取路径；shell.openPath 非空返回同样表示失败。 */
export function createVerifiedDirectoryOpener(
  openPath: (absolutePath: string) => Promise<string>
): (request: HabitatDirectoryOpenRequest) => Promise<void> {
  return async ({ directory, signal }) => {
    try {
      if (signal.aborted) throw new Error('OPEN_PATH_ABORTED');
      const errorMessage = await openPath(directory.absolutePath);
      if (signal.aborted) throw new Error('OPEN_PATH_ABORTED');
      if (errorMessage !== '') throw new Error('OPEN_PATH_FAILED');
    } catch {
      throw new Error('HABITAT_SUMMON_FAILED');
    }
  };
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
