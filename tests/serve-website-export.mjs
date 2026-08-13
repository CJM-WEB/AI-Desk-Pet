import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { createMemoryWebsiteApi } from './memory-website-api.mjs';

const host = '127.0.0.1';
const configuredPort = Number.parseInt(process.env.PORT ?? '4173', 10);
const port = Number.isInteger(configuredPort) && configuredPort >= 0
  ? configuredPort
  : 4173;
const testRunId = process.env.WEBSITE_TEST_RUN_ID ?? 'manual';
const exportRoot = resolve(process.cwd(), 'apps/website/out');
const exportedIndex = await readFile(resolve(exportRoot, 'index.html'));
const buildMarker = createHash('sha256')
  .update(exportedIndex)
  .digest('hex')
  .slice(0, 16);
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp']
]);
const memoryApi = createMemoryWebsiteApi({ runId: testRunId });

async function resolveExportFile(pathname) {
  const decodedPath = decodeURIComponent(pathname);
  const requestedPath = resolve(exportRoot, `.${decodedPath}`);
  if (requestedPath !== exportRoot && !requestedPath.startsWith(`${exportRoot}${sep}`)) {
    return null;
  }

  try {
    const metadata = await stat(requestedPath);
    return metadata.isDirectory() ? resolve(requestedPath, 'index.html') : requestedPath;
  } catch {
    return null;
  }
}

const server = createServer(async (request, response) => {
  if (await memoryApi.handle(request, response)) return;
  const pathname = new URL(request.url ?? '/', `http://${host}:${port}`).pathname;
  const filePath = await resolveExportFile(pathname);
  if (!filePath) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('未找到静态资源');
    return;
  }

  try {
    const metadata = await stat(filePath);
    response.writeHead(200, {
      'content-length': metadata.size,
      'content-type': contentTypes.get(extname(filePath)) ?? 'application/octet-stream',
      'x-website-build-marker': buildMarker,
      'x-website-test-run-id': testRunId
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('未找到静态资源');
  }
});

server.listen(port, host, () => {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('无法读取静态网站服务器监听地址');
  }

  // E2E 夹具只在收到本次运行标记后才会连接，避免误用旧服务。
  console.log(`WEBSITE_SERVER_READY ${JSON.stringify({
    url: `http://${host}:${address.port}`,
    port: address.port,
    runId: testRunId,
    buildMarker
  })}`);
});
