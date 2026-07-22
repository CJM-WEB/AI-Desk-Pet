import type { PublicSettings, TaskEvent } from '@myself/shared-types';

export type LocalDataScope = 'conversation' | 'audit' | 'secret' | 'all';

export interface MyselfApi {
  getStatus(): Promise<{ version: string; ready: boolean }>;
  getSettings(): Promise<PublicSettings>;
  saveProvider(input: unknown): Promise<PublicSettings>;
  testProvider(): Promise<{ ok: boolean; message: string }>;
  chooseAuthorizedRoot(): Promise<PublicSettings>;
  clearLocalData(scope: LocalDataScope): Promise<PublicSettings>;
  submitMessage(text: string): Promise<void>;
  cancelTask(): Promise<void>;
  confirmAction(actionId: string): Promise<void>;
  cancelAction(actionId: string): Promise<void>;
  onTaskEvent(listener: (event: TaskEvent) => void): () => void;
  openChat(): Promise<void>;
  openSettings(): Promise<void>;
  hideChat(): Promise<void>;
  quit(): Promise<void>;
}
