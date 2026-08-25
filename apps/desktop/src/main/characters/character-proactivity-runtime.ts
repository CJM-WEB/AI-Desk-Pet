import type { CharacterBehaviorDirector } from './character-behavior-director';
import { CharacterProactivityScheduler } from './character-proactivity-scheduler';

type RuntimeFactories = Readonly<{
  createScheduler(options: Readonly<{
    director: CharacterBehaviorDirector;
  }>): Pick<CharacterProactivityScheduler, 'start' | 'close'>;
}>;

type CharacterProactivityRuntimeOptions = Readonly<{
  director: CharacterBehaviorDirector;
  advanceBehavior(): void;
  factories?: Partial<RuntimeFactories>;
}>;

/** 生产组合只保留本地 10–30 秒主动时钟，不再创建自主 Provider 反思链。 */
export function createCharacterProactivityRuntime(options: CharacterProactivityRuntimeOptions) {
  const scheduler = (options.factories?.createScheduler ?? ((input) => (
    new CharacterProactivityScheduler(input)
  )))({ director: options.director });
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
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        await scheduler.close();
      })();
      return closePromise;
    }
  };
}
