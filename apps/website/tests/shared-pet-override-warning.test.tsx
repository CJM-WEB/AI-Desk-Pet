// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../components/i18n/I18nProvider';
import { SharedPetOverrideWarning } from '../components/website-experience/community/SharedPetOverrideWarning';

afterEach(cleanup);

describe('共享包人工放行风险提示', () => {
  it('使用调用方标签呈现固定警告结构与文案', () => {
    render(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetOverrideWarning ariaLabel="详情风险提示" />
      </I18nProvider>
    );

    const warning = screen.getByRole('note', { name: '详情风险提示' });
    expect(warning.querySelector('strong')?.textContent).toBe('风险提示');
    expect(warning.querySelector('span')?.textContent).toBe('管理员人工放行，未通过系统安全验证');
  });
});
