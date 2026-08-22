import type { ModelProvider } from '@myself/agent-core';
import { characterBehaviorPlanSchema, type CharacterBehaviorPlan } from '@myself/character-runtime';
import { z } from 'zod';
import {
  characterChatResponseContract,
  characterJsonOutputInstructions
} from '../conversation/conversation-chat-adapter';
import type { ConversationBehaviorContext } from './character-behavior-director';

export interface BehaviorReflectionAdapter {
  reflect(input: Readonly<{
    context: ConversationBehaviorContext;
    signal: AbortSignal;
  }>): Promise<CharacterBehaviorPlan | null>;
  close(): Promise<void>;
}

const durationSchema = z.number().finite().nonnegative();
export const reflectionDiagnosticSchema = z.discriminatedUnion('phase', [
  z.object({
    code: z.literal('BEHAVIOR_REFLECTION_STARTED'),
    phase: z.literal('started')
  }).strict(),
  z.object({
    code: z.literal('BEHAVIOR_REFLECTION_COMPLETED'),
    phase: z.literal('completed'),
    hadPlan: z.boolean(),
    durationMs: durationSchema
  }).strict(),
  z.object({
    code: z.literal('BEHAVIOR_REFLECTION_DROPPED'),
    phase: z.literal('dropped'),
    durationMs: durationSchema.optional(),
    reasonCode: z.enum([
      'NO_PLAN',
      'INVALID_PLAN',
      'BLOCKED',
      'ABORTED',
      'PROVIDER_ERROR',
      'STALE_GENERATION'
    ])
  }).strict()
]);
export type BehaviorReflectionDiagnostic = Readonly<z.infer<typeof reflectionDiagnosticSchema>>;

/** 会话诊断端口在发布前执行严格白名单校验，订阅者永远收不到 Provider 正文。 */
export class BehaviorReflectionDiagnosticPort {
  private readonly listeners = new Set<(event: BehaviorReflectionDiagnostic) => void>();

  publish(raw: unknown): void {
    const event = reflectionDiagnosticSchema.parse(raw);
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // 诊断订阅者属于非关键观测路径，失败不得改变反思结果。
      }
    }
  }

  subscribe(listener: (event: BehaviorReflectionDiagnostic) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
  }
}

type BehaviorReflectionAdapterOptions = Readonly<{
  createProvider(): ModelProvider | Promise<ModelProvider>;
  diagnostics: BehaviorReflectionDiagnosticPort;
  now?: () => number;
}>;

const reflectionSystemMessage = [
  '你是 AI 桌宠的静默行为反思器。',
  '只依据给出的公开角色能力与布尔运行态建议一个行为计划。',
  '不得请求工具、文件、命令、历史或额外消息。',
  characterJsonOutputInstructions,
  'text 仅作为协议占位且不会展示给用户。'
].join('');

