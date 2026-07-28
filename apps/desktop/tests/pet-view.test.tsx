// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  loadCharacterStartupRecovery,
  PetAnchorOverlays,
  PetOpenChatButton
} from '../src/renderer/src/pet/PetView';
import type { MyselfApi } from '../src/shared/myself-api';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

describe('桌宠单一点击协调器', () => {
  test('单击延迟确认后只打开一次聊天并触发单击语义', () => {
    vi.useFakeTimers();
    const openChat = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { myself: { openChat } });
    const onSingleClick = vi.fn();
    const { getByRole } = render(
      <PetOpenChatButton onSingleClick={onSingleClick}>角色</PetOpenChatButton>
    );

    fireEvent.click(getByRole('button'));
    expect(openChat).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(250));
    expect(openChat).toHaveBeenCalledOnce();
    expect(onSingleClick).toHaveBeenCalledOnce();
  });

  test('双击取消单击语义且只调用一次 openChat', () => {
    vi.useFakeTimers();
    const openChat = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { myself: { openChat } });
    const onSingleClick = vi.fn();
    const onDoubleClick = vi.fn();
    const { getByRole } = render(
      <PetOpenChatButton
        onSingleClick={onSingleClick}
        onDoubleClick={onDoubleClick}
      >
        角色
      </PetOpenChatButton>
    );
    const button = getByRole('button');
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.doubleClick(button);
    act(() => vi.advanceTimersByTime(300));

    expect(openChat).toHaveBeenCalledOnce();
    expect(onSingleClick).not.toHaveBeenCalled();
    expect(onDoubleClick).toHaveBeenCalledOnce();
  });
});
