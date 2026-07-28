import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { File as FileIcon } from 'lucide-react';
import {
  motionModeFor,
  type CharacterMotionMode,
  type CharacterState
} from '@myself/character-runtime';
import { CharacterPlayer } from '../characters/player/CharacterPlayer';
import type {
  CharacterDesktopAnchors,
  CharacterMotionPresentation
} from '../characters/player/CharacterPlayer';
import { presentationFor } from '../character/state-map';
import { useTaskStore } from '../stores/task-store';

export interface PetCharacterProps {
  state: CharacterState;
  motionMode: CharacterMotionMode;
}

/** 只有运行角色加载失败时才会显示此 CSS 备用角色。 */
export function PetCharacter({ state, motionMode }: PetCharacterProps) {
  const presentation = presentationFor(state);
  return (
    <span
      className="pet-character"
      data-state={state}
      data-motion={motionMode}
      aria-label={`AI Pet：${presentation.label}`}
    >
      <span className="pet-ear pet-ear-left" aria-hidden="true" />
      <span className="pet-ear pet-ear-right" aria-hidden="true" />
      <span className="pet-body">
        <span className="pet-glow" aria-hidden="true" />
        <span className="pet-face" aria-hidden="true">{presentation.face}</span>
        <strong>AI Pet</strong>
        <span className="pet-state-label">{presentation.label}</span>
        <span className="pet-state-detail">{presentation.detail}</span>
      </span>
    </span>
  );
}

/** 桌宠按钮始终调用 preload 暴露的正式聊天窗口命令。 */
export function PetOpenChatButton({
  children,
  onSingleClick,
  onDoubleClick,
  onContextMenu
}: {
  children: ReactNode;
  onSingleClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: () => void;
}) {
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearClick = (): void => {
    if (clickTimer.current !== null) clearTimeout(clickTimer.current);
    clickTimer.current = null;
  };
  useEffect(() => clearClick, []);

  return (
    <button
      className="pet-open-chat no-drag"
      type="button"
      aria-label="打开与 AI Pet 的聊天"
      onClick={() => {
        clearClick();
        clickTimer.current = setTimeout(() => {
          clickTimer.current = null;
          void window.myself.openChat();
          onSingleClick?.();
        }, 250);
      }}
      onDoubleClick={() => {
        clearClick();
        void window.myself.openChat();
        onDoubleClick?.();
      }}
      onContextMenu={() => {
        clearClick();
        onContextMenu?.();
      }}
    >
      {children}
    </button>
  );
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = (): void => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function PetView() {
  const characterState = useTaskStore(state => state.characterState.stateId);
  const fallbackState: CharacterState = characterState.startsWith('custom:')
    ? 'idle'
    : characterState as CharacterState;
  const reducedMotion = useReducedMotion();
  const motionMode = motionModeFor(reducedMotion);
  const configureExtensions = useTaskStore(state => state.configureCharacterExtensions);
  const triggerPointer = useTaskStore(state => state.triggerCharacterPointer);
  const triggerIdle = useTaskStore(state => state.triggerCharacterIdle);
  const applyCharacterMotion = useTaskStore(state => state.applyCharacterMotion);
  const [desktopAnchors, setDesktopAnchors] = useState<CharacterDesktopAnchors>({
    carry: null,
    seat: null,
    focus: null
  });
  const [motion, setMotion] = useState<CharacterMotionPresentation>({
    position: { x: 0, y: 0 },
    direction: 'right',
    moving: false,
    carrying: false
  });
  const handleMotionChange = useCallback((next: CharacterMotionPresentation): void => {
    setMotion(next);
    applyCharacterMotion({
      moving: next.moving,
      carrying: next.carrying
    });
  }, [applyCharacterMotion]);

  return (
    <main
      className="pet-shell"
      aria-label="AI Pet 桌宠"
      data-carry-anchor={serializeAnchor(desktopAnchors.carry)}
      data-seat-anchor={serializeAnchor(desktopAnchors.seat)}
      data-focus-anchor={serializeAnchor(desktopAnchors.focus)}
    >
      <div className="pet-drag-hint" aria-hidden="true">拖动我</div>
      <PetOpenChatButton
        onSingleClick={() => triggerPointer('single_click')}
        onDoubleClick={() => triggerPointer('double_click')}
        onContextMenu={() => triggerPointer('context_menu')}
      >
        <CharacterPlayer
          stateId={characterState}
          motionMode={motionMode}
          onExtensionDefinitionsChange={configureExtensions}
          onIdleTrigger={triggerIdle}
          onDesktopAnchors={setDesktopAnchors}
          onMotionChange={handleMotionChange}
          fallback={(
            <PetCharacter state={fallbackState} motionMode={motionMode} />
          )}
        />
      </PetOpenChatButton>
      <PetAnchorOverlays
        anchors={desktopAnchors}
        carrying={motion.carrying}
        windowOrigin={motion.position}
      />
    </main>
  );
}

/** 把播放器桌面锚点转换为当前宠物窗口客户区中的实际视觉对象。 */
export function PetAnchorOverlays({
  anchors,
  carrying,
  windowOrigin
}: {
  anchors: CharacterDesktopAnchors;
  carrying: boolean;
  windowOrigin: { x: number; y: number };
}) {
  const local = (point: { x: number; y: number } | null) => point
    ? { left: point.x - windowOrigin.x, top: point.y - windowOrigin.y }
    : null;
  const carry = local(anchors.carry);
  const seat = local(anchors.seat);
  const focus = local(anchors.focus);

  return (
    <>
      {carrying && carry ? (
        <span
          className="pet-carried-file"
          style={carry}
          aria-label="正在搬运文件"
        >
          <FileIcon size={18} strokeWidth={2} aria-hidden="true" />
        </span>
      ) : null}
      {seat ? <span className="pet-seat-effect" style={seat} aria-hidden="true" /> : null}
      {focus ? <span className="pet-focus-effect" style={focus} aria-hidden="true" /> : null}
    </>
  );
}

function serializeAnchor(anchor: { x: number; y: number } | null): string | undefined {
  return anchor ? `${Math.round(anchor.x)},${Math.round(anchor.y)}` : undefined;
}