/** 反思适配器只拥有 Provider 工厂、公开上下文和脱敏诊断端口。 */
export function createBehaviorReflectionAdapter(
  options: BehaviorReflectionAdapterOptions
): BehaviorReflectionAdapter {
  const now = options.now ?? performance.now.bind(performance);
  const lifecycleAbort = new AbortController();
  let generation = 0;
  let closed = false;
  const inFlight = new Set<Promise<CharacterBehaviorPlan | null>>();

  return {
    reflect(input): Promise<CharacterBehaviorPlan | null> {
      const pending = runReflection(input);
      inFlight.add(pending);
      void pending.then(
        () => inFlight.delete(pending),
        () => inFlight.delete(pending)
      );
      return pending;
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        generation += 1;
        lifecycleAbort.abort();
      }
      await Promise.allSettled([...inFlight]);
    }
  };

  async function runReflection(input: Readonly<{
    context: ConversationBehaviorContext;
    signal: AbortSignal;
  }>): Promise<CharacterBehaviorPlan | null> {
      const startedAt = now();
      const currentGeneration = ++generation;
      options.diagnostics.publish({
        code: 'BEHAVIOR_REFLECTION_STARTED',
        phase: 'started'
      });

      if (isContextBlocked(input.context)) {
        publishDropped('BLOCKED', startedAt);
        return null;
      }
      if (closed || input.signal.aborted || lifecycleAbort.signal.aborted) {
        publishDropped('ABORTED', startedAt);
        return null;
      }

      const signal = AbortSignal.any([input.signal, lifecycleAbort.signal]);
      try {
        const provider = await options.createProvider();
        if (currentGeneration !== generation) {
          publishDropped('STALE_GENERATION', startedAt);
          return null;
        }
        if (signal.aborted) {
          publishDropped('ABORTED', startedAt);
          return null;
        }
        const response = await provider.respond({
          messages: [
            { role: 'system', content: reflectionSystemMessage },
            { role: 'user', content: JSON.stringify(input.context) }
          ],
          tools: [],
          toolChoice: 'none',
          reasoningMode: 'provider_default',
          responseContract: characterChatResponseContract
        }, signal);

        if (currentGeneration !== generation) {
          publishDropped('STALE_GENERATION', startedAt);
          return null;
        }
        if (signal.aborted) {
          publishDropped('ABORTED', startedAt);
          return null;
        }
        if (response.type !== 'text') {
          publishDropped('INVALID_PLAN', startedAt);
          return null;
        }
        const rawPlan = response.structured_output?.behaviorPlan;
        if (rawPlan === undefined) {
          publishDropped('NO_PLAN', startedAt);
          return null;
        }
        const parsed = characterBehaviorPlanSchema.safeParse(rawPlan);
        if (!parsed.success) {
          publishDropped('INVALID_PLAN', startedAt);
          return null;
        }
        if (parsed.data.kind === 'none') {
          publishDropped('NO_PLAN', startedAt);
          return null;
        }
        if (!isExecutableReflectionPlan(parsed.data)) {
          publishDropped('INVALID_PLAN', startedAt);
          return null;
        }
        options.diagnostics.publish({
          code: 'BEHAVIOR_REFLECTION_COMPLETED',
          phase: 'completed',
          hadPlan: true,
          durationMs: elapsed(startedAt)
        });
        if (parsed.data.kind === 'play') {
          return parsed.data.emotion === undefined
            ? { kind: 'play', target: parsed.data.target }
            : {
                kind: 'play',
                target: parsed.data.target,
                emotion: parsed.data.emotion
              };
        }
        return parsed.data;
      } catch {
        if (currentGeneration !== generation) {
          publishDropped('STALE_GENERATION', startedAt);
          return null;
        }
        if (signal.aborted) {
          publishDropped('ABORTED', startedAt);
          return null;
        }
        publishDropped('PROVIDER_ERROR', startedAt);
        throw new Error('BEHAVIOR_REFLECTION_PROVIDER_ERROR');
      }
  }

  function publishDropped(
    reasonCode: Extract<BehaviorReflectionDiagnostic, { phase: 'dropped' }>['reasonCode'],
    startedAt: number
  ): void {
    options.diagnostics.publish({
      code: 'BEHAVIOR_REFLECTION_DROPPED',
      phase: 'dropped',
      durationMs: elapsed(startedAt),
      reasonCode
    });
  }

  function elapsed(startedAt: number): number {
    return Math.max(0, now() - startedAt);
  }
}

function isExecutableReflectionPlan(
  plan: z.infer<typeof characterBehaviorPlanSchema>
): boolean {
  if (plan.kind === 'move') return plan.distance === 'near';
  if (plan.kind !== 'play') return false;
  return plan.target.kind !== 'semantic' || plan.target.semantic !== 'move';
}

function isContextBlocked(context: ConversationBehaviorContext): boolean {
  return context.runtime.moving
    || context.runtime.dragging
    || context.runtime.movementStopped;
}
