// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within
} from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';
import { FeedbackChapter } from '../components/website-experience/feedback/FeedbackChapter';
import { FeedbackStorageError } from '../components/website-experience/feedback/local-storage-feedback-repository';
import type {
  FeedbackEntry,
  FeedbackKind,
  FeedbackRepository
} from '../components/website-experience/feedback/feedback-types';

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? '';
  }
}

function createEntry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    id: 'feedback-1',
    kind: 'feedback',
    authorId: 'author-1',
    authorName: '小满',
    content: '希望下一版可以增加更细致的陪伴提醒。',
    likeCount: 8,
    createdAt: '2026-07-20T08:00:00.000Z',
    updatedAt: '2026-07-20T08:00:00.000Z',
    source: 'official-example',
    likedByCurrentBrowser: false,
    ...overrides
  };
}

class TestFeedbackRepository implements FeedbackRepository {
  private readonly listeners = new Set<() => void>();
  private entries: FeedbackEntry[];
  private sequence = 0;

  constructor(entries: readonly FeedbackEntry[]) {
    this.entries = [...entries];
  }

  list(kind: FeedbackKind): readonly FeedbackEntry[] {
    return this.entries.filter((entry) => entry.kind === kind);
  }

  create(input: { kind: FeedbackKind; authorName: string; content: string }): FeedbackEntry {
    this.sequence += 1;
    const entry = createEntry({
      id: `local-${this.sequence}`,
      kind: input.kind,
      authorName: input.authorName.trim() || '匿名用户',
      content: input.content.trim(),
      likeCount: 0,
      source: 'local-user'
    });
    this.entries = [entry, ...this.entries];
    this.emit();
    return entry;
  }

