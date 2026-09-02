// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIQUID_GLASS_RIPPLE_EVENT } from '../components/home-experience/LiquidGlassHome';
import { I18nProvider } from '../components/i18n/I18nProvider';
import { SharedPetCard } from '../components/website-experience/community/SharedPetCard';
import type { SharedPetPackageSummary } from '../components/website-experience/community/shared-pet-types';

const ITEM: SharedPetPackageSummary = {
  id: 'pet-ripple',
  name: 'Ripple Pet',
  description: 'Ripple test',
  packageFileName: 'pet.zip',
  packageSizeBytes: 2048,
  likeCount: 1,
  downloadCount: 2,
  createdAt: '2026-08-07T00:00:00.000Z',
  updatedAt: '2026-08-07T00:00:00.000Z',
  likedByCurrentUser: false,
  publicationBasis: 'standard'
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('共享仓库水波纹契约', () => {
  it('卡片主体触发水波纹，点赞与下载胶囊不触发', () => {
    const onRipple = vi.fn();
    window.addEventListener(LIQUID_GLASS_RIPPLE_EVENT, onRipple);
    const { container } = render(
      <I18nProvider initialLocale="en">
        <SharedPetCard
          item={ITEM}
          onOpen={vi.fn()}
          onLike={vi.fn()}
          onDownload={vi.fn()}
        />
      </I18nProvider>
    );

    fireEvent.pointerDown(container.querySelector('article')!, {
      clientX: 120,
      clientY: 180
    });
    expect(onRipple).toHaveBeenCalledTimes(1);
    expect((onRipple.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      clientX: 120,
      clientY: 180,
      strength: 1.35
    });

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Like Ripple Pet' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Download Ripple Pet' }));
    expect(onRipple).toHaveBeenCalledTimes(1);
    window.removeEventListener(LIQUID_GLASS_RIPPLE_EVENT, onRipple);
  });
});
