import { z } from 'zod';

/** 心情低于该宿主阈值后结束；表现投影复用同一值，避免模型配置运行寿命。 */
export const MIN_ACTIVE_MOOD_STRENGTH = .02;

export const characterMoodUpdateSchema = z.object({
  summary: z.string().trim().min(1).max(240), strength: z.number().finite().min(0).max(1),
  fadeInMs: z.number().finite().int().min(0).max(300_000).optional(),
  halfLifeMs: z.number().finite().int().min(30_000).max(1_800_000).default(300_000)
}).strict();
export type CharacterMoodUpdate = z.input<typeof characterMoodUpdateSchema>;
export type CharacterMood = {
  summary: string; targetStrength: number; startedAtMs: number; fadeInMs: number;
  halfLifeMs: number; revision: number; sourceEventId: string;
};
export type CharacterMoodSnapshot = CharacterMood & { strength: number };

/** 渐入结束后才开始半衰；只求值，不读取系统时间或改变修订。 */
export function sampleMood(mood: CharacterMood | null, nowMs: number): CharacterMoodSnapshot | null {
  if (!mood) return null;
  const elapsed = Math.max(0, nowMs - mood.startedAtMs);
  const strength = elapsed < mood.fadeInMs
    ? mood.targetStrength * elapsed / mood.fadeInMs
    : mood.targetStrength * 2 ** (-(elapsed - mood.fadeInMs) / mood.halfLifeMs);
  return elapsed >= mood.fadeInMs && strength < MIN_ACTIVE_MOOD_STRENGTH ? null : { ...mood, strength };
}
