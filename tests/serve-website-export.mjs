import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const host = '127.0.0.1';
const port = 4173;
const exportRoot = resolve(process.cwd(), 'apps/website/out');
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp']
]);

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
      'content-type': contentTypes.get(extname(filePath)) ?? 'application/octet-stream'
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

server.listen(port, host);
