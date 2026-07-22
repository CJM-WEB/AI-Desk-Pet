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
}

export interface WindowCommandController {
  showChat(): Promise<void>;
  hideChat(): void;
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
    }
  };
}
