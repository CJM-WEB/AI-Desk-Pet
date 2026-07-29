// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { StrictMode } from 'react';
import {
  loadCharacterStartupRecovery,
  PetAnchorOverlays,
  PetView
} from '../src/renderer/src/pet/PetView';
import type { MyselfApi } from '../src/shared/myself-api';
import { taskStore } from '../src/renderer/src/stores/task-store';

const originalTaskStoreActions = {
  triggerCharacterPointer: taskStore.getState().triggerCharacterPointer
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  taskStore.setState(originalTaskStoreActions);
});

test('Renderer 就绪后读取启动恢复快照并保留稳定错误码', async () => {
  const apply = vi.fn();
  const api = {
    getCharacterRecoverySnapshot: vi.fn(async () => ({
      errorCode: 'CHARACTER_INDEX_UNAVAILABLE'
    }))
  } as unknown as MyselfApi;

  await loadCharacterStartupRecovery(api, apply);

  expect(apply).toHaveBeenCalledWith('CHARACTER_INDEX_UNAVAILABLE');
});

test('启动恢复快照读取失败时映射为通用恢复状态且不抛出未处理异常', async () => {
  const apply = vi.fn();
  const api = {
    getCharacterRecoverySnapshot: vi.fn(async () => {
      throw new Error('Error invoking remote method: PRIVATE_PATH');
    })
  } as unknown as MyselfApi;

  await expect(loadCharacterStartupRecovery(api, apply)).resolves.toBeUndefined();

  expect(apply).toHaveBeenCalledWith('CHARACTER_OPERATION_FAILED');
});

describe('桌宠锚点视觉消费者', () => {
  test('锚点视觉对象的定位与尺寸在默认动画偏好下仍然生效', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/styles.css'),
      'utf8'
    );
    const baseCss = css.split('@media (prefers-reduced-motion: reduce)')[0] ?? '';

    expect(baseCss).toMatch(
      /\.pet-carried-file,\s*\.pet-seat-effect,\s*\.pet-focus-effect\s*\{[^}]*position:\s*absolute;/su
    );
    expect(baseCss).toMatch(/\.pet-carried-file\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/su);
    expect(baseCss).toMatch(/\.pet-seat-effect\s*\{[^}]*width:\s*30px;[^}]*height:\s*8px;/su);
    expect(baseCss).toMatch(/\.pet-focus-effect\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;/su);
  });

  test('搬运文件与 seat/focus 特效使用非零桌面锚点换算窗口本地坐标', () => {
    const { container, rerender } = render(
      <PetAnchorOverlays
        carrying
        windowOrigin={{ x: 100, y: 200 }}
        anchors={{
          carry: { x: 130, y: 240 },
          seat: { x: 145, y: 255 },
          focus: { x: 160, y: 270 }
        }}
      />
    );

    expect(container.querySelector<HTMLElement>('.pet-carried-file')?.style.cssText)
      .toContain('left: 30px');
    expect(container.querySelector<HTMLElement>('.pet-carried-file')?.style.cssText)
      .toContain('top: 40px');
    expect(container.querySelector<HTMLElement>('.pet-seat-effect')?.style.cssText)
      .toContain('left: 45px');
    expect(container.querySelector<HTMLElement>('.pet-focus-effect')?.style.cssText)
      .toContain('top: 70px');

    rerender(
      <PetAnchorOverlays
        carrying
        windowOrigin={{ x: 120, y: 210 }}
        anchors={{
          carry: { x: 155, y: 260 },
          seat: null,
          focus: null
        }}
      />
    );
    expect(container.querySelector<HTMLElement>('.pet-carried-file')?.style.cssText)
      .toContain('left: 35px');
    expect(container.querySelector<HTMLElement>('.pet-carried-file')?.style.cssText)
      .toContain('top: 50px');
  });

  test('非搬运状态不显示文件视觉对象且不读取文件路径', () => {
    const { container } = render(
      <PetAnchorOverlays
        carrying={false}
        windowOrigin={{ x: 0, y: 0 }}
        anchors={{ carry: { x: 10, y: 20 }, seat: null, focus: null }}
      />
    );
    expect(container.querySelector('.pet-carried-file')).toBeNull();
    expect(container.innerHTML).not.toContain('path');
  });
});

function createPetViewApi(): MyselfApi {
  return {
    getCharacterRecoverySnapshot: vi.fn(async () => ({ errorCode: null })),
    getCharacterRuntimeSnapshot: vi.fn(async () => null),
    subscribeCharacterEvents: vi.fn(() => vi.fn()),
    setPetMousePassthrough: vi.fn().mockResolvedValue(undefined),
    beginPetDrag: vi.fn().mockResolvedValue(undefined),
    endPetDrag: vi.fn().mockResolvedValue(undefined),
    openPetContextMenu: vi.fn().mockResolvedValue(undefined),
    openChat: vi.fn().mockResolvedValue(undefined)
  } as unknown as MyselfApi;
}

