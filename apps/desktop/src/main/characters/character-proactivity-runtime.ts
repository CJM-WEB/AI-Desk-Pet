import type { ModelProvider } from '@myself/agent-core';
import {
  BehaviorReflectionDiagnosticPort,
  createBehaviorReflectionAdapter,
  type BehaviorReflectionAdapter,
  type BehaviorReflectionDiagnostic
} from './behavior-reflection-adapter';
import type { CharacterBehaviorDirector } from './character-behavior-director';
import { CharacterProactivityScheduler } from './character-proactivity-scheduler';

type DiagnosticPort = Pick<
  BehaviorReflectionDiagnosticPort,
  'subscribe' | 'close'
> & { publish?(event: unknown): void };

type RuntimeFactories = Readonly<{
  createDiagnostics(): DiagnosticPort;
  createReflection(options: Readonly<{
    createProvider(): ModelProvider | Promise<ModelProvider>;
    diagnostics: DiagnosticPort;
  }>): BehaviorReflectionAdapter;
  createScheduler(options: Readonly<{
    director: CharacterBehaviorDirector;
    reflection: BehaviorReflectionAdapter;
  }>): Pick<CharacterProactivityScheduler, 'start' | 'close'>;
}>;

type CharacterProactivityRuntimeOptions = Readonly<{
  director: CharacterBehaviorDirector;
  createProvider(): ModelProvider | Promise<ModelProvider>;
  publishDiagnostic(event: BehaviorReflectionDiagnostic): void;
  advanceBehavior(): void;
  advanceFileTaskTransaction(): void;
  factories?: Partial<RuntimeFactories>;
}>;

/** 生产组合独占一组 Scheduler、Reflection 与诊断端口，并统一关闭顺序。 */
export function createCharacterProactivityRuntime(options: CharacterProactivityRuntimeOptions) {
  const diagnostics = (options.factories?.createDiagnostics ?? (
    () => new BehaviorReflectionDiagnosticPort()
  ))();
  const releaseDiagnostics = diagnostics.subscribe(options.publishDiagnostic);
  const reflection = (options.factories?.createReflection ?? ((input) => (
    createBehaviorReflectionAdapter({
      createProvider: input.createProvider,
      diagnostics: input.diagnostics as BehaviorReflectionDiagnosticPort
    })
  )))({ createProvider: options.createProvider, diagnostics });
  const scheduler = (options.factories?.createScheduler ?? ((input) => (
    new CharacterProactivityScheduler(input)
  )))({ director: options.director, reflection });
  let closePromise: Promise<void> | null = null;

  return {
    start(): void {
      scheduler.start();
    },
    invalidate(): void {
      options.director.invalidateBehaviorLifecycle();
    },
    poll(): void {
      options.advanceBehavior();
      options.advanceFileTaskTransaction();
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        await scheduler.close();
        releaseDiagnostics();
        diagnostics.close();
      })();
      return closePromise;
    }
  };
}
