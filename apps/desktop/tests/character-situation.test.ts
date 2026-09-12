import { expect, test } from 'vitest';
import { CharacterSituation } from '../src/main/characters/character-situation';

test('仅真实互动刷新陪伴计时，任务阶段和结果不充当互动', () => {
  let now = 0;
  const situation = new CharacterSituation(() => now, () => 21);
  situation.noteInteraction('chat');
  now = 300_000;
  expect(situation.snapshot().idleForMs).toBe(300_000);
  situation.noteTaskPhase('running');
  now = 1_200_000;
  situation.noteTaskPhase('success');
  expect(situation.snapshot()).toMatchObject({ idleForMs: 1_200_000, sessionForMs: 1_200_000,
    localHour: 21, lastInteractionKind: 'chat', interactionCount: 1,
    lastTask: { outcome: 'success', agoMs: 0, durationMs: 900_000 } });
  now = 2_400_000;
  expect(situation.snapshot()).toMatchObject({ idleForMs: 2_400_000, interactionCount: 0,
    lastTask: { outcome: 'success', agoMs: 1_200_000 } });
  situation.noteInteraction('drag');
  expect(situation.snapshot()).toMatchObject({ idleForMs: 0, lastInteractionKind: 'drag', interactionCount: 1 });
});

test('状态和活动时长来自宿主时钟，停止活动后不继续累计', () => {
  let now = 0;
  const situation = new CharacterSituation(() => now, () => 8);
  situation.updateActivities({ moving: true, chatting: false });
  now = 600_000;
  expect(situation.snapshot({ stateEnteredAtMs: 500_000, backgroundEnteredAtMs: 100_000 })).toMatchObject({
    stateForMs: 100_000, backgroundForMs: 500_000, activities: { moving: 600_000 }
  });
  situation.updateActivities({ moving: false });
  now = 700_000;
  expect(situation.snapshot().activities).not.toHaveProperty('moving');
  situation.reset();
  expect(situation.snapshot().lastTask).toBeNull();
  expect(situation.snapshot().sessionForMs).toBe(700_000);
});
