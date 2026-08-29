// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MyselfApi } from '../src/shared/myself-api';
import type { WorkshopLayoutSettings } from '../src/shared/workshop-layout-ipc';
import { CharacterWorkshopView } from '../src/renderer/src/characters/workshop/CharacterWorkshopView';
import { WorkshopSplitter } from '../src/renderer/src/characters/workshop/WorkshopSplitter';
import {
  clampWorkshopLayout,
  preferredWorkshopLayoutForRenderedWidth
} from '../src/renderer/src/characters/workshop/workshop-layout';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('角色工作台布局收敛', () => {
  test.each([
    { bounds: { width: 1_920, height: 1_080 } },
    { bounds: { width: 1_280, height: 720 } }
  ])('$bounds.width×$bounds.height 保持默认桌面布局不变', ({ bounds }) => {
    expect(clampWorkshopLayout({
      leftWidth: 300,
      rightWidth: 300,
      sidebarTopHeight: 290,
      stageHeight: 460
    }, bounds)).toEqual({
      leftWidth: 300,
      rightWidth: 300,
      sidebarTopHeight: 290,
      stageHeight: 460
    });
  });

  test('桌面宽度按两侧剩余空间等比例收敛并限制纵向轨道', () => {
    expect(clampWorkshopLayout({
      leftWidth: 900,
      rightWidth: 900,
      sidebarTopHeight: 700,
      stageHeight: 700
    }, { width: 1_280, height: 720 })).toEqual({
      leftWidth: 442,
      rightWidth: 442,
      sidebarTopHeight: 492,
      stageHeight: 512
    });
  });

  test('窄屏只规范持久值而不按堆叠尺寸覆盖桌面偏好', () => {
    expect(clampWorkshopLayout({
      leftWidth: 360.4,
      rightWidth: 340.6,
      sidebarTopHeight: 310.2,
      stageHeight: 480.8
    }, { width: 900, height: 519 })).toEqual({
      leftWidth: 360,
      rightWidth: 341,
      sidebarTopHeight: 310,
      stageHeight: 481
    });
  });

  test('非法尺寸与极小边界仍返回有限正整数', () => {
    const result = clampWorkshopLayout({
      leftWidth: Number.NaN,
      rightWidth: Number.POSITIVE_INFINITY,
      sidebarTopHeight: -10,
      stageHeight: 0
    }, { width: Number.NaN, height: -1 });

    expect(result).toEqual({
      leftWidth: 300,
      rightWidth: 300,
      sidebarTopHeight: 220,
      stageHeight: 280
    });
  });

  test.each([
    { key: 'leftWidth' as const, target: 388, preservedKey: 'rightWidth' as const, preserved: 600 },
    { key: 'rightWidth' as const, target: 320, preservedKey: 'leftWidth' as const, preserved: 900 }
  ])('反解 $key 的 rendered 目标且不覆盖另一侧 preferred', ({
    key, target, preservedKey, preserved
  }) => {
    const preferred = preferredWorkshopLayoutForRenderedWidth({
      leftWidth: 900,
      rightWidth: 600,
      sidebarTopHeight: 300,
      stageHeight: 470
    }, { width: 1_120, height: 659 }, key, target);

    expect(preferred[preservedKey]).toBe(preserved);
    expect(preferred[key]).toBeGreaterThanOrEqual(1);
    expect(preferred[key]).toBeLessThanOrEqual(4_096);
    expect(Number.isInteger(preferred[key])).toBe(true);
    expect(clampWorkshopLayout(preferred, { width: 1_120, height: 659 })[key]).toBe(target);
  });
});

function SplitterHarness(props: {
  orientation?: 'horizontal' | 'vertical';
  initial?: number;
  min?: number;
  max?: number;
  direction?: 1 | -1;
  onCommit?: (value: number) => void;
}) {
  const [value, setValue] = useState(props.initial ?? 300);
  return (
    <WorkshopSplitter
      label="调整测试区域"
      orientation={props.orientation ?? 'vertical'}
      value={value}
      min={props.min ?? 250}
      max={props.max ?? 500}
      {...(props.direction === undefined ? {} : { valueDirection: props.direction })}
      onChange={setValue}
      onCommit={props.onCommit ?? (() => undefined)}
    />
  );
}

