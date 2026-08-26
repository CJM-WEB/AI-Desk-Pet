// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { StrictMode, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PetAnchorOverlays,
  PetView
} from '../src/renderer/src/pet/PetView';
import type { MyselfApi } from '../src/shared/myself-api';
import { taskStore } from '../src/renderer/src/stores/task-store';
import type {
  PetInteractionController
} from '../src/renderer/src/pet/pet-interaction-controller';
import type { CharacterRecoveryFallbackErrorCode } from '../src/shared/character-ipc';

const playerDouble = vi.hoisted(() => ({
  ready: false,
  reportRuntimeError: undefined as
    | ((errorCode: CharacterRecoveryFallbackErrorCode | null) => void)
    | undefined
}));
const EMPTY_RECOVERY_SNAPSHOT = { fallbackErrorCode: null, issues: [] } as const;

// PetView 测试只验证消费边界；播放器自身的 Pixi 与资源矩阵由其独立测试负责。
vi.mock('../src/renderer/src/characters/player/CharacterPlayer', async importOriginal => {
  const actual = await importOriginal<
    typeof import('../src/renderer/src/characters/player/CharacterPlayer')
  >();
  return {
    ...actual,
    CharacterPlayer: ({ fallback, onRuntimeError }: {
      fallback?: ReactNode;
      onRuntimeError?: (errorCode: CharacterRecoveryFallbackErrorCode | null) => void;
    }) => {
      playerDouble.reportRuntimeError = onRuntimeError;
      if (playerDouble.ready) return <span data-testid="healthy-character-player" />;
      return fallback;
    }
  };
});

const originalTaskStoreActions = {
  triggerCharacterPointer: taskStore.getState().triggerCharacterPointer
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  playerDouble.ready = false;
  playerDouble.reportRuntimeError = undefined;
  taskStore.setState(originalTaskStoreActions);
});

