import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const separator = argument.indexOf('=');
  return [argument.slice(2, separator), argument.slice(separator + 1)];
}));
const port = Number(options.port);
const mode = options.mode;
const tokenFile = options['token-file'];
const readyFile = options['ready-file'];
const stderrCanary = options['stderr-canary'];
if (mode === 'probe' && stderrCanary) {
  process.stderr.write(stderrCanary);
  process.exit(1);
}
if (
  mode !== 'server'
  || !Number.isSafeInteger(port)
  || port <= 0
  || !tokenFile
  || !readyFile
  || !stderrCanary
) {
  process.exitCode = 2;
  throw new Error('LOCAL_MODEL_E2E_ARGUMENTS_INVALID');
}

const token = readFileSync(tokenFile, 'utf8');
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
    : {
        content: JSON.stringify({
          text: '本地模型 fixture 回复',
          activity: '安静陪伴',
          status: 'idle',
          motionPlan: {
            mode: 'none', durationSeconds: null, target: 'current', distance: 'none'
          },
          behaviorPlan: { kind: 'none' }
        })
      };
  if (body.stream === true && !wantsStaleFile) {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache'
    });
    const midpoint = Math.floor(message.content.length / 2);
    for (const content of [message.content.slice(0, midpoint), message.content.slice(midpoint)]) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
    return;
  }
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
