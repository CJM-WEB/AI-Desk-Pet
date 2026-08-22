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

// 三类产物使用各自的精确规则，避免持久化兼容代码中的 MCP 字样形成跨产物假阳性。
async function readOrdinaryFiles(directory) {
  const contents = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      contents.push(...await readOrdinaryFiles(entryPath));
    } else if (entry.isFile()) {
      // 只扫描普通文件；Buffer 字节搜索不会因非 UTF-8 产物产生替换字符或解码异常。
      contents.push(await readFile(entryPath));
    }
  }
  return contents;
}

function reportIoFailure(kind) {
  // 根目录、遍历和读取错误全部 fail-closed；不得把路径、系统错误或堆栈带入构建日志。
  console.error(`MCP_PRODUCTION_BOUNDARY_FAILED ${kind} IO_ERROR`);
  process.exitCode = 1;
}

async function verifyProductionBoundary() {
  try {
    await access(outputRoot);
  } catch {
    reportIoFailure('root');
    return;
  }

  for (const [kind, markers] of Object.entries(rules)) {
    try {
      const contents = await readOrdinaryFiles(join(outputRoot, kind));
      for (const marker of markers) {
        const markerBytes = Buffer.from(marker, 'utf8');
        if (contents.some(content => content.includes(markerBytes))) {
          console.error(`MCP_PRODUCTION_BOUNDARY_FAILED ${kind} ${marker}`);
          process.exitCode = 1;
        }
      }
    } catch {
      reportIoFailure(kind);
    }
  }
}

await verifyProductionBoundary().catch(() => reportIoFailure('root'));
