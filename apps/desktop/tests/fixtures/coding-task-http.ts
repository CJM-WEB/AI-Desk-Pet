import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import type { CodingSessionEvent, CodingSessionOptions } from '@myself/coding-task-core';
const { createCodingSession }: typeof import('@myself/coding-task-core') = process.env.CODING_CORE_BUNDLE
  ? await import(pathToFileURL(process.env.CODING_CORE_BUNDLE).href)
  : await import('@myself/coding-task-core');

type ResponseStep = string | { name: string; args: Record<string, unknown>; id?: string }[];
export type Step = ResponseStep | Promise<ResponseStep>;
// 只替换模型 HTTP 响应；文件、权限、runner 和命令均走生产链。
export async function fixture(steps: Step[], host: Partial<CodingSessionOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ai-pet 任务测试-'));
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ai-pet-task-data-'));
  const events: CodingSessionEvent[] = [];
  const requests: { messages: { role: string; content: unknown; tool_call_id?: string }[] }[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk.toString();
    requests.push(JSON.parse(body));
    const step = await (steps[requests.length - 1] ?? '结束');
    const delta = typeof step === 'string' ? { content: step } : { tool_calls: step.map((tool, index) => ({ index, id: tool.id ?? `call_${requests.length}_${index}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: typeof step === 'string' ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { model: hostModel, ...hostOptions } = host;
  const serverBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await createCodingSession({ directory, dataDirectory, approvedCommands: [], model: {
    modelId: 'fixture', contextWindow: 32000, outputTokens: 1024, readCredential: async () => 'fixture',
    ...hostModel,
    baseUrl: serverBaseUrl
  }, ...hostOptions, onEvent: event => { events.push(event); host.onEvent?.(event); } });
  return { directory, dataDirectory, events, requests, session, async close() {
    try { await session.close(); } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true }); await rm(dataDirectory, { recursive: true, force: true });
    }
  } };
}
export async function waitForPermission(events: CodingSessionEvent[], action: string) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const event = events.find((e): e is Extract<CodingSessionEvent, { type: 'permission' }> => e.type === 'permission' && e.action === action);
    if (event) return event;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`未观察到 ${action} 权限事件`);
}
