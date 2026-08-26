import type { ModelRequest } from '@myself/agent-core';
import { ASSISTANT_STREAM_TEXT_MAX_CHARACTERS } from '@myself/shared-types';

const MAX_STREAM_CONTENT_CHARACTERS = 64 * 1024;
const MAX_SSE_EVENT_BYTES = 256 * 1024;
const MAX_SSE_TRANSPORT_BYTES = 512 * 1024;
const MAX_SSE_EVENT_DATA_LINES = 1_024;
const MAX_SSE_EVENTS = 4_096;
const SSE_YIELD_EVERY_EVENTS = 32;

type ProjectorPhase =
  | 'root' | 'key_or_end' | 'key' | 'colon' | 'value'
  | 'skip_string' | 'skip_complex' | 'skip_primitive'
  | 'comma_or_end' | 'target_string' | 'done';

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

/** 持久游标只扫描新字符；跨 chunk 的 Unicode 转义在完整后才公开。 */
class IncrementalTopLevelTextProjector {
  private index = 0;
  private phase: ProjectorPhase = 'root';
  private keyCharacters: string[] = [];
  private keyEscaped = false;
  private currentKey = '';
  private targetFieldSeen = false;
  private skipEscaped = false;
  private skipInString = false;
  private skipClosers: string[] = [];

  constructor(private readonly field: string, private readonly malformed: () => never) {}

  project(source: string): string {
    const projection: string[] = [];
    while (this.index < source.length) {
      const character = source[this.index]!;
      if (this.phase === 'root') {
        if (/\s/u.test(character)) { this.index += 1; continue; }
        if (character !== '{') this.malformed();
        this.index += 1; this.phase = 'key_or_end'; continue;
      }
      if (this.phase === 'key_or_end') {
        if (/\s/u.test(character)) { this.index += 1; continue; }
        if (character === '}') { this.index += 1; this.phase = 'done'; continue; }
        if (character !== '"') this.malformed();
        this.keyCharacters = ['"']; this.keyEscaped = false; this.index += 1; this.phase = 'key'; continue;
      }
      if (this.phase === 'key') {
        this.keyCharacters.push(character); this.index += 1;
        if (this.keyEscaped) { this.keyEscaped = false; continue; }
        if (character === '\\') { this.keyEscaped = true; continue; }
        if (character !== '"') continue;
        try { this.currentKey = JSON.parse(this.keyCharacters.join('')) as string; } catch { this.malformed(); }
        this.keyCharacters = []; this.phase = 'colon'; continue;
      }
      if (this.phase === 'colon') {
        if (/\s/u.test(character)) { this.index += 1; continue; }
        if (character !== ':') this.malformed();
        this.index += 1; this.phase = 'value'; continue;
      }
      if (this.phase === 'value') {
        if (/\s/u.test(character)) { this.index += 1; continue; }
        if (this.currentKey === this.field) {
          if (this.targetFieldSeen) this.malformed();
          this.targetFieldSeen = true;
          if (character !== '"') this.malformed();
          this.index += 1; this.phase = 'target_string'; continue;
        }
        if (character === '"') {
          this.index += 1; this.skipEscaped = false; this.phase = 'skip_string'; continue;
        }
        if (character === '{' || character === '[') {
          this.skipClosers = [character === '{' ? '}' : ']'];
          this.skipInString = false; this.skipEscaped = false; this.index += 1;
          this.phase = 'skip_complex'; continue;
        }
        this.phase = 'skip_primitive'; continue;
      }
      if (this.phase === 'skip_string') {
        this.index += 1;
        if (this.skipEscaped) { this.skipEscaped = false; continue; }
        if (character === '\\') { this.skipEscaped = true; continue; }
        if (character === '"') this.phase = 'comma_or_end';
        continue;
      }
      if (this.phase === 'skip_complex') {
        this.index += 1;
        if (this.skipInString) {
          if (this.skipEscaped) this.skipEscaped = false;
          else if (character === '\\') this.skipEscaped = true;
          else if (character === '"') this.skipInString = false;
          continue;
        }
        if (character === '"') { this.skipInString = true; continue; }
        if (character === '{' || character === '[') {
          this.skipClosers.push(character === '{' ? '}' : ']'); continue;
        }
        if (character === '}' || character === ']') {
          if (this.skipClosers.pop() !== character) this.malformed();
          if (this.skipClosers.length === 0) this.phase = 'comma_or_end';
        }
        continue;
      }
      if (this.phase === 'skip_primitive') {
        if (character === ',') { this.index += 1; this.phase = 'key_or_end'; continue; }
        if (character === '}') { this.index += 1; this.phase = 'done'; continue; }
        this.index += 1; continue;
      }
      if (this.phase === 'comma_or_end') {
        if (/\s/u.test(character)) { this.index += 1; continue; }
        if (character === ',') { this.index += 1; this.phase = 'key_or_end'; continue; }
        if (character === '}') { this.index += 1; this.phase = 'done'; continue; }
        this.malformed();
      }
      if (this.phase === 'target_string') {
        if (character === '"') { this.index += 1; this.phase = 'comma_or_end'; continue; }
        if (character !== '\\') {
          const codePoint = source.codePointAt(this.index);
          if (codePoint === undefined) break;
          const decoded = String.fromCodePoint(codePoint);
          if (decoded.length === 2 && this.index + 1 >= source.length) break;
          if (codePoint < 0x20) this.malformed();
          projection.push(decoded); this.index += decoded.length; continue;
        }
        const escape = source[this.index + 1];
        if (escape === undefined) break;
        const simpleEscapes: Readonly<Record<string, string>> = {
          '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t'
        };
        if (escape !== 'u') {
          const decoded = simpleEscapes[escape];
          if (decoded === undefined) this.malformed();
          projection.push(decoded); this.index += 2; continue;
        }
        const hex = source.slice(this.index + 2, this.index + 6);
        if (hex.length < 4) break;
        if (!/^[0-9a-f]{4}$/iu.test(hex)) this.malformed();
        const unit = Number.parseInt(hex, 16);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const lowPrefix = source.slice(this.index + 6, this.index + 8);
          const lowHex = source.slice(this.index + 8, this.index + 12);
          if (lowPrefix.length < 2 || lowHex.length < 4) break;
          if (lowPrefix !== '\\u' || !/^[0-9a-f]{4}$/iu.test(lowHex)) this.malformed();
          const low = Number.parseInt(lowHex, 16);
          if (low < 0xdc00 || low > 0xdfff) this.malformed();
          projection.push(String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + low - 0xdc00));
          this.index += 12; continue;
        }
        projection.push(String.fromCharCode(unit)); this.index += 6; continue;
      }
      if (this.phase === 'done') {
        if (!/\s/u.test(character)) this.malformed();
        this.index += 1;
      }
    }
    return projection.join('');
  }
}

/** 三种云协议共用同一资源预算和结构化正文投影，协议适配器只解释单帧语义。 */
export async function readStructuredTextSse(
  response: Response,
  options: StructuredSseOptions
): Promise<unknown> {
  if (response.body === null) options.malformed();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const projector = new IncrementalTopLevelTextProjector(
    options.request.responseContract!.textField,
    options.malformed
  );
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
