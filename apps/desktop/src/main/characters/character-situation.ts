import type { CharacterRuntimeFacts } from '@myself/character-runtime';

export type CharacterInteractionKind = 'chat' | 'click' | 'drag' | 'control';
export type CharacterTaskPhase = 'running' | 'waiting' | 'success' | 'error' | 'cancelled';
export type CharacterSituationSnapshot = Readonly<{
  idleForMs: number; sessionForMs: number; localHour: number;
  lastInteractionKind: CharacterInteractionKind | null; interactionCount: number;
  stateForMs: number; backgroundForMs: number | null;
  activities: Partial<Record<keyof CharacterRuntimeFacts, number>>;
  taskPhase: 'running' | 'waiting' | null;
  lastTask: { outcome: 'success' | 'error' | 'cancelled'; agoMs: number; durationMs: number } | null;
}>;

/** 只保存有界运行期时间与事件类别；没有文件正文、路径或持久化入口。 */
export class CharacterSituation {
  private readonly startedAt: number;
  private lastInteractionAt: number;
  private interactionKind: CharacterInteractionKind | null = null;
  private interactions: number[] = [];
  private readonly activities = new Map<keyof CharacterRuntimeFacts, number>();
  private task: { phase: 'running' | 'waiting'; startedAt: number } | null = null;
  private lastTask: { outcome: 'success' | 'error' | 'cancelled'; endedAt: number; durationMs: number } | null = null;
  constructor(private readonly now: () => number, private readonly localHour = () => new Date().getHours()) {
    this.startedAt = this.lastInteractionAt = now();
  }
  noteInteraction(kind: CharacterInteractionKind): void {
    this.lastInteractionAt = this.now(); this.interactionKind = kind;
    this.interactions.push(this.lastInteractionAt);
    this.interactions = this.interactions.filter(time => time >= this.now() - 1_800_000).slice(-1024);
  }
  noteTaskPhase(phase: CharacterTaskPhase): void {
    if (phase === 'running' || phase === 'waiting') {
      this.task = { phase, startedAt: this.task?.startedAt ?? this.now() };
    } else {
      this.lastTask = { outcome: phase, endedAt: this.now(), durationMs: this.elapsed(this.task?.startedAt ?? this.now()) };
      this.task = null;
    }
  }
  updateActivities(facts: Partial<CharacterRuntimeFacts>): void {
    for (const key of Object.keys(facts) as Array<keyof CharacterRuntimeFacts>) {
      if (facts[key]) { if (!this.activities.has(key)) this.activities.set(key, this.now()); }
      else this.activities.delete(key);
    }
  }
  snapshot(input: { stateEnteredAtMs?: number; backgroundEnteredAtMs?: number } = {}): CharacterSituationSnapshot {
    this.interactions = this.interactions.filter(time => time >= this.now() - 1_800_000);
    return {
      idleForMs: this.elapsed(this.lastInteractionAt), sessionForMs: this.elapsed(this.startedAt),
      localHour: this.localHour(), lastInteractionKind: this.interactionKind, interactionCount: this.interactions.length,
      stateForMs: this.elapsed(input.stateEnteredAtMs ?? this.now()),
      backgroundForMs: input.backgroundEnteredAtMs === undefined ? null : this.elapsed(input.backgroundEnteredAtMs),
      activities: Object.fromEntries([...this.activities].map(([key, start]) => [key, this.elapsed(start)])),
      taskPhase: this.task?.phase ?? null,
      lastTask: this.lastTask && { outcome: this.lastTask.outcome, agoMs: this.elapsed(this.lastTask.endedAt), durationMs: this.lastTask.durationMs }
    };
  }
  reset(): void { this.task = null; this.lastTask = null; this.activities.clear(); }
  private elapsed(start: number): number { return Math.max(0, this.now() - start); }
}
