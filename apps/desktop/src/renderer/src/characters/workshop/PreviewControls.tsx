import {
  Eye,
  EyeOff,
  FlipHorizontal2,
  FolderInput,
  Pause,
  Play,
  Repeat2,
  SkipBack,
  SkipForward
} from 'lucide-react';
import { useEffect, useReducer } from 'react';

export type PreviewState = {
  playing: boolean;
  frameIndex: number;
  loop: boolean;
  darkBackground: boolean;
  direction: 'left' | 'right';
  speed: number;
  showAnchors: boolean;
  mountedFile: boolean;
  tourAllStates: boolean;
};

export type PreviewAction =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'previous-frame' }
  | { type: 'next-frame' }
  | { type: 'toggle-loop' }
  | { type: 'toggle-background' }
  | { type: 'toggle-direction' }
  | { type: 'set-speed'; speed: number }
  | { type: 'toggle-anchors' }
  | { type: 'toggle-file' }
  | { type: 'toggle-tour' }
  | { type: 'sync-frame-count' };

// 预览状态是纯内存快照，不包含路径、文件句柄或 Main 调用能力。
export function createPreviewState(frameCount: number): PreviewState {
  return {
    playing: false,
    frameIndex: frameCount > 0 ? 0 : -1,
    loop: true,
    darkBackground: false,
    direction: 'right',
    speed: 1,
    showAnchors: true,
    mountedFile: false,
    tourAllStates: false
  };
}

export function normalizePreviewState(
  state: PreviewState,
  frameCount: number
): PreviewState {
  const count = Math.max(0, Math.floor(frameCount));
  if (count === 0) {
    return { ...state, playing: false, frameIndex: -1 };
  }
  return {
    ...state,
    frameIndex: Math.min(count - 1, Math.max(0, state.frameIndex))
  };
}

export function reducePreviewState(
  state: PreviewState,
  action: PreviewAction,
  frameCount: number
): PreviewState {
  const normalized = normalizePreviewState(state, frameCount);
  const last = Math.max(0, Math.floor(frameCount) - 1);
  switch (action.type) {
    case 'sync-frame-count': return normalized;
    case 'play': return { ...normalized, playing: frameCount > 0 };
    case 'pause': return { ...normalized, playing: false };
    case 'previous-frame':
      return {
        ...normalized,
        playing: false,
        frameIndex: Math.max(0, normalized.frameIndex - 1)
      };
    case 'next-frame':
      return {
        ...normalized,
        playing: false,
        frameIndex: Math.min(last, normalized.frameIndex + 1)
      };
    case 'toggle-loop': return { ...normalized, loop: !normalized.loop };
    case 'toggle-background':
      return { ...normalized, darkBackground: !normalized.darkBackground };
    case 'toggle-direction':
      return {
        ...normalized,
        direction: normalized.direction === 'left' ? 'right' : 'left'
      };
    case 'set-speed':
      return {
        ...normalized,
        speed: Math.min(2, Math.max(0.25, action.speed))
      };
    case 'toggle-anchors':
      return { ...normalized, showAnchors: !normalized.showAnchors };
    case 'toggle-file':
      return { ...normalized, mountedFile: !normalized.mountedFile };
    case 'toggle-tour':
      return { ...normalized, tourAllStates: !normalized.tourAllStates };
  }
}

export interface PreviewControlsProps {
  frameCount: number;
  disabled?: boolean;
}

/**
 * 控制器只驱动本地 reducer，实际 PixiJS 播放器由下一阶段消费这些状态。
 */
export function PreviewControls(props: PreviewControlsProps) {
  const [state, dispatchBase] = useReducer(
    (current: PreviewState, action: PreviewAction) => (
      reducePreviewState(current, action, props.frameCount)
    ),
    props.frameCount,
    createPreviewState
  );
  const dispatch = (action: PreviewAction) => dispatchBase(action);
  const renderedState = normalizePreviewState(state, props.frameCount);
  useEffect(() => {
    dispatchBase({ type: 'sync-frame-count' });
  }, [props.frameCount]);

  return (
    <div className="preview-controls" aria-label="预览控制">
      <button
        type="button"
        title={renderedState.playing ? '暂停' : '播放'}
        aria-label={renderedState.playing ? '暂停' : '播放'}
        disabled={props.disabled || props.frameCount === 0}
        onClick={() => dispatch({
          type: renderedState.playing ? 'pause' : 'play'
        })}
      >
        {renderedState.playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <button type="button" title="上一帧" aria-label="上一帧" disabled={props.disabled || props.frameCount === 0} onClick={() => dispatch({ type: 'previous-frame' })}>
        <SkipBack size={15} />
      </button>
      <button type="button" title="下一帧" aria-label="下一帧" disabled={props.disabled || props.frameCount === 0} onClick={() => dispatch({ type: 'next-frame' })}>
        <SkipForward size={15} />
      </button>
      <button type="button" title="切换循环" aria-label="切换循环" aria-pressed={renderedState.loop} disabled={props.disabled} onClick={() => dispatch({ type: 'toggle-loop' })}>
        <Repeat2 size={15} />
      </button>
      <button type="button" title="切换背景明暗" aria-label="切换背景明暗" aria-pressed={renderedState.darkBackground} disabled={props.disabled} onClick={() => dispatch({ type: 'toggle-background' })}>
        <span className="background-swatch" aria-hidden="true" />
      </button>
      <button type="button" title="切换左右方向" aria-label="切换左右方向" disabled={props.disabled} onClick={() => dispatch({ type: 'toggle-direction' })}>
        <FlipHorizontal2 size={15} />
      </button>
      <label>
        速度
        <input
          type="range"
          min="0.25"
          max="2"
          step="0.25"
          value={renderedState.speed}
          disabled={props.disabled}
          onChange={event => dispatch({
            type: 'set-speed',
            speed: Number(event.currentTarget.value)
          })}
        />
        <span>{renderedState.speed}×</span>
      </label>
      <button type="button" title="显示或隐藏锚点" aria-label="显示或隐藏锚点" aria-pressed={renderedState.showAnchors} disabled={props.disabled} onClick={() => dispatch({ type: 'toggle-anchors' })}>
        {renderedState.showAnchors ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>
      <button type="button" title="模拟文件挂载" aria-label="模拟文件挂载" aria-pressed={renderedState.mountedFile} disabled={props.disabled} onClick={() => dispatch({ type: 'toggle-file' })}>
        <FolderInput size={15} />
      </button>
      <label className="preview-tour">
        <input
          type="checkbox"
          checked={renderedState.tourAllStates}
          disabled={props.disabled}
          onChange={() => dispatch({ type: 'toggle-tour' })}
        />
        全状态巡览
      </label>
      <output aria-live="polite">
        {renderedState.frameIndex < 0
          ? '无可用帧'
          : `第 ${renderedState.frameIndex + 1} 帧`}
      </output>
    </div>
  );
}
