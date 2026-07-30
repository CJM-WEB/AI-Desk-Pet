import {
  Copy,
  GripVertical,
  SkipBack,
  SkipForward,
  Trash2
} from 'lucide-react';
import type { ActionFrame } from '@myself/character-runtime';

export type StableActionFrame = ActionFrame & { id: string };

const SAFE_FRAME_ID = /^[a-z0-9][a-z0-9_-]{0,119}$/u;
const ID_GENERATION_ATTEMPTS = 8;

function shortHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0)!);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

// 旧草稿按帧内容生成确定性标识；首次编辑后标识随草稿持久化。
function derivedFrameId(
  frame: ActionFrame,
  index: number,
  attempt = 0
): string {
  const source = `${frame.assetId}-${frame.x}-${frame.y}-${frame.width}-${frame.height}`;
  if (attempt === 0) return `frame-${shortHash(source)}-${index}`;
  return `frame-${shortHash(`${source}-${index}-${attempt}`)}-${index}`;
}

export function ensureStableFrameIds(
  frames: readonly ActionFrame[]
): StableActionFrame[] {
  const used = new Set<string>();
  for (const frame of frames) {
    if (!frame.id) continue;
    if (!SAFE_FRAME_ID.test(frame.id) || used.has(frame.id)) {
      throw new RangeError('显式帧标识必须唯一且合法。');
    }
    used.add(frame.id);
  }

  return frames.map((frame, index) => {
    if (frame.id) return { ...frame, id: frame.id };
    for (let attempt = 0; attempt < ID_GENERATION_ATTEMPTS; attempt += 1) {
      const candidate = derivedFrameId(frame, index, attempt);
      if (!used.has(candidate)) {
        used.add(candidate);
        return { ...frame, id: candidate };
      }
    }
    throw new RangeError('无法在有界次数内生成唯一帧标识。');
  });
}

export function findUniqueFrameIndex(
  frames: readonly StableActionFrame[],
  targetId: string
): number {
  const matches = frames.reduce<number[]>((indexes, frame, index) => {
    if (frame.id === targetId) indexes.push(index);
    return indexes;
  }, []);
  if (matches.length > 1) {
    throw new RangeError('帧标识必须唯一，操作已拒绝。');
  }
  return matches[0] ?? -1;
}

export function reorderFrames<T>(
  frames: readonly T[],
  fromIndex: number,
  toIndex: number
): T[] {
  if (
    fromIndex < 0
    || fromIndex >= frames.length
    || toIndex < 0
    || toIndex >= frames.length
  ) {
    throw new RangeError('时间轴帧索引超出范围。');
  }
  const next = [...frames];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);
  return next;
}

export function duplicateFrame(
  frames: readonly StableActionFrame[],
  targetId: string,
  createId: () => string = () => crypto.randomUUID()
): StableActionFrame[] {
  const index = findUniqueFrameIndex(frames, targetId);
  if (index < 0) return [...frames];
  const copy = structuredClone(frames[index]!);
  const used = new Set(frames.map(frame => frame.id));
  let nextId: string | undefined;
  for (let attempt = 0; attempt < ID_GENERATION_ATTEMPTS; attempt += 1) {
    const candidate = createId();
    if (SAFE_FRAME_ID.test(candidate) && !used.has(candidate)) {
      nextId = candidate;
      break;
    }
  }
  if (!nextId) {
    for (let attempt = 0; attempt < ID_GENERATION_ATTEMPTS; attempt += 1) {
      const candidate = `frame-${shortHash(`${targetId}-${frames.length}-${attempt}`)}`;
      if (!used.has(candidate)) {
        nextId = candidate;
        break;
      }
    }
  }
  if (!nextId) throw new RangeError('无法在有界次数内生成唯一帧标识。');
  copy.id = nextId;
  return [...frames.slice(0, index + 1), copy, ...frames.slice(index + 1)];
}

export function deleteFrame(
  frames: readonly StableActionFrame[],
  targetId: string
): StableActionFrame[] {
  const index = findUniqueFrameIndex(frames, targetId);
  if (index < 0) return [...frames];
  return [...frames.slice(0, index), ...frames.slice(index + 1)];
}

