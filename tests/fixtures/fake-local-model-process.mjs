import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isDeepStrictEqual } from 'node:util';

const decisionSchema = { anyOf: [
  { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['task'] }, text: { type: 'string', enum: [''] }
  }, required: ['kind', 'text'] },
  { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['chat'] },
    text: { type: 'string', minLength: 1, maxLength: 4000 }
  }, required: ['kind', 'text'] }
] };

/** 表现协议以严格根字段集合识别，不能把任意 JSON 请求当成会话判别。 */
function hasObjectSchemaFields(schema, fields) {
  return schema?.type === 'object' && schema.additionalProperties === false
    && Array.isArray(schema.required) && schema.properties !== null
    && typeof schema.properties === 'object'
    && isDeepStrictEqual([...schema.required].sort(), [...fields].sort())
    && isDeepStrictEqual(Object.keys(schema.properties).sort(), [...fields].sort());
}

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
  const schema = body.response_format?.type === 'json_object' ? body.response_format.schema : undefined;
  let output;
  if (isDeepStrictEqual(schema, decisionSchema)) {
    // 仅为当前生命周期样例提供固定结果，任务只能申请原范围卡。
    output = latestUser?.content === '请创建 switch-stale.txt'
      ? { kind: 'task', text: '' }
      : { kind: 'chat', text: '本地模型 fixture 回复' };
  } else if (hasObjectSchemaFields(schema, ['moodUpdate', 'expressionPlan', 'backgroundSelection', 'requestKind', 'explicitPlayback', 'movementControl'])
    && isDeepStrictEqual(schema.properties.requestKind, { enum: ['ambient', 'state', 'action', 'movement'] })) {
    output = { moodUpdate: null, expressionPlan: null, backgroundSelection: null, requestKind: 'ambient',
      explicitPlayback: null, movementControl: { kind: 'keep' } };
  } else if (hasObjectSchemaFields(schema, ['moodUpdate', 'expressionPlan', 'backgroundSelection'])) {
    output = { moodUpdate: null, expressionPlan: null, backgroundSelection: null };
  } else {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'LOCAL_MODEL_E2E_SCHEMA_UNSUPPORTED' } }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(output) } }],
    fixture_canary: 'body-canary-local-electron'
  }));
});

server.listen(port, '127.0.0.1');
const close = () => server.close(() => process.exit(0));
process.once('SIGTERM', close);
process.once('SIGINT', close);
