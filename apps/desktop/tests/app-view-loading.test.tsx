// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { MyselfApi } from '../src/shared/myself-api';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const state = vi.hoisted(() => ({
  loaded: [] as string[],
  props: {} as Record<string, Record<string, unknown>>,
  mount: vi.fn(),
  unmount: vi.fn()
}));

// 模块工厂只在视图模块真正求值时记录，避免把组件未挂载误当作模块未加载。
function registerViewMocks() {
  vi.doMock('../src/renderer/src/chat/ChatBubbleView', () => {
    state.loaded.push('bubble');
    return { ChatBubbleView: (props: Record<string, unknown>) => {
      state.props.bubble = props;
      return <div data-testid="bubble" />;
    } };
  });
  vi.doMock('../src/renderer/src/chat/ChatPanel', () => {
    state.loaded.push('chat');
    return { ChatPanel: (props: Record<string, unknown>) => {
      state.props.chat = props;
      return <div data-testid="chat" />;
    } };
  });
  vi.doMock('../src/renderer/src/pet/PetView', () => {
    state.loaded.push('pet');
    return { PetView: (props: Record<string, unknown>) => {
      state.props.pet = props;
      return <div data-testid="pet" />;
    } };
  });
  vi.doMock('../src/renderer/src/settings/SettingsView', () => {
    state.loaded.push('settings');
    return { SettingsView: (props: Record<string, unknown>) => {
      state.props.settings = props;
      return <div data-testid="settings" />;
    } };
  });
  vi.doMock('../src/renderer/src/characters/workshop/CharacterWorkshopView', () => {
    state.loaded.push('characters');
    return { CharacterWorkshopView: (props: Record<string, unknown>) => {
      state.props.characters = props;
      return <div data-testid="characters" />;
    } };
  });
}
vi.mock('../src/renderer/src/stores/task-store', () => ({
  taskEventSubscription: { mount: state.mount }
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  window.history.replaceState({}, '', '/');
  Object.defineProperty(window, 'myself', { configurable: true, value: undefined });
});

describe('当前窗口视图按需加载', () => {
  test('气泡独立入口保留聊天表现样式依赖', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/renderer/src/chat/ChatBubbleView.tsx'), 'utf8');
    expect(source).toMatch(/import\s+['"]\.\/chat-presentation\.css['"]/);
  });
  test.each(['bubble', 'chat', 'pet', 'settings', 'characters'])(
    '%s 只求值当前视图并保留 props 与订阅清理契约', async view => {
      vi.resetModules();
      state.loaded.length = 0;
      state.props = {};
      registerViewMocks();
      state.mount.mockReturnValue(state.unmount);
      const api = {} as MyselfApi;
      Object.defineProperty(window, 'myself', { configurable: true, value: api });
      window.history.replaceState({}, '', `/?view=${view}`);
      const { App, currentView } = await import('../src/renderer/src/App');
      expect(currentView()).toBe(view);
      const rendered = render(<App />);
      expect(await screen.findByTestId(view)).toBeTruthy();
      expect(state.loaded).toEqual([view]);
      expect(state.props[view]).toEqual(view === 'characters' ? { api } : {});
      expect(document.body.textContent).toBe('');
      if (view === 'bubble') {
        expect(state.mount).not.toHaveBeenCalled();
      } else {
        expect(state.mount).toHaveBeenCalledExactlyOnceWith(api, view === 'chat');
      }
      rendered.unmount();
      expect(state.unmount).toHaveBeenCalledTimes(view === 'bubble' ? 0 : 1);
    }
  );
});
