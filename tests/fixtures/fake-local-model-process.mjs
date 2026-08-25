import { existsSync } from 'node:fs';
import { createServer } from 'node:http';

const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const separator = argument.indexOf('=');
  return [argument.slice(2, separator), argument.slice(separator + 1)];
}));
const port = Number(options.port);
const token = options.token;
const readyFile = options['ready-file'];
const stderrCanary = options['stderr-canary'];
if (!Number.isSafeInteger(port) || port <= 0 || !token || !readyFile || !stderrCanary) {
  process.exitCode = 2;
  throw new Error('LOCAL_MODEL_E2E_ARGUMENTS_INVALID');
}

process.stderr.write(stderrCanary);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/health') {
    const ready = existsSync(readyFile);
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: ready ? 'ok' : 'loading' }));
    return;
  }
  if (
    request.method !== 'POST'
    || url.pathname !== '/v1/chat/completions'
    || request.headers.authorization !== `Bearer ${token}`
  ) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'LOCAL_MODEL_E2E_REQUEST_INVALID' } }));
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 1024 * 1024) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(bytes);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const latestUser = [...body.messages].reverse().find(message => message.role === 'user');
  const wantsStaleFile = Array.isArray(body.tools)
    && body.tools.length > 0
    && typeof latestUser?.content === 'string'
    && latestUser.content.includes('switch-stale.txt');
  const message = wantsStaleFile
    ? {
        content: null,
        tool_calls: [{
          id: 'local-e2e-stale-action',
          type: 'function',
          function: {
            name: 'builtin__files__create_file',
            arguments: JSON.stringify({ relativePath: 'switch-stale.txt', content: '' })
          }
        }]
      }
    : { content: '本地模型 fixture 回复' };
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    choices: [{ message }],
    fixture_canary: 'body-canary-local-electron'
  }));
});

server.listen(port, '127.0.0.1');
const close = () => server.close(() => process.exit(0));
process.once('SIGTERM', close);
process.once('SIGINT', close);
