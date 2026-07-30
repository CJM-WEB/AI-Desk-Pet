import type { CharacterState } from '@myself/character-runtime';

export type CharacterPresentation = {
  face: string;
  label: string;
  detail: string;
};

const presentations: Record<CharacterState, CharacterPresentation> = {
  idle: { face: '•ᴗ•', label: '在你身边', detail: '随时可以聊聊' },
  listening: { face: '◕ᴗ◕', label: '正在听你说', detail: '我会认真记住' },
  thinking: { face: '•﹏•', label: '正在认真想', detail: '很快就回来' },
  moving: { face: '•ᴗ•', label: '正在移动', detail: '去往合适的位置' },
  acting: { face: '•̀ᴗ•́', label: '正在帮你处理', detail: '只在授权范围内行动' },
  carrying: { face: '•̀ᴗ•́', label: '正在搬运', detail: '稳稳带着文件移动' },
  success: { face: '★ᴗ★', label: '顺利完成啦', detail: '我们又完成了一件事' },
  error: { face: '•︵•', label: '遇到一点问题', detail: '别担心，可以一起解决' }
};

export function presentationFor(state: CharacterState): CharacterPresentation {
  return presentations[state];
}
