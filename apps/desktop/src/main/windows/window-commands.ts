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
