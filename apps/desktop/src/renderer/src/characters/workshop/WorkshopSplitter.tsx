import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

export interface WorkshopSplitterProps {
  label: string;
  orientation: 'horizontal' | 'vertical';
  value: number;
  min: number;
  max: number;
  valueDirection?: 1 | -1;
  onChange(value: number): void;
  onCommit(value: number): void;
}

type PointerInteraction = {
  pointerId: number;
  startCoordinate: number;
  startValue: number;
  latestValue: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

/** 分隔器只管理一次交互的捕获与最终值，持久化时机由父级决定。 */
export function WorkshopSplitter(props: WorkshopSplitterProps) {
  const interactionRef = useRef<PointerInteraction | null>(null);

  const coordinate = (event: Pick<PointerEvent<HTMLDivElement>, 'clientX' | 'clientY'>) => (
    props.orientation === 'vertical' ? event.clientX : event.clientY
  );

  const updatePointerValue = (event: PointerEvent<HTMLDivElement>): number | null => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return null;
    const next = clamp(
      interaction.startValue
        + (coordinate(event) - interaction.startCoordinate) * (props.valueDirection ?? 1),
      props.min,
      props.max
    );
    interaction.latestValue = next;
    props.onChange(next);
    return next;
  };

  const finishPointer = (event: PointerEvent<HTMLDivElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const finalValue = updatePointerValue(event) ?? interaction.latestValue;
    interactionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    props.onCommit(finalValue);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const negativeKey = props.orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const positiveKey = props.orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== negativeKey && event.key !== positiveKey) return;
    event.preventDefault();
    // 键位表达分隔线的空间方向，再统一映射到受控尺寸的增减方向。
    const direction = (event.key === positiveKey ? 1 : -1) * (props.valueDirection ?? 1);
    const next = clamp(props.value + direction * (event.shiftKey ? 32 : 8), props.min, props.max);
    props.onChange(next);
    props.onCommit(next);
  };

  return (
    <div
      className={`workshop-splitter workshop-splitter--${props.orientation}`}
      role="separator"
      tabIndex={0}
      aria-label={props.label}
      aria-orientation={props.orientation}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={props.value}
      onKeyDown={handleKeyDown}
      onPointerDown={event => {
        interactionRef.current = {
          pointerId: event.pointerId,
          startCoordinate: coordinate(event),
          startValue: props.value,
          latestValue: props.value
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        updatePointerValue(event);
      }}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onLostPointerCapture={event => {
        const interaction = interactionRef.current;
        if (!interaction || interaction.pointerId !== event.pointerId) return;
        interactionRef.current = null;
        props.onCommit(interaction.latestValue);
      }}
    />
  );
}
