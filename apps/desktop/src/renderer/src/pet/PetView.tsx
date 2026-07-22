import { useEffect, useState, type ReactNode } from 'react';
import {
  characterStateFor,
  motionModeFor,
  type CharacterMotionMode,
  type CharacterState
} from '@myself/character-runtime';
import { presentationFor } from '../character/state-map';
import { useTaskStore } from '../stores/task-store';

export interface PetCharacterProps {
  state: CharacterState;
  motionMode: CharacterMotionMode;
}

export function PetCharacter({ state, motionMode }: PetCharacterProps) {
  const presentation = presentationFor(state);
  return (
    <div
      className="pet-character"
      data-state={state}
      data-motion={motionMode}
      aria-label={`Myself：${presentation.label}`}
    >
      <span className="pet-ear pet-ear-left" aria-hidden="true" />
      <span className="pet-ear pet-ear-right" aria-hidden="true" />
      <div className="pet-body">
        <span className="pet-glow" aria-hidden="true" />
        <span className="pet-face" aria-hidden="true">{presentation.face}</span>
        <strong>Myself</strong>
        <span className="pet-state-label">{presentation.label}</span>
        <span className="pet-state-detail">{presentation.detail}</span>
      </div>
    </div>
  );
}

/** 桌宠按钮始终调用 preload 暴露的正式打开聊天命令。 */
export function PetOpenChatButton({ children }: { children: ReactNode }) {
  return (
    <button
      className="pet-open-chat no-drag"
      type="button"
      aria-label="打开与 Myself 的聊天"
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

  return (
    <main className="pet-shell" aria-label="Myself 桌宠">
      <div className="pet-drag-hint" aria-hidden="true">拖动我</div>
      <PetOpenChatButton>
        <PetCharacter state={characterState} motionMode={motionModeFor(reducedMotion)} />
      </PetOpenChatButton>
    </main>
  );
}
