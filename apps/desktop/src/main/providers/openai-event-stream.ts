import { z } from 'zod';
import { ProviderResponseError } from './provider-response-error';

const chunkSchema = z.object({
  choices: z.array(z.object({
    index: z.number().int().nonnegative(),
    delta: z.object({
      content: z.string().nullable().optional(),
      reasoning_content: z.unknown().optional(),
      metadata: z.unknown().optional(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative(),
        id: z.string().optional(),
        type: z.literal('function').optional(),
        function: z.object({
          name: z.string().optional(),
          arguments: z.string().optional()
        }).optional()
      })).optional()
    })
  }))
});

type ToolFragment = {
  id?: string;
  type?: 'function';
  function: { name?: string; arguments?: string };
};

/** 只增量投影正文；工具、推理和元数据保留在 Main，完整重组后仍由既有响应策略裁决。 */
export async function readOpenAIEventStream(
  response: Response,
  signal: AbortSignal,
  onTextDelta: (delta: string) => void
): Promise<unknown> {
  if (!response.body) throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const message: Record<string, unknown> = {};
  const tools = new Map<number, ToolFragment>();
  let pending = '';
  let dataLines: string[] = [];
  let terminal = false;
  let toolsObserved = false;
  const assertActive = () => {
    if (signal.aborted) throw new DOMException('Provider request aborted', 'AbortError');
  };
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };

  const acceptEvent = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    dataLines = [];
    if (data === '[DONE]') { terminal = true; return; }
    let raw: unknown;
    try { raw = JSON.parse(data); } catch {
      throw new ProviderResponseError('HTTP_BODY_NOT_JSON', 'stream');
    }
    const parsed = chunkSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderResponseError('RESPONSE_SHAPE_INVALID', 'stream');
    for (const choice of parsed.data.choices) {
      if (choice.index !== 0) continue;
      const delta = choice.delta;
      // 同一事件含工具和正文时先关闭正文投影，后续内容只参与最终响应判定。
      if (delta.tool_calls !== undefined) {
        if (delta.tool_calls.length > 0) toolsObserved = true;
        for (const fragment of delta.tool_calls) {
          const tool = tools.get(fragment.index) ?? { function: {} };
          if (fragment.id !== undefined) tool.id = (tool.id ?? '') + fragment.id;
          if (fragment.type !== undefined) tool.type = fragment.type;
          if (fragment.function?.name !== undefined) tool.function.name = (tool.function.name ?? '') + fragment.function.name;
          if (fragment.function?.arguments !== undefined) tool.function.arguments = (tool.function.arguments ?? '') + fragment.function.arguments;
          tools.set(fragment.index, tool);
        }
      }
      if (Object.prototype.hasOwnProperty.call(delta, 'reasoning_content')) {
        message.reasoning_content = typeof delta.reasoning_content === 'string'
          ? String(message.reasoning_content ?? '') + delta.reasoning_content
          : delta.reasoning_content;
      }
      if (delta.metadata !== undefined) message.metadata = delta.metadata;
      if (typeof delta.content === 'string') {
        message.content = String(message.content ?? '') + delta.content;
        assertActive();
        if (!toolsObserved && delta.content.length > 0) onTextDelta(delta.content);
      }
    }
  };

  const consumeLines = (end: boolean) => {
    let offset = 0;
    const lineEnd = /\r\n|\r|\n/g;
    for (let match = lineEnd.exec(pending); match !== null; match = lineEnd.exec(pending)) {
      // CRLF 可以跨网络分片，暂存末尾 CR，避免误造空事件。
      if (!end && match[0] === '\r' && match.index === pending.length - 1) break;
      const line = pending.slice(offset, match.index);
      offset = match.index + match[0].length;
      if (line.length === 0) acceptEvent();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      if (terminal) break;
    }
    pending = pending.slice(offset);
  };

  signal.addEventListener('abort', cancelReader, { once: true });
  try {
    while (!terminal) {
      assertActive();
      const next = await reader.read();
      assertActive();
      pending += decoder.decode(next.value, { stream: !next.done });
      consumeLines(next.done);
      if (next.done) break;
    }
    assertActive();
    if (!terminal) throw new ProviderResponseError('STREAM_TERMINAL_MISSING', 'stream');
    if (toolsObserved) message.tool_calls = [...tools.entries()].sort(([left], [right]) => left - right).map(([, tool]) => tool);
    return { choices: [{ message }] };
  } finally {
    signal.removeEventListener('abort', cancelReader);
    cancelReader();
    reader.releaseLock();
  }
}
