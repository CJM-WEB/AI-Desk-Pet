// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../components/i18n/I18nProvider';
import {
  SharedPetComposerDialog,
  type SharedPetDraft
} from '../components/website-experience/community/SharedPetComposerDialog';
import { SharedPetDetailDialog } from '../components/website-experience/community/SharedPetDetailDialog';
import { SharedPetDialogShell } from '../components/website-experience/community/SharedPetDialogShell';
import { useObjectUrl } from '../components/website-experience/community/use-object-url';
import type { SharedPetPackageSummary } from '../components/website-experience/community/shared-pet-types';

const item: SharedPetPackageSummary = {
  id: 'pet-1',
  name: 'My Pet',
  description: 'My package',
  packageFileName: 'my-pet.zip',
  packageSizeBytes: 2_048,
  coverFileName: 'cover.png',
  coverMimeType: 'image/png',
  coverSizeBytes: 512,
  coverFile: new Blob(['cover'], { type: 'image/png' }),
  likeCount: 12,
  downloadCount: 34,
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
  likedByCurrentUser: false
};

function ObjectUrlProbe({ blob }: { blob: Blob | null }) {
  const url = useObjectUrl(blob);
  return <output>{url ?? 'empty'}</output>;
}

function ComposerHarness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  return open ? (
    <I18nProvider initialLocale="zh-CN">
      <SharedPetComposerDialog
        onSubmit={vi.fn()}
        onRequestClose={() => {
          onClose();
          setOpen(false);
        }}
      />
    </I18nProvider>
  ) : null;
}

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:cover')
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn()
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('共享包弹窗', () => {
  it('提交完整 ZIP、封面、名称和描述', async () => {
    const onSubmit = vi.fn();
    render(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetComposerDialog onSubmit={onSubmit} onRequestClose={vi.fn()} />
      </I18nProvider>
    );

    const packageFile = new File(['zip'], 'pet.zip', { type: 'application/zip' });
    const coverFile = new File(['image'], 'cover.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('AI Pet ZIP 文件'), {
      target: { files: [packageFile] }
    });
    fireEvent.change(screen.getByLabelText('封面图片'), {
      target: { files: [coverFile] }
    });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: ' My Pet ' } });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: ' My package ' } });
    fireEvent.click(screen.getByRole('button', { name: '发布分享' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      packageFile,
      coverFile,
      name: 'My Pet',
      description: 'My package'
    } satisfies SharedPetDraft);
  });

  it('校验失败时保留已选文件和文本并展示本地化错误', () => {
    render(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetComposerDialog onSubmit={vi.fn()} onRequestClose={vi.fn()} />
      </I18nProvider>
    );

    const packageInput = screen.getByLabelText('AI Pet ZIP 文件') as HTMLInputElement;
    const coverInput = screen.getByLabelText('封面图片') as HTMLInputElement;
    fireEvent.change(packageInput, {
      target: { files: [new File(['zip'], 'pet.txt', { type: 'text/plain' })] }
    });
    fireEvent.change(coverInput, {
      target: { files: [new File(['image'], 'cover.png', { type: 'image/png' })] }
    });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '保留名称' } });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '保留描述' } });
    fireEvent.click(screen.getByRole('button', { name: '发布分享' }));

    expect(screen.getByRole('alert').textContent).toContain('ZIP');
    expect(packageInput.files?.[0]?.name).toBe('pet.txt');
    expect(coverInput.files?.[0]?.name).toBe('cover.png');
    expect(screen.getByLabelText('名称')).toHaveProperty('value', '保留名称');
    expect(screen.getByLabelText('描述')).toHaveProperty('value', '保留描述');
  });

  it('异步提交期间禁用关闭和再次提交', async () => {
    let resolveSubmit: (() => void) | undefined;
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => {
      resolveSubmit = resolve;
    }));
    render(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetComposerDialog onSubmit={onSubmit} onRequestClose={vi.fn()} />
      </I18nProvider>
    );

    fireEvent.change(screen.getByLabelText('AI Pet ZIP 文件'), {
      target: { files: [new File(['zip'], 'pet.zip', { type: 'application/zip' })] }
    });
    fireEvent.change(screen.getByLabelText('封面图片'), {
      target: { files: [new File(['image'], 'cover.png', { type: 'image/png' })] }
    });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'My Pet' } });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: 'My package' } });
    fireEvent.click(screen.getByRole('button', { name: '发布分享' }));

    expect((screen.getByRole('button', { name: '正在发布' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '取消分享' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '关闭分享投稿' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolveSubmit?.());
  });

  it('提交状态变化不会把焦点恢复到弹窗外', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    render(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetComposerDialog
          onSubmit={() => new Promise<void>(() => undefined)}
          onRequestClose={vi.fn()}
        />
      </I18nProvider>
    );

    fireEvent.change(screen.getByLabelText('AI Pet ZIP 文件'), {
      target: { files: [new File(['zip'], 'pet.zip', { type: 'application/zip' })] }
    });
    fireEvent.change(screen.getByLabelText('封面图片'), {
      target: { files: [new File(['image'], 'cover.png', { type: 'image/png' })] }
    });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'My Pet' } });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: 'My package' } });
    const submit = screen.getByRole('button', { name: '发布分享' });
    submit.focus();
    fireEvent.click(submit);

    const dialog = screen.getByRole('dialog', { name: '分享投稿' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    trigger.remove();
  });

  it('没有可聚焦控件时聚焦面板本身', () => {
    render(
      <SharedPetDialogShell
        title="只读内容"
        closeLabel="关闭"
        dismissDisabled
        onRequestClose={vi.fn()}
      >
        <p>内容</p>
      </SharedPetDialogShell>
    );

    const panel = document.querySelector<HTMLElement>('[data-shared-pet-dialog-panel]');
    expect(panel?.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(panel);
  });

  it('ZIP 和名称错误仅标记对应字段并关联错误说明', () => {
    const { rerender } = render(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetComposerDialog onSubmit={vi.fn()} onRequestClose={vi.fn()} />
      </I18nProvider>
    );

    fireEvent.change(screen.getByLabelText('AI Pet ZIP 文件'), {
      target: { files: [new File(['zip'], 'pet.txt', { type: 'text/plain' })] }
    });
    fireEvent.click(screen.getByRole('button', { name: '发布分享' }));
    const packageInput = screen.getByLabelText('AI Pet ZIP 文件');
    expect(packageInput.getAttribute('aria-invalid')).toBe('true');
    expect(packageInput.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
    expect(screen.getByLabelText('描述').getAttribute('aria-invalid')).toBeNull();

    rerender(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetComposerDialog onSubmit={vi.fn()} onRequestClose={vi.fn()} />
      </I18nProvider>
    );
    fireEvent.change(screen.getByLabelText('AI Pet ZIP 文件'), {
      target: { files: [new File(['zip'], 'pet.zip', { type: 'application/zip' })] }
    });
    fireEvent.change(screen.getByLabelText('封面图片'), {
      target: { files: [new File(['image'], 'cover.png', { type: 'image/png' })] }
    });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '有效描述' } });
    fireEvent.click(screen.getByRole('button', { name: '发布分享' }));
    const nameInput = screen.getByLabelText('名称');
    expect(nameInput.getAttribute('aria-invalid')).toBe('true');
    expect(nameInput.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
    expect(screen.getByLabelText('封面图片').getAttribute('aria-invalid')).toBeNull();
  });

  it('ZIP、封面、名称和描述错误分别显示在对应字段附近且不重复', () => {
    render(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetComposerDialog onSubmit={vi.fn()} onRequestClose={vi.fn()} />
      </I18nProvider>
    );
    const submit = screen.getByRole('button', { name: '发布分享' });
    const packageInput = screen.getByLabelText('AI Pet ZIP 文件');
    const coverInput = screen.getByLabelText('封面图片');
    const nameInput = screen.getByLabelText('名称');
    const descriptionInput = screen.getByLabelText('描述');
    const expectErrorBeside = (field: HTMLElement) => {
      const alert = screen.getByRole('alert');
      expect(field.parentElement?.contains(alert)).toBe(true);
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(field.getAttribute('aria-describedby')).toBe(alert.id);
    };

    fireEvent.click(submit);
    expectErrorBeside(packageInput);
    fireEvent.change(packageInput, {
      target: { files: [new File(['zip'], 'pet.zip', { type: 'application/zip' })] }
    });
    fireEvent.click(submit);
    expectErrorBeside(coverInput);
    fireEvent.change(coverInput, {
      target: { files: [new File(['image'], 'cover.png', { type: 'image/png' })] }
    });
    fireEvent.click(submit);
    expectErrorBeside(nameInput);
    fireEvent.change(nameInput, { target: { value: 'My Pet' } });
    fireEvent.click(submit);
    expectErrorBeside(descriptionInput);
  });

  it('Portal 隔离滚轮并通过 Escape、焦点循环恢复入口焦点', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    render(<ComposerHarness onClose={onClose} />);

    const dialog = screen.getByRole('dialog', { name: '分享投稿' });
    const close = screen.getByRole('button', { name: '关闭分享投稿' });
    const submit = screen.getByRole('button', { name: '发布分享' });
    expect(dialog.parentElement).toBe(document.body);
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(submit);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    const windowWheel = vi.fn();
    window.addEventListener('wheel', windowWheel);
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true });
    fireEvent(dialog, wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(windowWheel).not.toHaveBeenCalled();
    window.removeEventListener('wheel', windowWheel);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('详情隐藏原始文件名并依次显示日期、大小、下载数和点赞数', () => {
    render(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetDetailDialog
          item={item}
          downloadDisabled={false}
          onDownload={vi.fn()}
          onRequestClose={vi.fn()}
        />
      </I18nProvider>
    );

    const dialog = screen.getByRole('dialog', { name: 'My Pet' });
    expect(dialog.textContent).not.toContain('my-pet.zip');
    expect(dialog.textContent).not.toContain('原始文件名');
    expect(Array.from(dialog.querySelectorAll('dt'), node => node.textContent))
      .toEqual(['发布时间', '文件大小', '下载次数', '点赞数']);
    expect(dialog.textContent).toContain('2 KB');
    expect(dialog.textContent).toContain('12');
    expect(dialog.textContent).toContain('34');
    expect(dialog.textContent).toContain('2026');
  });

  it('详情将 1 MiB 格式化为 MB', () => {
    render(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetDetailDialog
          item={{ ...item, packageSizeBytes: 1024 * 1024 }}
          downloadDisabled={false}
          onDownload={vi.fn()}
          onRequestClose={vi.fn()}
        />
      </I18nProvider>
    );

    expect(screen.getByRole('dialog', { name: 'My Pet' }).textContent).toContain('1 MB');
  });

  it('管理员人工放行的详情与下载入口均不显示风险提示', () => {
    render(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetDetailDialog
          item={{ ...item, publicationBasis: 'admin_override' } as SharedPetPackageSummary & { publicationBasis: 'admin_override' }}
          downloadDisabled={false}
          onDownload={vi.fn()}
          onRequestClose={vi.fn()}
        />
      </I18nProvider>
    );

    expect(screen.queryByRole('note', { name: '详情风险提示' })).toBeNull();
    expect(screen.queryByRole('note', { name: '下载风险提示' })).toBeNull();
  });

  it('标准发布详情不显示管理员人工放行提示', () => {
    render(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetDetailDialog
          item={{ ...item, publicationBasis: 'standard' } as SharedPetPackageSummary & { publicationBasis: 'standard' }}
          downloadDisabled={false}
          onDownload={vi.fn()}
          onRequestClose={vi.fn()}
        />
      </I18nProvider>
    );

    expect(screen.queryByText('管理员人工放行，未通过系统安全验证')).toBeNull();
  });

  it('云端封面缺少文件名时使用安全替代文本，不泄露签名查询参数', () => {
    const { coverFile: _coverFile, coverFileName: _coverFileName, ...cloudItem } = item;
    render(
      <I18nProvider initialLocale="zh-CN">
        <SharedPetDetailDialog
          item={{ ...cloudItem, coverUrl: 'https://storage.example/cover?signature=secret' }}
          downloadDisabled={false}
          onDownload={vi.fn()}
          onRequestClose={vi.fn()}
        />
      </I18nProvider>
    );
    expect(screen.getByRole('img').getAttribute('alt')).toBe('共享包封面');
  });

  it('对象 URL 在 Blob 变更和卸载时释放', () => {
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

    const first = new Blob(['first']);
    const second = new Blob(['second']);
    const view = render(<ObjectUrlProbe blob={first} />);
    expect(screen.getByRole('status').textContent).toBe('blob:first');

    view.rerender(<ObjectUrlProbe blob={second} />);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:first');
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:second');
  });
});
