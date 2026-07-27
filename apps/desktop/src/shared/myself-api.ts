import type { PublicSettings, TaskEvent } from '@myself/shared-types';

export type LocalDataScope = 'conversation' | 'audit' | 'secret' | 'all';

export interface SaveProviderInput {
  profileId?: string;
  displayName: string;
  baseUrl: string;
  model: string;
  secret: string;
  persistSecret: boolean;
}

export interface MyselfApi {
  getStatus(): Promise<{ version: string; ready: boolean }>;
  getSettings(): Promise<PublicSettings>;
  saveProvider(input: SaveProviderInput): Promise<PublicSettings>;
  testProvider(): Promise<{ ok: boolean; message: string }>;
  chooseAuthorizedRoot(): Promise<PublicSettings>;
  clearLocalData(scope: LocalDataScope, profileId?: string): Promise<PublicSettings>;
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
