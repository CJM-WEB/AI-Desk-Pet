// @vitest-environment jsdom

import { useLayoutEffect, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { DraftActionClip } from '@myself/character-runtime';
import {
  AnchorEditor
} from '../src/renderer/src/characters/workshop/AnchorEditor';
import {
  createPreviewState,
  PreviewControls,
  type PreviewState
} from '../src/renderer/src/characters/workshop/PreviewControls';
import {
  previewActionIdentity,
  previewAtActionStart
} from '../src/renderer/src/characters/workshop/CharacterWorkshopView';

const action: DraftActionClip = {
  id: 'idle-main',
  name: '待机',
  fps: 12,
  loop: true,
  weight: 1,
  direction: 'any',
  anchors: { ground: { x: 0.5, y: 1 } },
  frames: [{
    id: 'frame-a',
    assetId: 'idle-atlas',
    x: 0,
    y: 0,
    width: 64,
    height: 64
  }]
};

afterEach(() => {
  cleanup();
});

function stubPointerCanvas(canvas: HTMLElement): void {
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    top: 100,
    width: 200,
    height: 200,
    right: 300,
    bottom: 300,
    x: 100,
    y: 100,
    toJSON: () => ({})
  });
  Object.defineProperties(canvas, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: {
      configurable: true,
      value: vi.fn(() => true)
    },
    releasePointerCapture: { configurable: true, value: vi.fn() }
  });
}

function pointerEvent(
  type: 'pointerDown' | 'pointerMove' | 'pointerUp',
  target: Element,
  init: { pointerId: number; clientX: number; clientY: number }
): void {
  fireEvent[type](target, init);
}

describe('预览组件帧数同步', () => {
  test('跨角色复用相同状态动作标识时仍形成新的预览身份', () => {
    expect(previewActionIdentity('nova', 'nova', 'idle', 'idle-main'))
      .not.toBe(previewActionIdentity('luna', 'luna', 'idle', 'idle-main'));
  });

  test('切换到帧数相同的新动作时预览与时间轴都回到首帧', () => {
    const nextAction: DraftActionClip = {
      ...action,
      id: 'acting-main',
      frames: [{
        ...action.frames[0]!,
        id: 'acting-a'
      }, {
        ...action.frames[0]!,
        id: 'acting-b'
      }]
    };
    const current = {
      ...createPreviewState(2),
      frameIndex: 1,
      playing: true
    };

    expect(previewAtActionStart(current, nextAction)).toEqual({
      preview: {
        ...current,
        frameIndex: 0,
        playing: false
      },
      selectedFrameId: 'acting-a'
    });
  });

  function ControlledPreviewControls(props: {
    frameCount: number;
    initial?: PreviewState;
    onCommit?(state: PreviewState): void;
  }) {
    const [current, setCurrent] = useState(
      props.initial ?? createPreviewState(props.frameCount)
    );
    useLayoutEffect(() => {
      props.onCommit?.(current);
    }, [current, props]);
    return (
      <>
        <PreviewControls
          state={current}
          frameCount={props.frameCount}
          onChange={setCurrent}
        />
        <div data-testid="preview-state">{JSON.stringify(current)}</div>
      </>
    );
  }

  test('控制器把播放、逐帧、镜像、速度和全部开关提交给父组件', () => {
    render(<ControlledPreviewControls frameCount={4} />);

    fireEvent.click(screen.getByRole('button', { name: '播放' }));
    fireEvent.click(screen.getByRole('button', { name: '下一帧' }));
    fireEvent.click(screen.getByRole('button', { name: '切换循环' }));
    fireEvent.click(screen.getByRole('button', { name: '切换背景明暗' }));
    fireEvent.click(screen.getByRole('button', { name: '切换左右方向' }));
    fireEvent.change(screen.getByLabelText(/速度/u), {
      target: { value: '1.5' }
    });
    fireEvent.click(screen.getByRole('button', { name: '显示或隐藏锚点' }));
    fireEvent.click(screen.getByRole('button', { name: '模拟文件挂载' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '全状态巡览' }));

    expect(JSON.parse(
      screen.getByTestId('preview-state').textContent ?? '{}'
    )).toEqual({
      playing: false,
      frameIndex: 1,
      loop: false,
      darkBackground: true,
      direction: 'left',
      speed: 1.5,
      showAnchors: false,
      mountedFile: true,
      tourAllStates: true
    });
  });

  test('rerender 从大帧数缩减到小帧数和零帧时提交合法状态', () => {
    const commits: PreviewState[] = [];

    function CommitProbe(props: { frameCount: number }) {
      return (
        <ControlledPreviewControls
          frameCount={props.frameCount}
          onCommit={next => commits.push(next)}
        />
      );
    }

    const view = render(<CommitProbe frameCount={5} />);
    const next = screen.getByRole('button', { name: '下一帧' });
    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByRole('status').textContent).toContain('第 5 帧');

    view.rerender(<CommitProbe frameCount={2} />);
    expect(commits.at(-1)?.frameIndex).toBe(1);
    expect(screen.getByRole('status').textContent).toContain('第 2 帧');

    view.rerender(<CommitProbe frameCount={0} />);
    expect(commits.at(-1)).toMatchObject({
      playing: false,
      frameIndex: -1
    });
    expect(screen.getByRole('status').textContent).toContain('无可用帧');
  });
});

