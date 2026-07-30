export interface SingleInstanceApplication {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: 'second-instance', listener: () => void): unknown;
}

export interface FocusablePetWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * 单实例锁必须在任何持久化服务和窗口创建前完成。
 * 第二实例只唤醒现有桌宠，不执行新的初始化或存储恢复。
 */
export function configureSingleInstance(
  application: SingleInstanceApplication,
  getPetWindow: () => FocusablePetWindow | null
): boolean {
  if (!application.requestSingleInstanceLock()) {
    application.quit();
    return false;
  }
  application.on('second-instance', () => {
    const pet = getPetWindow();
    if (!pet || pet.isDestroyed()) return;
    if (pet.isMinimized()) pet.restore();
    pet.show();
    pet.focus();
  });
  return true;
}
