import { access, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const rules = {
  main: [
    '@modelcontextprotocol/sdk',
    'McpManager',
    'McpServerStore',
    'MCP_MODULE_DISABLED',
    'settings:mcp-'
  ],
  preload: [
    'settings:mcp-',
    'upsertMcpServer',
    'confirmMcpLaunch',
    'testMcpServer',
    'setMcpServerEnabled',
    'setMcpToolEnabled',
    'authorizeMcpToolReadOnly',
    'revokeMcpToolReadOnly',
    'deleteMcpServer'
  ],
  renderer: ['upsertMcpServer', 'MCP 服务', '.mcp-server']
};

const outputRoot = resolve(
  process.argv[2] ?? fileURLToPath(new URL('../out', import.meta.url))
);

await access(outputRoot);

async function readOrdinaryFiles(directory) {
  const contents = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      contents.push(...await readOrdinaryFiles(entryPath));
    } else if (entry.isFile()) {
      contents.push(await readFile(entryPath, 'utf8'));
    }
  }
  return contents;
}

for (const [kind, markers] of Object.entries(rules)) {
  const contents = await readOrdinaryFiles(join(outputRoot, kind));
  for (const marker of markers) {
    if (contents.some(content => content.includes(marker))) {
      console.error(`MCP_PRODUCTION_BOUNDARY_FAILED ${kind} ${marker}`);
      process.exitCode = 1;
    }
  }
}