describe('锚点编辑器画布交互', () => {
  function ControlledEditor(props: {
    perFrame: boolean;
    onChange?(next: DraftActionClip): void;
  }) {
    const [current, setCurrent] = useState(action);
    return (
      <AnchorEditor
        action={current}
        frameId="frame-a"
        perFrame={props.perFrame}
        disabled={false}
        onPerFrameChange={vi.fn()}
        onChange={next => {
          props.onChange?.(next);
          setCurrent(next);
        }}
      />
    );
  }

  test('锚点工具 pointerdown move up 更新整段锚点并回渲染标记', () => {
    const onChange = vi.fn();
    render(<ControlledEditor perFrame={false} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('画布锚点'), {
      target: { value: 'carry' }
    });
    const canvas = screen.getByLabelText('锚点与碰撞区域画布');
    stubPointerCanvas(canvas);

    pointerEvent('pointerDown', canvas, {
      pointerId: 7,
      clientX: 150,
      clientY: 150
    });
    pointerEvent('pointerMove', canvas, {
      pointerId: 7,
      clientX: 250,
      clientY: 200
    });
    pointerEvent('pointerUp', canvas, {
      pointerId: 7,
      clientX: 250,
      clientY: 200
    });

    expect((screen.getByLabelText('carry X') as HTMLInputElement).valueAsNumber)
      .toBe(0.75);
    expect((screen.getByLabelText('carry Y') as HTMLInputElement).valueAsNumber)
      .toBe(0.5);
    const marker = canvas.querySelector('[title="carry"]') as HTMLElement;
    expect(marker.style.left).toBe('75%');
    expect(marker.style.top).toBe('50%');
    expect(onChange.mock.lastCall?.[0].anchors.carry)
      .toEqual({ x: 0.75, y: 0.5 });
    expect(onChange.mock.lastCall?.[0].frames[0]?.anchors)
      .toBeUndefined();
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(7);
    expect(canvas.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  test('逐帧模式只写当前帧锚点并回渲染覆盖值', () => {
    const onChange = vi.fn();
    render(<ControlledEditor perFrame onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('画布锚点'), {
      target: { value: 'focus' }
    });
    const canvas = screen.getByLabelText('锚点与碰撞区域画布');
    stubPointerCanvas(canvas);

    pointerEvent('pointerDown', canvas, {
      pointerId: 8,
      clientX: 140,
      clientY: 160
    });
    pointerEvent('pointerUp', canvas, {
      pointerId: 8,
      clientX: 140,
      clientY: 160
    });

    expect((screen.getByLabelText('focus X') as HTMLInputElement).valueAsNumber)
      .toBe(0.2);
    expect((screen.getByLabelText('focus Y') as HTMLInputElement).valueAsNumber)
      .toBe(0.3);
    const marker = canvas.querySelector('[title="focus"]') as HTMLElement;
    expect(marker.style.left).toBe('20%');
    expect(marker.style.top).toBe('30%');
    expect(onChange.mock.lastCall?.[0].anchors.focus).toBeUndefined();
    expect(onChange.mock.lastCall?.[0].frames[0]?.anchors?.focus)
      .toEqual({ x: 0.2, y: 0.3 });
  });

  test('碰撞工具拖动写入归一化区域并回渲染矩形', () => {
    const onChange = vi.fn();
    render(<ControlledEditor perFrame={false} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('画布交互工具'), {
      target: { value: 'collision' }
    });
    const canvas = screen.getByLabelText('锚点与碰撞区域画布');
    stubPointerCanvas(canvas);

    pointerEvent('pointerDown', canvas, {
      pointerId: 9,
      clientX: 180,
      clientY: 180
    });
    pointerEvent('pointerMove', canvas, {
      pointerId: 9,
      clientX: 120,
      clientY: 260
    });
    pointerEvent('pointerUp', canvas, {
      pointerId: 9,
      clientX: 120,
      clientY: 260
    });

    expect((screen.getByLabelText('collision X') as HTMLInputElement).valueAsNumber)
      .toBe(0.1);
    expect((screen.getByLabelText('collision Y') as HTMLInputElement).valueAsNumber)
      .toBe(0.4);
    expect((
      screen.getByLabelText('collision 宽度') as HTMLInputElement
    ).valueAsNumber).toBe(0.3);
    expect((
      screen.getByLabelText('collision 高度') as HTMLInputElement
    ).valueAsNumber).toBe(0.4);
    const region = canvas.querySelector(
      '.anchor-collision-region'
    ) as HTMLElement;
    expect(region.style.left).toBe('10%');
    expect(region.style.top).toBe('40%');
    expect(region.style.width).toBe('30%');
    expect(region.style.height).toBe('40%');
    expect(onChange.mock.lastCall?.[0].regions?.collision).toEqual({
      x: 0.1,
      y: 0.4,
      width: 0.3,
      height: 0.4
    });
  });
});
