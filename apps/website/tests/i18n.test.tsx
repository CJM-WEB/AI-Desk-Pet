// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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

let navigatorLanguageDescriptor: PropertyDescriptor | undefined;

beforeAll(() => {
  navigatorLanguageDescriptor = Object.getOwnPropertyDescriptor(
    window.navigator,
    'language'
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.lang = '';
  if (navigatorLanguageDescriptor) {
    Object.defineProperty(window.navigator, 'language', navigatorLanguageDescriptor);
  } else {
    Reflect.deleteProperty(window.navigator, 'language');
  }
});

describe('官网国际化核心', () => {
  it('中英文资源键集一致且所有文本均非空', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
    expect(Object.values(en).every((value) => value.trim().length > 0)).toBe(true);
    expect(Object.values(zhCN).every((value) => value.trim().length > 0)).toBe(true);
    expect(zhCN['sharedPet.chapter.title']).toBe('AI Pet 共享仓库');
    expect(zhCN['sharedPet.chapter.upload']).toBe('分享您的 AI Pet');
    expect(en['sharedPet.chapter.title']).toBe('AI Pet Community');
    expect(en['sharedPet.chapter.upload']).toBe('Share Your AI Pet');
    expect(zhCN['sharedPet.submission.received']).toBe('投稿已收到，正在等待人工审核。');
    expect(zhCN['feedback.submission.received']).toBe('投稿已收到，正在等待人工审核。');
    expect(en['sharedPet.submission.received']).toBe('Submission received and awaiting manual review.');
    expect(en['feedback.submission.received']).toBe('Submission received and awaiting manual review.');
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

  it('预置英文偏好在中文浏览器语言下重新挂载后仍优先使用英文', async () => {
    Object.defineProperty(window.navigator, 'language', {
      configurable: true,
      value: 'zh-CN'
    });
    localStorage.setItem('ai-pet-locale', 'en');
    const firstMount = render(<I18nProvider><Probe /></I18nProvider>);

    await waitFor(() => expect(screen.getByText(/^en:/)).toBeTruthy());
    firstMount.unmount();
    render(<I18nProvider><Probe /></I18nProvider>);

    await waitFor(() => expect(screen.getByText(/^en:/)).toBeTruthy());
    expect(document.documentElement.lang).toBe('en');
  });

  it('非法存储值回退到浏览器语言', async () => {
    Object.defineProperty(window.navigator, 'language', {
      configurable: true,
      value: 'zh-CN'
    });
    localStorage.setItem('ai-pet-locale', 'invalid-locale');

    render(<I18nProvider><Probe /></I18nProvider>);

    await waitFor(() => expect(screen.getByText(/^zh-CN:/)).toBeTruthy());
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('选择语言后关闭菜单并将焦点返回语言触发器', () => {
    render(<I18nProvider><LanguageMenu /></I18nProvider>);

    const trigger = screen.getByRole('button', { name: 'language' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'English' }));

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('方向键和首尾键在语言选项间循环移动焦点', () => {
    render(<I18nProvider><LanguageMenu /></I18nProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'language' }));
    const options = screen.getAllByRole('menuitemradio');
    options[0]!.focus();

    fireEvent.keyDown(options[0]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(options[0]!, { key: 'End' });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1]!, { key: 'Home' });
    expect(document.activeElement).toBe(options[0]);
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