export function updateFrameDuration(
  frames: readonly StableActionFrame[],
  targetId: string,
  durationMs: number | undefined
): StableActionFrame[] {
  if (
    durationMs !== undefined
    && (!Number.isSafeInteger(durationMs) || durationMs <= 0)
  ) {
    throw new RangeError('帧持续时间必须为正整数。');
  }
  const index = findUniqueFrameIndex(frames, targetId);
  if (index < 0) return [...frames];
  return frames.map((frame, frameIndex) => frameIndex === index
    ? { ...frame, durationMs }
    : frame);
}

export interface ActionTimelineProps {
  frames: readonly ActionFrame[];
  selectedFrameId: string | null;
  disabled: boolean;
  onSelect(frameId: string): void;
  onChange(frames: StableActionFrame[]): void;
}

/**
 * 时间轴只提交完整的新帧数组，使自动保存与撤销边界保持单一。
 */
export function ActionTimeline(props: ActionTimelineProps) {
  const frames = ensureStableFrameIds(props.frames);
  const selectedIndex = Math.max(
    0,
    frames.findIndex(frame => frame.id === props.selectedFrameId)
  );
  const selected = frames[selectedIndex];

  function selectRelative(offset: number): void {
    if (!frames.length) return;
    const index = Math.min(frames.length - 1, Math.max(0, selectedIndex + offset));
    props.onSelect(frames[index]!.id);
  }

  return (
    <section className="action-timeline" aria-label="序列帧时间轴">
      <div className="timeline-heading">
        <strong>时间轴</strong>
        <span>{frames.length} 帧</span>
        <button
          type="button"
          title="上一帧"
          aria-label="上一帧"
          disabled={props.disabled || !frames.length}
          onClick={() => selectRelative(-1)}
        >
          <SkipBack size={15} />
        </button>
        <button
          type="button"
          title="下一帧"
          aria-label="下一帧"
          disabled={props.disabled || !frames.length}
          onClick={() => selectRelative(1)}
        >
          <SkipForward size={15} />
        </button>
        <button
          type="button"
          title="复制当前帧"
          aria-label="复制当前帧"
          disabled={props.disabled || !selected}
          onClick={() => selected && props.onChange(
            duplicateFrame(frames, selected.id)
          )}
        >
          <Copy size={15} />
        </button>
        <button
          type="button"
          title="删除当前帧"
          aria-label="删除当前帧"
          disabled={props.disabled || !selected}
          onClick={() => selected && props.onChange(
            deleteFrame(frames, selected.id)
          )}
        >
          <Trash2 size={15} />
        </button>
      </div>
      <ol className="timeline-frames">
        {frames.map((frame, index) => (
          <li
            key={frame.id}
            draggable={!props.disabled}
            onDragStart={event => {
              event.dataTransfer.setData('text/plain', String(index));
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={event => event.preventDefault()}
            onDrop={event => {
              event.preventDefault();
              const from = Number(event.dataTransfer.getData('text/plain'));
              if (Number.isInteger(from)) {
                props.onChange(reorderFrames(frames, from, index));
              }
            }}
          >
            <button
              type="button"
              aria-pressed={frame.id === props.selectedFrameId}
              disabled={props.disabled}
              onClick={() => props.onSelect(frame.id)}
              onKeyDown={event => {
                if (!event.altKey) return;
                const offset = event.key === 'ArrowLeft'
                  ? -1
                  : event.key === 'ArrowRight'
                    ? 1
                    : 0;
                if (offset === 0) return;
                const destination = Math.min(
                  frames.length - 1,
                  Math.max(0, index + offset)
                );
                if (destination === index) return;
                event.preventDefault();
                props.onChange(reorderFrames(frames, index, destination));
              }}
            >
              <GripVertical size={13} aria-hidden="true" />
              <span>{index + 1}</span>
              <small>{frame.durationMs ? `${frame.durationMs} ms` : '按 FPS'}</small>
            </button>
          </li>
        ))}
      </ol>
      {selected ? (
        <label className="frame-duration">
          当前帧时长
          <input
            type="number"
            min="1"
            step="1"
            value={selected.durationMs ?? ''}
            placeholder="使用 FPS"
            disabled={props.disabled}
            onChange={event => {
              const value = event.currentTarget.value;
              props.onChange(updateFrameDuration(
                frames,
                selected.id,
                value === '' ? undefined : Number(value)
              ));
            }}
          />
          <span>ms</span>
        </label>
      ) : null}
    </section>
  );
}
