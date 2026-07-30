import { FlipHorizontal2, LocateFixed, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type {
  AnchorPoint,
  AnchorSet,
  DraftActionClip,
  InteractionRegion
} from '@myself/character-runtime';
import {
  ensureStableFrameIds,
  findUniqueFrameIndex
} from './ActionTimeline';

export type AnchorName = keyof AnchorSet;
export type RegionName = 'click' | 'drag' | 'collision';

const optionalAnchors: readonly Exclude<AnchorName, 'ground'>[] = [
  'focus',
  'carry',
  'mouth',
  'seat'
];

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roundNormalized(value: number): number {
  return Math.round(clamp(value) * 1_000_000) / 1_000_000;
}

// 镜像和坐标换算统一在纯函数完成，避免不同输入控件产生数值偏差。
export function mirrorAnchor(anchor: AnchorPoint): AnchorPoint {
  return { x: clamp(1 - anchor.x), y: clamp(anchor.y) };
}

export function mirrorRegion(region: InteractionRegion): InteractionRegion {
  return {
    ...region,
    x: Math.round(clamp(1 - region.x - region.width) * 1_000_000) / 1_000_000
  };
}

export function screenToNormalizedPoint(
  point: { x: number; y: number },
  bounds: { left: number; top: number; width: number; height: number }
): AnchorPoint {
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new RangeError('画布边界必须具有正宽高。');
  }
  return {
    x: clamp((point.x - bounds.left) / bounds.width),
    y: clamp((point.y - bounds.top) / bounds.height)
  };
}

export function derivePreviewAnchors(
  action: DraftActionClip,
  logicalBounds: { x: number; y: number; width: number; height: number }
): Required<AnchorSet> {
  const x = clamp(logicalBounds.x);
  const y = clamp(logicalBounds.y);
  const width = Math.min(clamp(logicalBounds.width), 1 - x);
  const height = Math.min(clamp(logicalBounds.height), 1 - y);
  const centerX = roundNormalized(x + width / 2);
  const atHeight = (ratio: number): AnchorPoint => ({
    x: centerX,
    y: roundNormalized(y + height * ratio)
  });

  return {
    ground: action.anchors.ground,
    carry: action.anchors.carry ?? atHeight(0.42),
    mouth: action.anchors.mouth ?? atHeight(0.25),
    seat: action.anchors.seat ?? atHeight(0.72),
    focus: action.anchors.focus ?? atHeight(0.34)
  };
}

export type CanvasBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type CanvasInteraction =
  | {
      kind: 'anchor';
      pointerId: number;
      anchor: AnchorName;
      point: AnchorPoint;
    }
  | {
      kind: 'collision';
      pointerId: number;
      origin: AnchorPoint;
      region: InteractionRegion;
    };

export type BeginCanvasInteractionInput =
  | {
      tool: 'anchor';
      anchor: AnchorName;
      pointerId: number;
      point: { x: number; y: number };
      bounds: CanvasBounds;
    }
  | {
      tool: 'collision';
      pointerId: number;
      point: { x: number; y: number };
      bounds: CanvasBounds;
    };

// Pointer 状态机由纯函数维护，组件和测试共享相同的坐标与捕获规则。
export function beginCanvasInteraction(
  input: BeginCanvasInteractionInput
): CanvasInteraction {
  const point = screenToNormalizedPoint(input.point, input.bounds);
  if (input.tool === 'anchor') {
    return {
      kind: 'anchor',
      pointerId: input.pointerId,
      anchor: input.anchor,
      point
    };
  }
  return {
    kind: 'collision',
    pointerId: input.pointerId,
    origin: point,
    region: { x: point.x, y: point.y, width: 0, height: 0 }
  };
}