describe('桌宠锚点视觉消费者', () => {
  test('锚点视觉对象的定位与尺寸在默认动画偏好下仍然生效', () => {
    const css = readFileSync(
      resolve(import.meta.dirname, '../src/renderer/src/styles.css'),
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


test('固定默认尺寸下 wheel 不再交给桌宠交互控制器', () => {
  const api = createPetViewApi();
  installPetViewBrowserApi(api);
  const handleWheel = vi.fn(() => true);
  const controller = {
    setHitTestPort: vi.fn(), handlePointerMove: vi.fn(), handlePointerDown: vi.fn(),
    handlePointerUp: vi.fn(), handlePointerCancel: vi.fn(), handleContextMenu: vi.fn(),
    handleWheel, handlePointerLeave: vi.fn(), dispose: vi.fn()
  } as unknown as PetInteractionController;
  const { container } = render(
    <PetView createInteractionController={() => controller} />
  );
  const shell = container.querySelector<HTMLElement>('.pet-shell');
  if (!shell) throw new Error('测试要求桌宠 shell 存在');

  fireEvent.wheel(shell, { clientX: 37, clientY: 52, deltaY: -120 });

  expect(handleWheel).not.toHaveBeenCalled();
});

test('原生拖拽表面保持原动画模式且所有备用动画不改变尺寸', () => {
  const api = createPetViewApi();
  installPetViewBrowserApi(api);
  const controller = {
    setHitTestPort: vi.fn(), handlePointerMove: vi.fn(), handlePointerDown: vi.fn(),
    handlePointerUp: vi.fn(), handlePointerCancel: vi.fn(), handleContextMenu: vi.fn(),
    handlePointerLeave: vi.fn(), dispose: vi.fn()
  } as unknown as PetInteractionController;
  const { container } = render(
    <PetView createInteractionController={() => controller} />
  );

  expect(container.querySelector('.pet-character')?.getAttribute('data-motion')).toBe('animated');

  const styles = readFileSync(
    resolve(import.meta.dirname, '../src/renderer/src/styles.css'),
    'utf8'
  );
  const fallbackKeyframes = [...styles.matchAll(
    /@keyframes\s+(companion-[\w-]+)\s*\{([\s\S]*?)\n\}/gu
  )];
  expect(fallbackKeyframes.length).toBeGreaterThan(0);
  expect(fallbackKeyframes.map(([, name, body]) => ({ name, body })))
    .not.toEqual(expect.arrayContaining([
      expect.objectContaining({ body: expect.stringContaining('scale(') })
    ]));
});


function createPetViewApi(): MyselfApi {
  return {
    getCharacterRecoverySnapshot: vi.fn(async () => EMPTY_RECOVERY_SNAPSHOT),
    getCharacterRuntimeSnapshot: vi.fn(async () => null),
    subscribeCharacterEvents: vi.fn(() => vi.fn()),
    setPetMousePassthrough: vi.fn().mockResolvedValue(undefined),
    beginPetDrag: vi.fn(),
    updatePetDrag: vi.fn(),
    endPetDrag: vi.fn(),
    recordPetInteractionProbeEvent: vi.fn().mockResolvedValue(undefined),
    openChat: vi.fn().mockResolvedValue(undefined),
    openCharacterWorkshop: vi.fn().mockResolvedValue(undefined)
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

function renderPet(
  loadRecovery: MyselfApi['getCharacterRecoverySnapshot'] = async () => EMPTY_RECOVERY_SNAPSHOT,
  playerReady = false
): ReturnType<typeof render> & { api: MyselfApi } {
  const api = createPetViewApi();
  vi.mocked(api.getCharacterRecoverySnapshot).mockImplementation(loadRecovery);
  playerDouble.ready = playerReady;
  installPetViewBrowserApi(api);
  return { ...render(<PetView />), api };
}

describe('桌宠像素交互接线', () => {
  test('只有非活动角色 issues 时不显示降级横幅', async () => {
    const result = renderPet(async () => ({
      fallbackErrorCode: null,
      issues: [{
        characterId: 'other-pet',
        errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
      }]
    }), true);
    await result.findByTestId('healthy-character-player');
    expect(result.queryByRole('alert')).toBeNull();
    expect(result.container.querySelector('.pet-character')).toBeNull();
  });

  test('fallback 显示官方默认角色提示和工作室入口', async () => {
    const result = renderPet(async () => ({
      fallbackErrorCode: 'CHARACTER_RESOURCE_NOT_FOUND',
      issues: []
    }), true);
    await result.findByTestId('healthy-character-player');
    expect((await result.findByRole('alert')).textContent)
      .toContain('当前角色资源缺失，已切换到官方默认角色。');
    fireEvent.click(result.getByRole('button', { name: '打开角色工作室' }));
    expect(result.api.openCharacterWorkshop).toHaveBeenCalledOnce();
  });

  test('快照 RPC 失败不伪造已完成 fallback', async () => {
    const result = renderPet(
      async () => Promise.reject(new Error('C:\\private\\marker.json')),
      true
    );
    await result.findByTestId('healthy-character-player');
    await waitFor(() => expect(result.api.getCharacterRecoverySnapshot).toHaveBeenCalledOnce());
    expect(result.queryByRole('alert')).toBeNull();
  });

  test('较晚返回的无 fallback 快照不清除播放器故障', async () => {
    let resolveRecovery!: (value: typeof EMPTY_RECOVERY_SNAPSHOT) => void;
    const result = renderPet(() => new Promise(resolve => {
      resolveRecovery = resolve;
    }), true);
    await act(() => {
      playerDouble.reportRuntimeError?.('CHARACTER_RUNTIME_UNAVAILABLE');
    });
    expect((await result.findByRole('alert')).textContent)
      .toContain('当前角色无法加载，请打开角色工作室检查并修复');
    resolveRecovery(EMPTY_RECOVERY_SNAPSHOT);
    await waitFor(() => expect(result.api.getCharacterRecoverySnapshot).toHaveBeenCalledOnce());
    expect(result.getByRole('alert').textContent).not.toContain('已切换');
  });

  test('启动 fallback 先到时不被较晚的播放器状态清除', async () => {
    let resolveRecovery!: (value: {
      fallbackErrorCode: 'CHARACTER_RESOURCE_NOT_FOUND';
      issues: [];
    }) => void;
    const result = renderPet(() => new Promise(resolve => {
      resolveRecovery = resolve;
    }), true);
    resolveRecovery({
      fallbackErrorCode: 'CHARACTER_RESOURCE_NOT_FOUND',
      issues: []
    });
    expect((await result.findByRole('alert')).textContent).toContain('当前角色资源缺失');
    await act(() => {
      playerDouble.reportRuntimeError?.('CHARACTER_RUNTIME_UNAVAILABLE');
      playerDouble.reportRuntimeError?.(null);
    });
    expect(result.getByRole('alert').textContent).toContain('当前角色资源缺失');
  });

  test('服务端渲染阶段不构造控制器或发送穿透 IPC', () => {
    const api = createPetViewApi();
    installPetViewBrowserApi(api);

    renderToStaticMarkup(<PetView />);

    expect(api.setPetMousePassthrough).not.toHaveBeenCalled();
  });

  test('StrictMode 中每个已提交控制器实例都有配对 dispose', () => {
    const api = createPetViewApi();
    installPetViewBrowserApi(api);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const instances: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
    const createInteractionController = vi.fn(() => {
      const instance = {
        setHitTestPort: vi.fn(),
        handlePointerMove: vi.fn(),
        handlePointerDown: vi.fn(),
        handlePointerUp: vi.fn(),
        handlePointerCancel: vi.fn(),
        handleContextMenu: vi.fn(),
        dispose: vi.fn()
      };
      instances.push(instance);
      return instance as unknown as PetInteractionController;
    });

    const result = render(
      <StrictMode>
        <PetView createInteractionController={createInteractionController} />
      </StrictMode>
    );

    expect(createInteractionController).toHaveBeenCalledTimes(2);
    expect(instances[0]?.dispose).toHaveBeenCalledOnce();
    expect(instances[1]?.dispose).not.toHaveBeenCalled();
    result.unmount();
    expect(instances[1]?.dispose).toHaveBeenCalledOnce();
  });

  test('角色表面保留指针终态且恢复控件保持 no-drag', () => {
    const css = readFileSync(
      resolve(import.meta.dirname, '../src/renderer/src/styles.css'),
      'utf8'
    );

    expect(css).not.toMatch(/\.pet-open-chat\b/u);
    expect(css).not.toMatch(/\.pet-shell\s*\{[^}]*-webkit-app-region:\s*drag/su);
    expect(css).toMatch(
      /\.pet-character-surface\s*\{[^}]*-webkit-app-region:\s*no-drag;/su
    );
    expect(css).toMatch(/\.pet-runtime-recovery\s*\{[^}]*-webkit-app-region:\s*no-drag;/su);
  });

  test('备用角色可见区域启动 Main 权威拖拽且不触发聊天', async () => {
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
    fireEvent.pointerMove(shell, { clientX: 20, clientY: 30, pointerId: 7 });
    fireEvent.pointerDown(shell, { clientX: 20, clientY: 30, pointerId: 7, button: 0 });
    fireEvent.pointerMove(shell, { clientX: 30, clientY: 40, pointerId: 7 });
    fireEvent.pointerCancel(shell, { clientX: 30, clientY: 40, pointerId: 7 });
    expect(api.endPetDrag).toHaveBeenCalledOnce();
    fireEvent.mouseUp(shell, { clientX: 30, clientY: 40, button: 0 });
    fireEvent.click(fallback);
    fireEvent.doubleClick(fallback);

    expect(result.container.querySelector('.pet-character-surface')).not.toBeNull();
    expect(api.beginPetDrag).toHaveBeenCalledOnce();
    expect(api.updatePetDrag).toHaveBeenCalledOnce();
    expect(api.endPetDrag).toHaveBeenCalledOnce();
    expect(api.openChat).not.toHaveBeenCalled();
    expect(triggerCharacterPointer).not.toHaveBeenCalled();
  });

  test('卸载时释放命中控制器并恢复安全穿透', async () => {
    const api = createPetViewApi();
    installPetViewBrowserApi(api);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = render(<PetView />);
    await waitFor(() => expect(result.container.querySelector('.pet-character')).not.toBeNull());
    result.unmount();

    await waitFor(() => {
      expect(api.setPetMousePassthrough).toHaveBeenLastCalledWith(true);
    });
  });
});