function pointerCaptureDouble(element: HTMLElement) {
  const captured = new Set<number>();
  const setPointerCapture = vi.fn((pointerId: number) => captured.add(pointerId));
  const releasePointerCapture = vi.fn((pointerId: number) => captured.delete(pointerId));
  Object.assign(element, {
    setPointerCapture,
    releasePointerCapture,
    hasPointerCapture: (pointerId: number) => captured.has(pointerId)
  });
  return { setPointerCapture, releasePointerCapture };
}

describe('角色工作台分隔器', () => {
  test('真实指针捕获期间只更新值，释放时才提交最终值', () => {
    const onCommit = vi.fn();
    render(<SplitterHarness onCommit={onCommit} />);
    const splitter = screen.getByRole('separator', { name: '调整测试区域' });
    const capture = pointerCaptureDouble(splitter);

    fireEvent.pointerDown(splitter, { pointerId: 7, clientX: 100, clientY: 20 });
    fireEvent.pointerMove(splitter, { pointerId: 7, clientX: 148, clientY: 20 });

    expect(splitter.getAttribute('aria-valuenow')).toBe('348');
    expect(capture.setPointerCapture).toHaveBeenCalledWith(7);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(splitter, { pointerId: 7, clientX: 148, clientY: 20 });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(348);
    expect(capture.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  test('方向键按 8px 或 Shift 32px 调整、收敛并同步 ARIA', () => {
    const onCommit = vi.fn();
    render(<SplitterHarness initial={492} onCommit={onCommit} />);
    const splitter = screen.getByRole('separator', { name: '调整测试区域' });

    fireEvent.keyDown(splitter, { key: 'ArrowRight' });
    expect(splitter.getAttribute('aria-valuenow')).toBe('500');
    expect(onCommit).toHaveBeenLastCalledWith(500);

    fireEvent.keyDown(splitter, { key: 'ArrowLeft', shiftKey: true });
    expect(splitter.getAttribute('aria-valuenow')).toBe('468');
    expect(onCommit).toHaveBeenLastCalledWith(468);
    expect(splitter.getAttribute('aria-orientation')).toBe('vertical');
  });

  test('右侧分隔器的键盘与指针都按分隔线空间方向映射', () => {
    const onCommit = vi.fn();
    render(<SplitterHarness initial={300} direction={-1} onCommit={onCommit} />);
    const splitter = screen.getByRole('separator', { name: '调整测试区域' });
    pointerCaptureDouble(splitter);

    fireEvent.keyDown(splitter, { key: 'ArrowRight' });
    expect(splitter.getAttribute('aria-valuenow')).toBe('292');
    expect(onCommit).toHaveBeenLastCalledWith(292);

    fireEvent.keyDown(splitter, { key: 'ArrowLeft' });
    expect(splitter.getAttribute('aria-valuenow')).toBe('300');
    fireEvent.keyDown(splitter, { key: 'ArrowLeft', shiftKey: true });
    expect(splitter.getAttribute('aria-valuenow')).toBe('332');
    expect(onCommit).toHaveBeenLastCalledWith(332);

    fireEvent.pointerDown(splitter, { pointerId: 11, clientX: 100, clientY: 20 });
    fireEvent.pointerUp(splitter, { pointerId: 11, clientX: 108, clientY: 20 });
    expect(splitter.getAttribute('aria-valuenow')).toBe('324');
    expect(onCommit).toHaveBeenLastCalledWith(324);
  });

  test('错误 pointerId、无关方向键和重复收口均不产生提交', () => {
    const onCommit = vi.fn();
    render(<SplitterHarness orientation="horizontal" onCommit={onCommit} />);
    const splitter = screen.getByRole('separator', { name: '调整测试区域' });
    pointerCaptureDouble(splitter);

    fireEvent.pointerDown(splitter, { pointerId: 4, clientX: 10, clientY: 100 });
    fireEvent.pointerMove(splitter, { pointerId: 5, clientX: 10, clientY: 160 });
    fireEvent.pointerUp(splitter, { pointerId: 5, clientX: 10, clientY: 160 });
    fireEvent.keyDown(splitter, { key: 'ArrowRight' });
    expect(splitter.getAttribute('aria-valuenow')).toBe('300');
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerCancel(splitter, { pointerId: 4, clientX: 10, clientY: 132 });
    fireEvent.lostPointerCapture(splitter, { pointerId: 4 });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(332);
  });
});

type ViewApi = Parameters<typeof CharacterWorkshopView>[0]['api'] & Pick<
  MyselfApi,
  'getWorkshopLayout' | 'saveWorkshopLayout'
>;

function viewApi(overrides: Partial<ViewApi> = {}): ViewApi {
  return {
    listCharacters: vi.fn(async () => []),
    createCharacter: vi.fn(),
    duplicateCharacter: vi.fn(),
    getCharacterDraft: vi.fn(),
    listCharacterSources: vi.fn(async () => []),
    saveCharacterDraft: vi.fn(),
    chooseCharacterSources: vi.fn(),
    readCharacterSource: vi.fn(),
    publishCharacter: vi.fn(),
    activateCharacter: vi.fn(),
    deleteCharacter: vi.fn(),
    importCharacterPackage: vi.fn(),
    exportCharacterPackage: vi.fn(),
    subscribeCharacterEvents: vi.fn(() => vi.fn()),
    onCharacterWorkshopFlushRequested: vi.fn(() => vi.fn()),
    getCharacterRecoverySnapshot: vi.fn(async () => ({ fallbackErrorCode: null, issues: [] })),
    getWorkshopLayout: vi.fn(async () => ({
      leftWidth: 360,
      rightWidth: 320,
      sidebarTopHeight: 300,
      stageHeight: 470
    })),
    saveWorkshopLayout: vi.fn(async value => value),
    ...overrides
  };
}

class ResizeObserverDouble {
  static instances: ResizeObserverDouble[] = [];
  private target: Element | null = null;

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverDouble.instances.push(this);
  }

  observe(target: Element) {
    this.target = target;
  }

  unobserve() {}
  disconnect() {}

  notify(width: number, height: number) {
    if (!this.target) throw new Error('ResizeObserver 尚未观察工作区');
    this.callback([{
      target: this.target,
      contentRect: { width, height }
    } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

describe('角色工作台布局生命周期', () => {
  test('StrictMode 只读取一次偏好，ResizeObserver 只更新 CSS 内存值', async () => {
    ResizeObserverDouble.instances = [];
    vi.stubGlobal('ResizeObserver', ResizeObserverDouble);
    const api = viewApi();
    render(<StrictMode><CharacterWorkshopView api={api} /></StrictMode>);

    await waitFor(() => expect(api.getWorkshopLayout).toHaveBeenCalledOnce());
    await waitFor(() => expect(ResizeObserverDouble.instances.length).toBeGreaterThan(0));
    ResizeObserverDouble.instances.at(-1)?.notify(1_120, 659);

    const columns = document.querySelector<HTMLElement>('.workshop-columns');
    expect(columns?.style.getPropertyValue('--workshop-left-width')).toBe('360px');
    expect(columns?.style.getPropertyValue('--workshop-stage-height')).toBe('451px');
    expect(api.saveWorkshopLayout).not.toHaveBeenCalled();
  });

  test('临时纵向 clamp 后拖动左栏只更新左栏持久偏好', async () => {
    ResizeObserverDouble.instances = [];
    vi.stubGlobal('ResizeObserver', ResizeObserverDouble);
    const saveWorkshopLayout = vi.fn(async (value: WorkshopLayoutSettings) => value);
    const api = viewApi({ saveWorkshopLayout });
    render(<CharacterWorkshopView api={api} />);
    const splitter = await screen.findByRole('separator', { name: '调整角色侧栏宽度' });
    await waitFor(() => expect(splitter.getAttribute('aria-valuenow')).toBe('360'));
    pointerCaptureDouble(splitter);

    fireEvent.pointerDown(splitter, { pointerId: 9, clientX: 100, clientY: 20 });
    fireEvent.pointerMove(splitter, { pointerId: 9, clientX: 140, clientY: 20 });
    expect(saveWorkshopLayout).not.toHaveBeenCalled();

    fireEvent.pointerUp(splitter, { pointerId: 9, clientX: 140, clientY: 20 });
    await waitFor(() => expect(saveWorkshopLayout).toHaveBeenCalledWith({
      leftWidth: 400,
      rightWidth: 320,
      sidebarTopHeight: 300,
      stageHeight: 470
    }));
  });

  test('保存失败保留当前布局，本次卸载后恢复上次成功持久值', async () => {
    ResizeObserverDouble.instances = [];
    vi.stubGlobal('ResizeObserver', ResizeObserverDouble);
    const api = viewApi({
      saveWorkshopLayout: vi.fn(async () => {
        throw new Error('C:\\Users\\private\\settings.json token-sentinel');
      })
    });
    const first = render(<CharacterWorkshopView api={api} />);
    const splitter = await screen.findByRole('separator', { name: '调整角色侧栏宽度' });
    await waitFor(() => expect(splitter.getAttribute('aria-valuenow')).toBe('360'));
    fireEvent.keyDown(splitter, { key: 'ArrowRight' });

    expect(await screen.findByText(/工作台布局暂时无法保存/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('C:\\Users\\private');
    expect(document.body.textContent).not.toContain('token-sentinel');
    expect(splitter.getAttribute('aria-valuenow')).toBe('368');

    first.unmount();
    const restartedApi = viewApi();
    render(<CharacterWorkshopView api={restartedApi} />);
    const restored = await screen.findByRole('separator', { name: '调整角色侧栏宽度' });
    await waitFor(() => expect(restored.getAttribute('aria-valuenow')).toBe('360'));
    expect(restartedApi.getWorkshopLayout).toHaveBeenCalledOnce();
  });

  test.each([
    {
      name: '调整角色侧栏宽度',
      key: 'leftWidth' as const,
      keyboardKey: 'ArrowLeft',
      initial: '396',
      target: '388',
      preservedKey: 'rightWidth' as const,
      preserved: 600
    },
    {
      name: '调整属性侧栏宽度',
      key: 'rightWidth' as const,
      keyboardKey: 'ArrowRight',
      initial: '328',
      target: '320',
      preservedKey: 'leftWidth' as const,
      preserved: 900
    }
  ])('过预算偏好下 $key 小幅提交不跳变', async ({
    name, key, keyboardKey, initial, target, preservedKey, preserved
  }) => {
    vi.stubGlobal('ResizeObserver', ResizeObserverDouble);
    const saveWorkshopLayout = vi.fn(async (value: WorkshopLayoutSettings) => value);
    const api = viewApi({
      getWorkshopLayout: vi.fn(async () => ({
        leftWidth: 900,
        rightWidth: 600,
        sidebarTopHeight: 300,
        stageHeight: 470
      })),
      saveWorkshopLayout
    });
    render(<CharacterWorkshopView api={api} />);
    const splitter = await screen.findByRole('separator', { name });
    await waitFor(() => expect(splitter.getAttribute('aria-valuenow')).toBe(initial));

    fireEvent.keyDown(splitter, { key: keyboardKey });
    await waitFor(() => expect(splitter.getAttribute('aria-valuenow')).toBe(target));
    const saved = saveWorkshopLayout.mock.calls[0]?.[0];
    expect(saved?.[preservedKey]).toBe(preserved);
    expect(clampWorkshopLayout(saved!, { width: 1_120, height: 659 })[key]).toBe(Number(target));
  });
});