export function moveCanvasInteraction(
  interaction: CanvasInteraction,
  pointerId: number,
  point: { x: number; y: number },
  bounds: CanvasBounds
): CanvasInteraction {
  if (interaction.pointerId !== pointerId) return interaction;
  const normalized = screenToNormalizedPoint(point, bounds);
  if (interaction.kind === 'anchor') {
    return { ...interaction, point: normalized };
  }
  return {
    ...interaction,
    region: {
      x: roundNormalized(Math.min(interaction.origin.x, normalized.x)),
      y: roundNormalized(Math.min(interaction.origin.y, normalized.y)),
      width: roundNormalized(Math.abs(normalized.x - interaction.origin.x)),
      height: roundNormalized(Math.abs(normalized.y - interaction.origin.y))
    }
  };
}

export function finishCanvasInteraction(
  interaction: CanvasInteraction,
  pointerId: number
): CanvasInteraction | null {
  return interaction.pointerId === pointerId ? null : interaction;
}

export type AnchorUpdate = {
  anchor: AnchorName;
  value: AnchorPoint | undefined;
  perFrame: boolean;
  frameId?: string;
};

export type AnchorCoordinateUpdate = {
  anchor: AnchorName;
  axis: 'x' | 'y';
  value: number;
  perFrame: boolean;
  frameId?: string;
};

export function updateAnchor(
  action: DraftActionClip,
  update: AnchorUpdate
): DraftActionClip {
  if (update.anchor === 'ground' && !update.value) {
    throw new RangeError('ground 锚点不能删除。');
  }
  if (!update.perFrame) {
    const anchors = { ...action.anchors };
    if (update.value) anchors[update.anchor] = update.value;
    else delete anchors[update.anchor];
    return { ...action, anchors };
  }
  if (!update.frameId) throw new RangeError('逐帧锚点需要当前帧标识。');
  const frames = ensureStableFrameIds(action.frames);
  const frameIndex = findUniqueFrameIndex(frames, update.frameId);
  if (frameIndex < 0) return { ...action, frames };
  return {
    ...action,
    frames: frames.map((frame, index) => {
      if (index !== frameIndex) return frame;
      const anchors = { ...(frame.anchors ?? {}) };
      if (update.value) anchors[update.anchor] = update.value;
      else delete anchors[update.anchor];
      return { ...frame, anchors };
    })
  };
}

export function updateAnchorCoordinate(
  action: DraftActionClip,
  update: AnchorCoordinateUpdate
): DraftActionClip {
  const frames = ensureStableFrameIds(action.frames);
  let current = action.anchors[update.anchor];
  if (update.perFrame) {
    if (!update.frameId) throw new RangeError('逐帧锚点需要当前帧标识。');
    const index = findUniqueFrameIndex(frames, update.frameId);
    if (index < 0) return { ...action, frames };
    current = frames[index]!.anchors?.[update.anchor] ?? current;
  }
  const point = current ?? { x: 0.5, y: 0.5 };
  return updateAnchor({ ...action, frames }, {
    anchor: update.anchor,
    value: {
      ...point,
      [update.axis]: clamp(update.value)
    },
    perFrame: update.perFrame,
    ...(update.frameId ? { frameId: update.frameId } : {})
  });
}

export interface AnchorEditorProps {
  action: DraftActionClip;
  frameId: string | null;
  perFrame: boolean;
  disabled: boolean;
  onPerFrameChange(enabled: boolean): void;
  onChange(action: DraftActionClip): void;
}

/**
 * 整段锚点与逐帧覆盖共用一个编辑器，派生预览值不会进入草稿。
 */
