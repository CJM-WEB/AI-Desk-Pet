import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * 统一托管浏览器原生模态对话框生命周期，确保进入 top layer 并在关闭后归还触发焦点。
 */
export function useModalDialog(
  open: boolean
): RefObject<HTMLDialogElement | null> {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const restoreTimerRef = useRef<number | null>(null);

  function cancelPendingRestore(): void {
    if (restoreTimerRef.current !== null) {
      window.clearTimeout(restoreTimerRef.current);
      restoreTimerRef.current = null;
    }
  }

  function restoreFocus(): void {
    cancelPendingRestore();
    restoreTimerRef.current = window.setTimeout(() => {
      restoreTimerRef.current = null;
      if (returnFocusRef.current?.isConnected) {
        returnFocusRef.current.focus();
      }
    }, 0);
  }

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    if (open) {
      cancelPendingRestore();
      returnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      if (!dialog.open) dialog.showModal();
      return () => {
        if (dialog.open) dialog.close();
      };
    }

    if (dialog.open) dialog.close();
    restoreFocus();
    return () => {
      cancelPendingRestore();
    };
  }, [open]);

  useLayoutEffect(() => () => {
    cancelPendingRestore();
  }, []);

  return dialogRef;
}
