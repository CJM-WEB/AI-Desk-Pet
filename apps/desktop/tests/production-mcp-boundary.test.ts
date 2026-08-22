import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const verifier = fileURLToPath(new URL('../scripts/verify-production-mcp-boundary.mjs', import.meta.url));
const temporaryRoots: string[] = [];

const forbiddenMarkers = [
  ['main', '@modelcontextprotocol/sdk'],
  ['main', 'McpManager'],
  ['main', 'McpServerStore'],
  ['main', 'MCP_MODULE_DISABLED'],
  ['main', 'settings:mcp-'],
  ['preload', 'settings:mcp-'],
  ['preload', 'upsertMcpServer'],
  ['preload', 'confirmMcpLaunch'],
  ['preload', 'testMcpServer'],
  ['preload', 'setMcpServerEnabled'],
  ['preload', 'setMcpToolEnabled'],
  ['preload', 'authorizeMcpToolReadOnly'],
  ['preload', 'revokeMcpToolReadOnly'],
  ['preload', 'deleteMcpServer'],
  ['renderer', 'upsertMcpServer'],
  ['renderer', 'MCP 服务'],
  ['renderer', '.mcp-server']
] as const;

async function createOutputFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ai-pet-production-mcp-boundary-'));
  temporaryRoots.push(root);
  await Promise.all(
    ['main', 'preload', 'renderer'].map(kind => mkdir(join(root, kind), { recursive: true }))
  );
  return root;
}

async function runVerifier(root: string) {
  const result = await execFileAsync(process.execPath, [verifier, root]);
  return { code: 0, stdout: result.stdout, stderr: result.stderr };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('MCP 正式产物边界校验器', () => {
  test('允许不含禁止标记的完整产物目录', async () => {
    const root = await createOutputFixture();
    await writeFile(join(root, 'main', 'index.js'), 'const feature = "chat";', 'utf8');

    await expect(runVerifier(root)).resolves.toEqual({ code: 0, stdout: '', stderr: '' });
  });

  test.each(forbiddenMarkers)('%s 产物拒绝单一标记 %s', async (kind, marker) => {
    const root = await createOutputFixture();
    await writeFile(join(root, kind, 'chunk.js'), marker, 'utf8');

    await expect(runVerifier(root)).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: `MCP_PRODUCTION_BOUNDARY_FAILED ${kind} ${marker}\n`
    });
  });

  test('递归拒绝嵌套产物中的禁止标记', async () => {
    const root = await createOutputFixture();
    const nestedDirectory = join(root, 'main', 'assets');
    await mkdir(nestedDirectory);
    await writeFile(join(nestedDirectory, 'chunk.js'), 'McpManager', 'utf8');

    await expect(runVerifier(root)).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: 'MCP_PRODUCTION_BOUNDARY_FAILED main McpManager\n'
    });
  });
});
