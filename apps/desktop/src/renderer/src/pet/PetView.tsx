import { useEffect, useState, type ReactNode } from 'react';
import {
  characterStateFor,
  motionModeFor,
  type CharacterMotionMode,
  type CharacterState
} from '@myself/character-runtime';
import { CharacterPlayer } from '../characters/player/CharacterPlayer';
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
export function PetOpenChatButton({ children }: { children: ReactNode }) {
  return (
    <button
      className="pet-open-chat no-drag"
      type="button"
      aria-label="打开与 AI Pet 的聊天"
      onClick={() => void window.myself.openChat()}
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
  const phase = useTaskStore(state => state.phase);
  const reducedMotion = useReducedMotion();
  const characterState = characterStateFor(phase);
  const motionMode = motionModeFor(reducedMotion);

  return (
    <main className="pet-shell" aria-label="AI Pet 桌宠">
      <div className="pet-drag-hint" aria-hidden="true">拖动我</div>
      <PetOpenChatButton>
        <CharacterPlayer
          stateId={characterState}
          motionMode={motionMode}
          fallback={(
            <PetCharacter state={characterState} motionMode={motionMode} />
          )}
        />
      </PetOpenChatButton>
    </main>
  );
}