  toggleLike(id: string): FeedbackEntry {
    const target = this.entries.find((entry) => entry.id === id);
    if (!target) throw new Error(`未找到 ${id}`);

    const updated = {
      ...target,
      likedByCurrentBrowser: !target.likedByCurrentBrowser,
      likeCount: target.likeCount + (target.likedByCurrentBrowser ? -1 : 1)
    };
    this.entries = this.entries.map((entry) => (
      entry.id === id ? updated : entry
    ));
    this.emit();
    return updated;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  replace(entries: readonly FeedbackEntry[]) {
    this.entries = [...entries];
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

function createRepository() {
  return new TestFeedbackRepository([
    createEntry({
      id: 'popular',
      authorName: '高赞用户',
      content: '高赞反馈应该出现在第一行。',
      likeCount: 21
    }),
    createEntry({
      id: 'recent',
      authorName: '新反馈用户',
      content: '较新的反馈排在同赞数记录之前。',
      likeCount: 8,
      createdAt: '2026-07-21T08:00:00.000Z'
    }),
    createEntry({
      id: 'suggestion-1',
      kind: 'suggestion',
      authorName: '建议用户',
      content: '建议提供更多主题选择。',
      likeCount: 13
    })
  ]);
}

function openFeedbackDialog(repository: FeedbackRepository) {
  render(<FeedbackChapter interactive repository={repository} />);
  const trigger = screen.getByRole('button', { name: '查看用户反馈' });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

function openComposer(repository: FeedbackRepository) {
  render(<FeedbackChapter interactive repository={repository} />);
  fireEvent.click(screen.getByRole('button', { name: '选择新建投稿' }));
  const trigger = screen.getByRole('button', { name: '新建投稿' });
  fireEvent.click(trigger);
  return trigger;
}

describe('反馈章节', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      value: TestPointerEvent
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('静态渲染倾斜标题、三项反馈操作和局部输入区域', () => {
    const html = renderToStaticMarkup(
      <FeedbackChapter interactive repository={createRepository()} />
    );

    expect(html).toContain('data-testid="feedback-chapter"');
    expect(html).toContain('倾听你的声音，打造属于你的 Pet');
    expect(html).toContain('data-testid="pointer-tilt-text"');
    expect(html.indexOf('用户反馈')).toBeLessThan(html.indexOf('更新建议'));
    expect(html.indexOf('更新建议')).toBeLessThan(html.indexOf('新建投稿'));
    expect(html).toContain('data-input-scope="local"');
  });

  it('滚轮和方向键只切换局部滚筒，非当前项首次点击只选择', () => {
    const outerWheel = vi.fn();
    const outerKeyDown = vi.fn();
    render(
      <div onWheel={outerWheel} onKeyDown={outerKeyDown}>
        <FeedbackChapter interactive repository={createRepository()} />
      </div>
    );
    const roller = screen.getByRole('group', { name: '选择反馈操作' });
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120
    });

    fireEvent(roller, wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(outerWheel).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '查看更新建议' })
      .getAttribute('aria-pressed')).toBe('true');

    fireEvent.keyDown(roller, { key: 'ArrowUp' });
    expect(outerKeyDown).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '查看用户反馈' })
      .getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '选择更新建议' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: '查看更新建议' })
      .getAttribute('aria-pressed')).toBe('true');
  });

  it('触屏拖动只切换一次并抑制紧随其后的合成点击', () => {
    render(<FeedbackChapter interactive repository={createRepository()} />);
    const roller = screen.getByRole('group', { name: '选择反馈操作' });
    const original = screen.getByRole('button', { name: '查看用户反馈' });

    fireEvent.pointerDown(original, {
      clientY: 200,
      pointerId: 7,
      pointerType: 'touch'
    });
    fireEvent.pointerMove(roller, {
      clientY: 150,
      pointerId: 7,
      pointerType: 'touch'
    });
    fireEvent.pointerMove(roller, {
      clientY: 80,
      pointerId: 7,
      pointerType: 'touch'
    });
    fireEvent.pointerUp(roller, {
      clientY: 80,
      pointerId: 7,
      pointerType: 'touch'
    });
    fireEvent.click(original);

    expect(screen.getByRole('button', { name: '查看更新建议' })
      .getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('当前反馈项打开仓储排序列表，点赞可立即切换并取消', () => {
    const repository = createRepository();
    openFeedbackDialog(repository);

    const dialog = screen.getByRole('dialog', { name: '用户反馈' });
    const rows = within(dialog).getAllByTestId('feedback-row');
    expect(rows[0]?.textContent).toContain('高赞用户');
    expect(rows[1]?.textContent).toContain('新反馈用户');

    const like = within(rows[0]!).getByRole('button', {
      name: '点赞高赞用户的反馈'
    });
    expect(like.getAttribute('aria-pressed')).toBe('false');
    expect(like.textContent).toContain('21');

    fireEvent.click(like);
    expect(like.getAttribute('aria-pressed')).toBe('true');
    expect(like.textContent).toContain('22');

    fireEvent.click(like);
    expect(like.getAttribute('aria-pressed')).toBe('false');
    expect(like.textContent).toContain('21');
  });

  it('官方示例仓储只更新点赞标志时仍乐观更新可见计数', () => {
    let entry = createEntry({ id: 'official', likeCount: 8 });
    const repository: FeedbackRepository = {
      list: (kind) => kind === 'feedback' ? [entry] : [],
      create: () => {
        throw new Error('本测试不创建投稿');
      },
      toggleLike: () => {
        entry = {
          ...entry,
          likedByCurrentBrowser: !entry.likedByCurrentBrowser
        };
        return entry;
      },
      subscribe: () => () => undefined
    };
    openFeedbackDialog(repository);
    const like = screen.getByRole('button', { name: '点赞小满的反馈' });

    fireEvent.click(like);
    expect(like.getAttribute('aria-pressed')).toBe('true');
    expect(like.textContent).toContain('9');

    fireEvent.click(like);
    expect(like.getAttribute('aria-pressed')).toBe('false');
    expect(like.textContent).toContain('8');
  });

  it('Portal 聚焦关闭按钮，并由 Escape、遮罩或关闭按钮退出后恢复焦点', () => {
    const repository = createRepository();
    const trigger = openFeedbackDialog(repository);
    const dialog = screen.getByRole('dialog', { name: '用户反馈' });
    const close = screen.getByRole('button', { name: '关闭用户反馈' });

    expect(dialog.parentElement).toBe(document.body);
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId('feedback-dialog-panel'));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    fireEvent.click(screen.getByTestId('feedback-dialog-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: '关闭用户反馈' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('弹层通过 Tab 和 Shift+Tab 将焦点限制在关闭与点赞控件之间', () => {
    openFeedbackDialog(createRepository());
    const close = screen.getByRole('button', { name: '关闭用户反馈' });
    const likes = screen.getAllByRole('button', { name: /点赞.*反馈/ });
    const lastLike = likes.at(-1)!;

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(lastLike);

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
  });

  it('弹层隔离章节输入，列表滚动区保持局部作用域', () => {
    const windowWheel = vi.fn();
    const windowKeyDown = vi.fn();
    const windowPointerDown = vi.fn();
    window.addEventListener('wheel', windowWheel);
    window.addEventListener('keydown', windowKeyDown);
    window.addEventListener('pointerdown', windowPointerDown);

    openFeedbackDialog(createRepository());
    const dialog = screen.getByRole('dialog', { name: '用户反馈' });
    const list = screen.getByRole('list', { name: '用户反馈列表' });
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120
    });

    expect(list.getAttribute('data-input-scope')).toBe('local');
    fireEvent(dialog, wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(windowWheel).not.toHaveBeenCalled();

    for (const key of [
      'PageUp',
      'PageDown',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight'
    ]) {
      fireEvent.keyDown(dialog, { key });
    }
    expect(windowKeyDown).not.toHaveBeenCalled();

    fireEvent.pointerDown(dialog, {
      pointerId: 11,
      pointerType: 'touch'
    });
    expect(windowPointerDown).not.toHaveBeenCalled();

    window.removeEventListener('wheel', windowWheel);
    window.removeEventListener('keydown', windowKeyDown);
    window.removeEventListener('pointerdown', windowPointerDown);
  });

  it('列表内方向键和翻页键保留默认滚动，同时不冒泡到章节', () => {
    const windowKeyDown = vi.fn();
    window.addEventListener('keydown', windowKeyDown);
    openFeedbackDialog(createRepository());
    const list = screen.getByRole('list', { name: '用户反馈列表' });

    for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown']) {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key
      });
      fireEvent(list, event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(windowKeyDown).not.toHaveBeenCalled();

    window.removeEventListener('keydown', windowKeyDown);
  });

  it('仓储订阅会刷新打开列表，状态通知保持非阻断', () => {
    const repository = createRepository();
    Object.assign(repository, {
      getStatusNotice: () => ({
        code: 'STORAGE_DATA_RECOVERED',
        message: '已恢复可用的反馈示例。'
      })
    });
    openFeedbackDialog(repository);

    expect(screen.getByRole('status').textContent)
      .toContain('已恢复可用的反馈示例。');
    act(() => {
      repository.replace([
        createEntry({
          id: 'replacement',
          authorName: '同步用户',
          content: '这是一条来自其他标签页的反馈。',
          likeCount: 30
        })
      ]);
    });

    expect(screen.getByRole('dialog', { name: '用户反馈' }).textContent)
      .toContain('同步用户');
  });

  it('同 ID 条目在仓储订阅刷新后不再使用过期乐观点赞数据', () => {
    const repository = createRepository();
    openFeedbackDialog(repository);
    const originalLike = screen.getByRole('button', {
      name: '点赞高赞用户的反馈'
    });

    fireEvent.click(originalLike);
    expect(originalLike.textContent).toContain('22');
    act(() => {
      repository.replace([
        createEntry({
          id: 'popular',
          authorName: '高赞用户',
          content: '仓储刷新后的同一条反馈。',
          likeCount: 30,
          likedByCurrentBrowser: false
        })
      ]);
    });

    const refreshedLike = screen.getByRole('button', {
      name: '点赞高赞用户的反馈'
    });
    expect(refreshedLike.getAttribute('aria-pressed')).toBe('false');
    expect(refreshedLike.textContent).toContain('30');
  });

  it('新建投稿打开带默认反馈类型的 Portal 编辑器', () => {
    const onCreateRequested = vi.fn();
    render(
      <FeedbackChapter
        interactive
        repository={createRepository()}
        onCreateRequested={onCreateRequested}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '选择新建投稿' }));
    const trigger = screen.getByRole('button', { name: '新建投稿' });
    fireEvent.click(trigger);

    expect(onCreateRequested).toHaveBeenCalledOnce();
    const dialog = screen.getByRole('dialog', { name: '新建投稿' });
    expect(dialog.parentElement).toBe(document.body);
    expect(screen.getByRole('radio', { name: '用户反馈' })
      .getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText('正文'));
  });

  it('编辑器校验正文边界并发布匿名建议后立即打开对应列表', () => {
    const repository = createRepository();
    openComposer(repository);
    const content = screen.getByLabelText('正文');

    expect(screen.getByLabelText('昵称（可选）').getAttribute('maxlength')).toBe('24');
    fireEvent.change(content, { target: { value: '短内容' } });
    fireEvent.click(screen.getByRole('button', { name: '发布投稿' }));
    expect(screen.getByRole('alert').textContent).toContain('至少需要 10 个字符');
    expect(content.getAttribute('aria-describedby')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: '更新建议' }));
    fireEvent.change(screen.getByLabelText('昵称（可选）'), { target: { value: '   ' } });
    fireEvent.change(content, { target: { value: 'a'.repeat(1000) } });
    expect(screen.getByText('1000/1000')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '发布投稿' }));

    const dialog = screen.getByRole('dialog', { name: '更新建议' });
    expect(dialog.textContent).toContain('匿名用户');
    expect(dialog.textContent).toContain('a'.repeat(1000));
    expect(screen.queryByRole('dialog', { name: '新建投稿' })).toBeNull();
  });

  it('发布时先进入禁用提交态，并且仅创建一次投稿', () => {
    const repository = createRepository();
    const createEntryFromRepository = repository.create.bind(repository);
    let createObservedSubmitting = false;
    repository.create = vi.fn((input) => {
      const publish = screen.getByRole('button', { name: '正在发布' });
      createObservedSubmitting = (publish as HTMLButtonElement).disabled
        && (screen.getByLabelText('正文') as HTMLTextAreaElement).disabled;
      return createEntryFromRepository(input);
    });

    openComposer(repository);
    fireEvent.change(screen.getByLabelText('正文'), {
      target: { value: '这是一段用于验证提交状态机转换的正文内容。' }
    });
    fireEvent.click(screen.getByRole('button', { name: '发布投稿' }));

    expect(createObservedSubmitting).toBe(true);
    expect(repository.create).toHaveBeenCalledOnce();
  });

  it('写入失败时保留草稿、类型与 Portal 并在正文旁显示错误', () => {
    const repository: FeedbackRepository = Object.assign(createRepository(), {
      create: () => {
        throw new FeedbackStorageError('WRITE_FAILED');
      }
    });
    openComposer(repository);
    const content = screen.getByLabelText('正文');
    fireEvent.click(screen.getByRole('radio', { name: '更新建议' }));
    fireEvent.change(screen.getByLabelText('昵称（可选）'), { target: { value: '保留昵称' } });
    fireEvent.change(content, { target: { value: '这是一段用于验证保稿行为的正文内容。' } });
    fireEvent.click(screen.getByRole('button', { name: '发布投稿' }));

    expect(screen.getByRole('dialog', { name: '新建投稿' }).parentElement).toBe(document.body);
    expect(screen.getByRole('radio', { name: '更新建议' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByLabelText('昵称（可选）')).toHaveProperty('value', '保留昵称');
    expect(content).toHaveProperty('value', '这是一段用于验证保稿行为的正文内容。');
    expect(screen.getByRole('alert').textContent)
      .toBe('投稿暂时无法保存，请稍后重试。');
  });

  it('本地存储不可用时保留草稿并显示不可保存提示', () => {
    const repository: FeedbackRepository = Object.assign(createRepository(), {
      create: () => {
        throw new FeedbackStorageError('STORAGE_UNAVAILABLE');
      }
    });
    openComposer(repository);
    const content = screen.getByLabelText('正文');
    fireEvent.change(screen.getByLabelText('昵称（可选）'), { target: { value: '保留昵称' } });
    fireEvent.change(content, { target: { value: '这是一段用于验证本地存储不可用行为的正文内容。' } });
    fireEvent.click(screen.getByRole('button', { name: '发布投稿' }));

    expect(screen.getByRole('dialog', { name: '新建投稿' }).parentElement).toBe(document.body);
    expect(screen.getByLabelText('昵称（可选）')).toHaveProperty('value', '保留昵称');
    expect(content).toHaveProperty('value', '这是一段用于验证本地存储不可用行为的正文内容。');
    expect(screen.getByRole('alert').textContent)
      .toBe('浏览器本地存储不可用，投稿无法保存。');
  });

  it('草稿退出均经确认且继续编辑恢复焦点、确认放弃恢复入口焦点', async () => {
    const trigger = openComposer(createRepository());
    const backdrop = screen.getByTestId('feedback-composer-backdrop');

    fireEvent.click(backdrop);
    expect(screen.queryByRole('dialog', { name: '新建投稿' })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText('正文'), { target: { value: '这是一段尚未发布的草稿内容。' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByRole('dialog', { name: '放弃未发布内容？' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('discard-draft-backdrop'));
    expect(screen.getByRole('dialog', { name: '放弃未发布内容？' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(document.activeElement).toBe(screen.getByLabelText('正文'));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '放弃未发布内容？' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    fireEvent.click(screen.getByTestId('feedback-composer-backdrop'));
    expect(screen.getByRole('dialog', { name: '放弃未发布内容？' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认放弃' }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('编辑器隔离章节键盘、滚轮与触控输入，并在顶层循环焦点', () => {
    const windowKeyDown = vi.fn();
    const windowWheel = vi.fn();
    const windowPointerDown = vi.fn();
    window.addEventListener('keydown', windowKeyDown);
    window.addEventListener('wheel', windowWheel);
    window.addEventListener('pointerdown', windowPointerDown);
    openComposer(createRepository());
    const dialog = screen.getByRole('dialog', { name: '新建投稿' });
    const content = screen.getByLabelText('正文');
    const publish = screen.getByRole('button', { name: '发布投稿' });

    fireEvent.keyDown(content, { key: 'ArrowDown' });
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
    fireEvent(dialog, wheel);
    fireEvent.pointerDown(dialog, { pointerId: 13, pointerType: 'touch' });
    expect(wheel.defaultPrevented).toBe(false);
    expect(windowKeyDown).not.toHaveBeenCalled();
    expect(windowWheel).not.toHaveBeenCalled();
    expect(windowPointerDown).not.toHaveBeenCalled();

    publish.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消投稿' }));
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(publish);
    window.removeEventListener('keydown', windowKeyDown);
    window.removeEventListener('wheel', windowWheel);
    window.removeEventListener('pointerdown', windowPointerDown);
  });
});
