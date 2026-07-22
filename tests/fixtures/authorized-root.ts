import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileToolService, PathPolicy } from '@myself/file-tools';
import { FileToolService as RealFileToolService, PathPolicy as RealPathPolicy } from '@myself/file-tools';

export interface AuthorizedRootFixture {
  base: string;
  root: string;
  policy: PathPolicy;
  fileTools: FileToolService;
  cleanup(): Promise<void>;
}

export async function createAuthorizedRoot(): Promise<AuthorizedRootFixture> {
  const base = await mkdtemp(join(tmpdir(), 'myself-task-9a-'));
  const root = join(base, 'authorized');
  await mkdir(join(root, 'docs'), { recursive: true });
  const policy = await RealPathPolicy.create(root);
  return {
    base,
    root,
    policy,
    fileTools: new RealFileToolService(policy),
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    }
  };
}