export function AnchorEditor(props: AnchorEditorProps) {
  const [canvasTool, setCanvasTool] = useState<'anchor' | 'collision'>('anchor');
  const [canvasAnchor, setCanvasAnchor] = useState<AnchorName>('ground');
  const interactionRef = useRef<CanvasInteraction | null>(null);
  const frames = ensureStableFrameIds(props.action.frames);
  const frameIndex = props.frameId
    ? findUniqueFrameIndex(frames, props.frameId)
    : -1;
  const frame = frameIndex >= 0 ? frames[frameIndex] : undefined;
  const anchors = props.perFrame
    ? { ...props.action.anchors, ...(frame?.anchors ?? {}) }
    : props.action.anchors;

  function change(anchor: AnchorName, point: AnchorPoint | undefined): void {
    props.onChange(updateAnchor({ ...props.action, frames }, {
      anchor,
      value: point,
      perFrame: props.perFrame,
      ...(props.frameId ? { frameId: props.frameId } : {})
    }));
  }

  function changeCoordinate(
    anchor: AnchorName,
    axis: 'x' | 'y',
    value: number
  ): void {
    props.onChange(updateAnchorCoordinate({ ...props.action, frames }, {
      anchor,
      axis,
      value,
      perFrame: props.perFrame,
      ...(props.frameId ? { frameId: props.frameId } : {})
    }));
  }

  function setRegion(
    name: RegionName,
    region: InteractionRegion | undefined
  ): void {
    const regions = { ...(props.action.regions ?? {}) };
    if (region) regions[name] = region;
    else delete regions[name];
    props.onChange({ ...props.action, regions });
  }

  function changeRegion(
    name: RegionName,
    field: keyof InteractionRegion,
    value: number
  ): void {
    const current = props.action.regions?.[name];
    if (!current) return;
    const next = { ...current, [field]: clamp(value) };
    next.width = Math.min(next.width, 1 - next.x);
    next.height = Math.min(next.height, 1 - next.y);
    setRegion(name, next);
  }

  function applyCanvasInteraction(interaction: CanvasInteraction): void {
    if (interaction.kind === 'anchor') {
      change(interaction.anchor, interaction.point);
      return;
    }
    setRegion('collision', interaction.region);
  }

  function canvasBounds(
    event: ReactPointerEvent<HTMLDivElement>
  ): CanvasBounds {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height
    };
  }

  function handlePointerDown(
    event: ReactPointerEvent<HTMLDivElement>
  ): void {
    if (props.disabled) return;
    const common = {
      pointerId: event.pointerId,
      point: { x: event.clientX, y: event.clientY },
      bounds: canvasBounds(event)
    };
    const interaction = canvasTool === 'anchor'
      ? beginCanvasInteraction({
          tool: 'anchor',
          anchor: canvasAnchor,
          ...common
        })
      : beginCanvasInteraction({ tool: 'collision', ...common });
    interactionRef.current = interaction;
    event.currentTarget.setPointerCapture(event.pointerId);
    applyCanvasInteraction(interaction);
  }

  function handlePointerMove(
    event: ReactPointerEvent<HTMLDivElement>
  ): void {
    const current = interactionRef.current;
    if (!current) return;
    const next = moveCanvasInteraction(
      current,
      event.pointerId,
      { x: event.clientX, y: event.clientY },
      canvasBounds(event)
    );
    interactionRef.current = next;
    if (next !== current) applyCanvasInteraction(next);
  }

  function handlePointerEnd(
    event: ReactPointerEvent<HTMLDivElement>
  ): void {
    const current = interactionRef.current;
    if (!current) return;
    interactionRef.current = finishCanvasInteraction(current, event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleCanvasKeyDown(
    event: React.KeyboardEvent<HTMLDivElement>
  ): void {
    if (props.disabled || canvasTool !== 'anchor') return;
    const point = anchors[canvasAnchor] ?? { x: 0.5, y: 0.5 };
    const step = event.shiftKey ? 0.05 : 0.01;
    const movement = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step }
    }[event.key];
    if (!movement) return;
    event.preventDefault();
    change(canvasAnchor, {
      x: roundNormalized(point.x + movement.x),
      y: roundNormalized(point.y + movement.y)
    });
  }

  return (
    <section className="anchor-editor" aria-labelledby="anchor-editor-heading">
      <div className="subsection-heading">
        <h3 id="anchor-editor-heading">锚点与区域</h3>
        <label>
          <input
            type="checkbox"
            checked={props.perFrame}
            disabled={props.disabled || !props.frameId}
            onChange={event => props.onPerFrameChange(event.currentTarget.checked)}
          />
          逐帧锚点
        </label>
      </div>
      <div className="anchor-canvas-toolbar">
        <select
          aria-label="画布交互工具"
          value={canvasTool}
          disabled={props.disabled}
          onChange={event => setCanvasTool(
            event.currentTarget.value as 'anchor' | 'collision'
          )}
        >
          <option value="anchor">锚点</option>
          <option value="collision">碰撞区域</option>
        </select>
        <select
          aria-label="画布锚点"
          value={canvasAnchor}
          disabled={props.disabled || canvasTool !== 'anchor'}
          onChange={event => setCanvasAnchor(
            event.currentTarget.value as AnchorName
          )}
        >
          {(['ground', ...optionalAnchors] as AnchorName[]).map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>
      <div
        className="anchor-canvas"
        aria-label="锚点与碰撞区域画布"
        aria-disabled={props.disabled}
        tabIndex={props.disabled ? -1 : 0}
        onKeyDown={handleCanvasKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        {props.action.regions?.collision ? (
          <span
            className="anchor-collision-region"
            style={{
              left: `${props.action.regions.collision.x * 100}%`,
              top: `${props.action.regions.collision.y * 100}%`,
              width: `${props.action.regions.collision.width * 100}%`,
              height: `${props.action.regions.collision.height * 100}%`
            }}
          />
        ) : null}
        {Object.entries(anchors).map(([name, point]) => (
          point ? (
            <span
              className="anchor-canvas-point"
              data-selected={canvasTool === 'anchor' && canvasAnchor === name}
              key={name}
              title={name}
              style={{
                left: `${point.x * 100}%`,
                top: `${point.y * 100}%`
              }}
            />
          ) : null
        ))}
      </div>
      <div className="anchor-list">
        {(['ground', ...optionalAnchors] as AnchorName[]).map(name => {
          const point = anchors[name];
          return (
            <div className="anchor-row" key={name}>
              <strong>{name}</strong>
              <input
                aria-label={`${name} X`}
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={point?.x ?? ''}
                disabled={props.disabled}
                onChange={event => changeCoordinate(
                  name,
                  'x',
                  Number(event.currentTarget.value)
                )}
              />
              <input
                aria-label={`${name} Y`}
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={point?.y ?? ''}
                disabled={props.disabled}
                onChange={event => changeCoordinate(
                  name,
                  'y',
                  Number(event.currentTarget.value)
                )}
              />
              <button
                type="button"
                title={`镜像 ${name}`}
                aria-label={`镜像 ${name}`}
                disabled={props.disabled || !point}
                onClick={() => point && change(name, mirrorAnchor(point))}
              >
                <FlipHorizontal2 size={14} />
              </button>
              <button
                type="button"
                title={`删除 ${name}`}
                aria-label={`删除 ${name}`}
                disabled={props.disabled || name === 'ground' || !point}
                onClick={() => change(name, undefined)}
              >
                {name === 'ground'
                  ? <LocateFixed size={14} />
                  : <Trash2 size={14} />}
              </button>
            </div>
          );
        })}
      </div>
      <div className="region-list">
        {(['click', 'drag', 'collision'] as RegionName[]).map(name => {
          const region = props.action.regions?.[name];
          return (
            <div className="region-editor" key={name}>
              <div>
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(region)}
                    disabled={props.disabled}
                    onChange={event => setRegion(
                      name,
                      event.currentTarget.checked
                        ? { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
                        : undefined
                    )}
                  />
                  {name} 区域
                </label>
                <button
                  type="button"
                  title={`镜像 ${name} 区域`}
                  aria-label={`镜像 ${name} 区域`}
                  disabled={props.disabled || !region}
                  onClick={() => region && setRegion(name, mirrorRegion(region))}
                >
                  <FlipHorizontal2 size={14} />
                </button>
              </div>
              {region ? (
                <div className="region-fields">
                  {([
                    ['x', 'X'],
                    ['y', 'Y'],
                    ['width', '宽度'],
                    ['height', '高度']
                  ] as const).map(([field, label]) => (
                    <input
                      key={field}
                      aria-label={`${name} ${label}`}
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                      value={region[field]}
                      disabled={props.disabled}
                      onChange={event => changeRegion(
                        name,
                        field,
                        Number(event.currentTarget.value)
                      )}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
