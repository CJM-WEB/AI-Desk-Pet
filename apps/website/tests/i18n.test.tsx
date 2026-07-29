// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  I18nProvider,
  interpolateMessage,
  useI18n
} from '../components/i18n/I18nProvider';
import { LanguageMenu } from '../components/i18n/LanguageMenu';
import { en, zhCN } from '../components/i18n/messages';

function Probe() {
  const { locale, t } = useI18n();
  return <output>{locale}:{t('navigation.nextChapter')}</output>;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.lang = '';
});

describe('官网国际化核心', () => {
  it('中英文资源拥有完全相同的键', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
  });

  it('只替换已提供变量并保留缺失变量标记', () => {
    expect(interpolateMessage('你好，{name}，{title}', { name: 'AI Pet' }))
      .toBe('你好，AI Pet，{title}');
  });

  it('首次访问按浏览器语言选择英文并同步根元素 lang', async () => {
    Object.defineProperty(window.navigator, 'language', {
      configurable: true,
      value: 'en-US'
    });
    render(<I18nProvider><Probe /></I18nProvider>);

    await waitFor(() => expect(screen.getByText(/^en:/)).toBeTruthy());
    expect(document.documentElement.lang).toBe('en');
  });

  it('手动选择中文后保存偏好并同步当前会话', async () => {
    render(<I18nProvider><LanguageMenu /><Probe /></I18nProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'language' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '简体中文' }));

    await waitFor(() => expect(screen.getByText(/^zh-CN:/)).toBeTruthy());
    expect(localStorage.getItem('ai-pet-locale')).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('按 Escape 关闭菜单并将焦点返回语言触发器', () => {
    render(<I18nProvider><LanguageMenu /></I18nProvider>);

    const trigger = screen.getByRole('button', { name: 'language' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('在菜单容器外按下指针时关闭菜单', () => {
    render(<I18nProvider><LanguageMenu /></I18nProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'language' }));
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole('menu')).toBeNull();
  });
});
