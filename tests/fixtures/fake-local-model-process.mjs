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

const strictObject = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const expressionSchema = strictObject({
  kind: { enum: ['none', 'reaction', 'state', 'action', 'background', 'movement'] },
  choice: { anyOf: [strictObject({ stateId: { type: 'string' }, actionId: { type: 'string' } }), { type: 'null' }] },
  mode: { enum: ['keep', 'still', 'continuous', 'intermittent', 'once'] },
  target: { anyOf: [{ enum: ['random_work_area', 'left', 'right', 'top', 'bottom', 'top_left', 'top_right', 'bottom_left', 'bottom_right'] }, { type: 'null' }] },
  distance: { anyOf: [{ enum: ['near', 'medium', 'far'] }, { type: 'null' }] }
});
const autonomySchema = { ...expressionSchema, properties: { ...expressionSchema.properties,
  kind: { enum: ['none', 'reaction', 'background'] }, mode: { const: 'keep' }, target: { type: 'null' }, distance: { type: 'null' }
} };
const behaviorRoles = ['chatting', 'taskRunning', 'awaitingConfirmation', 'moving', 'success', 'error', 'praise', 'boredom', 'rest'];

/** 作者配对随角色变化；重建完整严格结构，不能只靠九个字段放行任意 Schema。 */
function isBindingsSchema(schema) {
  const choices = schema?.$defs?.choice?.anyOf;
  if (!Array.isArray(choices) || choices.length < 2 || !isDeepStrictEqual(choices.at(-1), { type: 'null' })) return false;
  const pairs = choices.slice(0, -1).map(choice => ({ stateId: choice?.properties?.stateId?.const,
    actionId: choice?.properties?.actionId?.const }));
  if (pairs.some(pair => typeof pair.stateId !== 'string' || !pair.stateId || typeof pair.actionId !== 'string' || !pair.actionId)) return false;
  return isDeepStrictEqual(schema, { ...strictObject(Object.fromEntries(behaviorRoles.map(role => [role, { $ref: '#/$defs/choice' }]))),
    $defs: { choice: { anyOf: [...pairs.map(pair => strictObject({ stateId: { const: pair.stateId }, actionId: { const: pair.actionId } })), { type: 'null' }] } }
  });
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
  } else if (isDeepStrictEqual(schema, expressionSchema) || isDeepStrictEqual(schema, autonomySchema)) {
    output = { kind: 'none', choice: null, mode: 'keep', target: null, distance: null };
  } else if (isBindingsSchema(schema)) {
    // 协议夹具不模拟作者语义理解；完整返回明确未匹配的九项用途。
    output = Object.fromEntries(behaviorRoles.map(role => [role, null]));
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
