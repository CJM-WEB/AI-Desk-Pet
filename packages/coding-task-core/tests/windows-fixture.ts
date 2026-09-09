import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppProcess } from '@opencode-ai/core/process';
import { CrossSpawnSpawner } from '@opencode-ai/core/cross-spawn-spawner';
import { LayerNode } from '@opencode-ai/core/effect/layer-node';
import { windowsJobLayer, type WindowsJobHelper } from '../src/windows-job-spawner';
import { createHash } from 'node:crypto';

export async function ripgrepExecutable() {
  const executablePath = process.env.CODING_TEST_RIPGREP ?? resolve(import.meta.dirname, '../dist/rg.exe');
  return { executablePath, sha256: createHash('sha256').update(await readFile(executablePath)).digest('hex') };
}

export async function helper(): Promise<WindowsJobHelper> {
  const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../dist/windows-job-helper.json'), 'utf8')) as { sha256: string };
  return { executablePath: resolve(import.meta.dirname, '../dist/windows-job-helper.exe'), sha256: manifest.sha256 };
}
export async function processRuntime(trusted?: WindowsJobHelper, onFailure?: (error: Error) => void) {
  return LayerNode.compile(AppProcess.node, [[CrossSpawnSpawner.node, windowsJobLayer(trusted ?? await helper(), onFailure)]]);
}
export async function until(check: () => Promise<boolean>, budget = 5000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('真实进程观察超时');
}
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
