import { randomUUID } from 'node:crypto';
import type { CharacterWorkshopCloseReason } from '../../shared/myself-api';

interface FlushWebContents {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

interface FlushWindow {
  isDestroyed(): boolean;
  hide(): void;
  webContents: FlushWebContents;
  on(
    event: 'close',
    listener: (event: { preventDefault(): void }) => void
  ): unknown;
}

interface FlushIpcEvent {
  sender: FlushWebContents;
}

interface FlushIpcMain {
  on(
    channel: string,
    listener: (event: FlushIpcEvent, payload: unknown) => void
  ): unknown;
}

interface PendingFlush {
  sender: FlushWebContents;
  reason: CharacterWorkshopCloseReason;
  resolve(result: boolean): void;
  timer: ReturnType<typeof setTimeout>;
}

interface InFlightFlush {
  reason: CharacterWorkshopCloseReason;
  operation: Promise<boolean>;
}

export interface CharacterWorkshopCloseHandshake {
  bindWindow(window: FlushWindow, isQuitting: () => boolean): void;
  flush(window: FlushWindow | null): Promise<boolean>;
}

export interface CharacterWorkshopCloseHandshakeOptions {
  ipcMain: FlushIpcMain;
  requestChannel: string;
  acknowledgementChannel: string;
  timeoutMs?: number;
  createToken?: () => string;
  reportError?: (error: unknown) => void;
}

const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;

function handshakeError(code: string): Error {
  return new Error(code);
}

function isAcknowledgement(
  payload: unknown
): payload is { token: string; ok: boolean } {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  return typeof record['token'] === 'string'
    && record['token'].length > 0
    && typeof record['ok'] === 'boolean';
}

/**
 * 将窗口关闭和应用退出统一为一次有界刷新握手。
 * ACK 只有同时匹配一次性 token 与目标 WebContents 时才会解锁等待。
 */
export function createCharacterWorkshopCloseHandshake(
  options: CharacterWorkshopCloseHandshakeOptions
): CharacterWorkshopCloseHandshake {
  const pendingByToken = new Map<string, PendingFlush>();
  const inFlightBySender = new WeakMap<FlushWebContents, InFlightFlush>();
  const timeoutMs = options.timeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  const createToken = options.createToken ?? randomUUID;

  const reportError = (error: unknown): void => {
    try {
      options.reportError?.(error);
    } catch {
      // 错误报告本身不得打断关闭或退出流程。
    }
  };

  options.ipcMain.on(options.acknowledgementChannel, (event, payload) => {
    if (!isAcknowledgement(payload)) {
      reportError(handshakeError('CHARACTER_WORKSHOP_FLUSH_INVALID_ACK'));
      return;
    }
    const pending = pendingByToken.get(payload.token);
    if (!pending) {
      reportError(handshakeError('CHARACTER_WORKSHOP_FLUSH_INVALID_TOKEN'));
      return;
    }
    if (event.sender !== pending.sender) {
      reportError(handshakeError('CHARACTER_WORKSHOP_FLUSH_INVALID_SENDER'));
      return;
    }

    clearTimeout(pending.timer);
    pendingByToken.delete(payload.token);
    if (!payload.ok && pending.reason === 'app_quit') {
      reportError(handshakeError('CHARACTER_WORKSHOP_FLUSH_FAILED'));
    }
    pending.resolve(payload.ok);
  });

  const request = (
    window: FlushWindow | null,
    reason: CharacterWorkshopCloseReason
  ): Promise<boolean> => {
    if (
      !window
      || window.isDestroyed()
      || window.webContents.isDestroyed()
    ) {
      return Promise.resolve(true);
    }

    const sender = window.webContents;
    const existing = inFlightBySender.get(sender);
    if (existing?.reason === reason) return existing.operation;
    if (existing) {
      // 应用退出必须在窗口关闭判断结束后独立执行显式保存，不能复用“暂不关闭”。
      return existing.operation.then(() => request(window, reason));
    }

    const token = createToken();
    const operation = new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        pendingByToken.delete(token);
        reportError(handshakeError('CHARACTER_WORKSHOP_FLUSH_TIMEOUT'));
        resolve(false);
      }, timeoutMs);
      pendingByToken.set(token, { sender, reason, resolve, timer });

      try {
        sender.send(options.requestChannel, { token, reason });
      } catch {
        clearTimeout(timer);
        pendingByToken.delete(token);
        reportError(handshakeError('CHARACTER_WORKSHOP_FLUSH_SEND_FAILED'));
        resolve(false);
      }
    });
    inFlightBySender.set(sender, { reason, operation });
    void operation.then(() => {
      if (inFlightBySender.get(sender)?.operation === operation) {
        inFlightBySender.delete(sender);
      }
    });
    return operation;
  };

  return {
    flush: window => request(window, 'app_quit'),
    bindWindow(window, isQuitting) {
      let closePending = false;
      window.on('close', event => {
        if (isQuitting()) return;
        event.preventDefault();
        if (closePending) return;
        closePending = true;
        void (async () => {
          const allowed = await request(window, 'window_close');
          closePending = false;
          if (allowed && !isQuitting() && !window.isDestroyed()) window.hide();
        })().catch(error => {
          closePending = false;
          reportError(error);
        });
      });
    }
  };
}
