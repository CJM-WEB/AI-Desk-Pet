import type { ModelRequest } from '@myself/agent-core';
import { ASSISTANT_STREAM_TEXT_MAX_CHARACTERS } from '@myself/shared-types';
import { TopLevelTextProjector } from './top-level-text-projector';

const MAX_STREAM_CONTENT_CHARACTERS = 64 * 1024;
const MAX_SSE_EVENT_BYTES = 256 * 1024;
const MAX_SSE_TRANSPORT_BYTES = 512 * 1024;
const MAX_SSE_EVENT_DATA_LINES = 1_024;
const MAX_SSE_EVENTS = 4_096;
const SSE_YIELD_EVERY_EVENTS = 32;

export type StructuredSseEventResult = Readonly<{
  fragment?: string;
  done?: boolean;
}>;

export type StructuredSseOptions = Readonly<{
  request: ModelRequest;
  signal: AbortSignal;
  malformed(): never;
  normalizeReadError(error: unknown): never;
  decodeEvent(eventName: string, data: string): StructuredSseEventResult;
  toRaw(content: string): unknown;
}>;

export function shouldStreamStructuredText(request: ModelRequest): boolean {
  return request.responseContract !== undefined
    && request.tools.length === 0
    && request.toolChoice === 'none'
    && request.onTextDelta !== undefined;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Aborted', 'AbortError');
}

/** 三种云协议共用同一资源预算和结构化正文投影，协议适配器只解释单帧语义。 */
export async function readStructuredTextSse(
  response: Response,
  options: StructuredSseOptions
): Promise<unknown> {
  if (response.body === null) options.malformed();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const projector = new TopLevelTextProjector({
    field: options.request.responseContract!.textField,
    allowPlainTextFallback: options.request.responseContract!.allowPlainTextFallback,
    malformed: options.malformed
  });
  let lineBuffer = '';
  let lineBufferBytes = 0;
  let eventName = '';
  let eventData: string[] = [];
  let eventBytes = 0;
  let transportBytes = 0;
  let eventCount = 0;
  let projectedCharacters = 0;
  let content = '';
  let done = false;

  const dispatch = (): void => {
    if (eventData.length === 0) { eventName = ''; return; }
    if (done || ++eventCount > MAX_SSE_EVENTS) options.malformed();
    const result = options.decodeEvent(eventName, eventData.join('\n'));
    eventName = ''; eventData = []; eventBytes = 0;
    const fragment = result.fragment ?? '';
    if (content.length + fragment.length > MAX_STREAM_CONTENT_CHARACTERS) options.malformed();
    content += fragment;
    const delta = projector.project(content);
    projectedCharacters += delta.length;
    if (projectedCharacters > ASSISTANT_STREAM_TEXT_MAX_CHARACTERS) options.malformed();
    if (delta.length > 0) {
      // 最终 JSON 契约仍会在流末复核；此处只公开已投影的正文，并在回调前拒绝迟到事件。
      throwIfAborted(options.signal);
      options.request.onTextDelta?.(delta);
    }
    if (result.done === true) done = true;
  };

  const acceptLine = (line: string): void => {
    if (line === '') { dispatch(); return; }
    if (line.startsWith('event:')) { eventName = line.slice(6).trim(); return; }
    if (!line.startsWith('data:')) return;
    const value = line.slice(5).replace(/^ /u, '');
    if (eventData.length >= MAX_SSE_EVENT_DATA_LINES
      || eventBytes + Buffer.byteLength(value, 'utf8') > MAX_SSE_EVENT_BYTES) options.malformed();
    eventData.push(value); eventBytes += Buffer.byteLength(value, 'utf8');
  };

  const acceptText = async (text: string): Promise<void> => {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset);
      const end = newline < 0 ? text.length : newline;
      const fragment = text.slice(offset, end);
      const fragmentBytes = Buffer.byteLength(fragment, 'utf8');
      if (lineBufferBytes + fragmentBytes > MAX_SSE_EVENT_BYTES) options.malformed();
      lineBuffer += fragment;
      lineBufferBytes += fragmentBytes;
      if (newline < 0) return;
      acceptLine(lineBuffer.replace(/\r$/u, ''));
      lineBuffer = ''; lineBufferBytes = 0; offset = newline + 1;
      if (eventCount > 0 && eventCount % SSE_YIELD_EVERY_EVENTS === 0) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        throwIfAborted(options.signal);
      }
    }
  };

  try {
    while (true) {
      throwIfAborted(options.signal);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        options.normalizeReadError(error);
      }
      if (chunk.done) break;
      if (chunk.value.byteLength > MAX_SSE_TRANSPORT_BYTES - transportBytes) options.malformed();
      transportBytes += chunk.value.byteLength;
      await acceptText(decoder.decode(chunk.value, { stream: true }));
      if (done) {
        // 协议终态而非 HTTP EOF 决定本轮完成；主动取消可复用或长时间保持的连接体。
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    if (!done) {
      await acceptText(decoder.decode());
      if (lineBuffer.length > 0) acceptLine(lineBuffer.replace(/\r$/u, ''));
      dispatch();
    }
    if (!done) options.malformed();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return options.toRaw(content);
}