function installPetViewBrowserApi(api: MyselfApi): void {
  Object.defineProperty(window, 'myself', {
    configurable: true,
    value: api
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  });
}

describe('桌宠像素交互接线', () => {
  test('桌宠容器使用普通 DOM 且不再保留旧按钮与整窗拖拽区域', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/styles.css'),
      'utf8'
    );

    expect(css).not.toMatch(/\.pet-open-chat\b/u);
    expect(css).not.toMatch(/\.pet-shell\s*\{[^}]*-webkit-app-region:\s*drag/su);
    expect(css).toMatch(/\.pet-character-surface\s*\{[^}]*width:\s*100%;/su);
  });

  test('备用角色可见区域左键只拖拽，释放后清理 capture 且不聊天或触发扩展', async () => {
    const api = createPetViewApi();
    installPetViewBrowserApi(api);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const triggerCharacterPointer = vi.fn();
    taskStore.setState({ triggerCharacterPointer });
    const result = render(
      <StrictMode>
        <PetView />
      </StrictMode>
    );
    const fallback = await waitFor(() => {
      const element = result.container.querySelector<HTMLElement>('.pet-character');
      expect(element).not.toBeNull();
      return element!;
    });
    vi.spyOn(fallback, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 110,
      bottom: 140,
      width: 100,
      height: 120,
      toJSON: () => ({})
    });
    const shell = result.container.querySelector<HTMLElement>('.pet-shell')!;
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.assign(shell, { setPointerCapture, releasePointerCapture });

    fireEvent.pointerMove(shell, { clientX: 20, clientY: 30, pointerId: 7 });
    fireEvent.pointerDown(shell, {
      clientX: 20,
      clientY: 30,
      pointerId: 7,
      button: 0
    });
    fireEvent.click(fallback);
    fireEvent.doubleClick(fallback);

    expect(api.beginPetDrag).toHaveBeenCalledOnce();
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(api.openChat).not.toHaveBeenCalled();
    expect(triggerCharacterPointer).not.toHaveBeenCalled();

    fireEvent.pointerUp(shell, { pointerId: 7, button: 0 });
    expect(api.endPetDrag).toHaveBeenCalledOnce();
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
  });

  test('右键先更新坐标，只在备用角色命中时阻止默认菜单并调用单一受限入口', async () => {
    const api = createPetViewApi();
    installPetViewBrowserApi(api);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = render(<PetView />);
    const fallback = await waitFor(() => {
      const element = result.container.querySelector<HTMLElement>('.pet-character');
      expect(element).not.toBeNull();
      return element!;
    });
    vi.spyOn(fallback, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 110,
      bottom: 140,
      width: 100,
      height: 120,
      toJSON: () => ({})
    });
    const shell = result.container.querySelector<HTMLElement>('.pet-shell')!;

    expect(fireEvent.contextMenu(shell, { clientX: 150, clientY: 180 })).toBe(false);
    expect(api.openPetContextMenu).not.toHaveBeenCalled();
    expect(fireEvent.contextMenu(shell, { clientX: 20, clientY: 30 })).toBe(false);
    expect(api.openPetContextMenu).toHaveBeenCalledOnce();
  });

  test('blur 与卸载幂等结束拖拽并释放订阅后的事件副作用', async () => {
    const api = createPetViewApi();
    installPetViewBrowserApi(api);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = render(<PetView />);
    const fallback = await waitFor(() => {
      const element = result.container.querySelector<HTMLElement>('.pet-character');
      expect(element).not.toBeNull();
      return element!;
    });
    vi.spyOn(fallback, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      toJSON: () => ({})
    });
    const shell = result.container.querySelector<HTMLElement>('.pet-shell')!;
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.assign(shell, {
      setPointerCapture,
      releasePointerCapture
    });
    fireEvent.pointerMove(shell, { clientX: 20, clientY: 30, pointerId: 2 });
    fireEvent.pointerDown(shell, {
      clientX: 20,
      clientY: 30,
      pointerId: 2,
      button: 0
    });

    fireEvent.blur(window);
    expect(api.endPetDrag).toHaveBeenCalledOnce();
    fireEvent.pointerMove(shell, { clientX: 20, clientY: 30, pointerId: 3 });
    fireEvent.pointerDown(shell, {
      clientX: 20,
      clientY: 30,
      pointerId: 3,
      button: 0
    });
    result.unmount();

    expect(api.endPetDrag).toHaveBeenCalledTimes(2);
    expect(setPointerCapture).toHaveBeenCalledTimes(2);
    expect(releasePointerCapture).toHaveBeenCalledTimes(2);
    expect(api.setPetMousePassthrough).toHaveBeenLastCalledWith(true);
  });
});
