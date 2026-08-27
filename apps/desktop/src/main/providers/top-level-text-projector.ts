type ProjectorPhase =
  | 'root' | 'plain_text' | 'key_or_end' | 'key' | 'colon' | 'value'
  | 'skip_string' | 'skip_complex' | 'skip_primitive'
  | 'comma_or_end' | 'target_string' | 'done';

export type TopLevelTextProjectorOptions = Readonly<{
  field: string;
  allowPlainTextFallback: boolean;
  malformed(): never;
}>;

/**
 * 只投影模型顶层 JSON 的正文字段，并以持久游标保证每个字符最多扫描一次。
 * SSE 传输、资源预算和协议终态属于各 Provider，不进入该模块。
 */
export class TopLevelTextProjector {
  private index = 0;
  private phase: ProjectorPhase = 'root';
  private keyCharacters: string[] = [];
  private keyEscaped = false;
  private currentKey = '';
  private targetFieldSeen = false;
  private skipEscaped = false;
  private skipInString = false;
  private skipClosers: string[] = [];

  constructor(private readonly options: TopLevelTextProjectorOptions) {}

  project(source: string): string {
    const projection: string[] = [];
    if (this.phase === 'root') {
      const firstVisibleIndex = source.search(/\S/u);
      if (firstVisibleIndex < 0) return '';
      if (source[firstVisibleIndex] !== '{') {
        if (!this.options.allowPlainTextFallback) this.options.malformed();
        this.phase = 'plain_text';
      }
    }
    while (this.index < source.length) {
      const character = source[this.index]!;
      if (this.phase === 'plain_text') {
        projection.push(source.slice(this.index));
        this.index = source.length;
        continue;
      }
      if (this.phase === 'root') {
        if (/\s/u.test(character)) { this.index += 1; continue; }
        if (character !== '{') this.options.malformed();
        this.index += 1; this.phase = 'key_or_end'; continue;
      }
      if (this.phase === 'key_or_end') {
        if (/\s/u.test(character)) { this.index += 1; continue; }
        if (character === '}') { this.index += 1; this.phase = 'done'; continue; }
        if (character !== '"') this.options.malformed();
        this.keyCharacters = ['"']; this.keyEscaped = false; this.index += 1; this.phase = 'key'; continue;
      }
      if (this.phase === 'key') {
        this.keyCharacters.push(character); this.index += 1;
        if (this.keyEscaped) { this.keyEscaped = false; continue; }
        if (character === '\\') { this.keyEscaped = true; continue; }
        if (character !== '"') continue;
        try { this.currentKey = JSON.parse(this.keyCharacters.join('')) as string; } catch { this.options.malformed(); }
        this.keyCharacters = []; this.phase = 'colon'; continue;
      }
      if (this.phase === 'colon') {
        if (/\s/u.test(character)) { this.index += 1; continue; }
        if (character !== ':') this.options.malformed();
        this.index += 1; this.phase = 'value'; continue;
      }
      if (this.phase === 'value') {
        if (/\s/u.test(character)) { this.index += 1; continue; }
        if (this.currentKey === this.options.field) {
          if (this.targetFieldSeen) this.options.malformed();
          this.targetFieldSeen = true;
          if (character !== '"') this.options.malformed();
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
          if (this.skipClosers.pop() !== character) this.options.malformed();
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
        this.options.malformed();
      }
      if (this.phase === 'target_string') {
        if (character === '"') { this.index += 1; this.phase = 'comma_or_end'; continue; }
        if (character !== '\\') {
          const codePoint = source.codePointAt(this.index);
          if (codePoint === undefined) break;
          const decoded = String.fromCodePoint(codePoint);
          if (decoded.length === 2 && this.index + 1 >= source.length) break;
          if (codePoint < 0x20) this.options.malformed();
          projection.push(decoded); this.index += decoded.length; continue;
        }
        const escape = source[this.index + 1];
        if (escape === undefined) break;
        const simpleEscapes: Readonly<Record<string, string>> = {
          '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t'
        };
        if (escape !== 'u') {
          const decoded = simpleEscapes[escape];
          if (decoded === undefined) this.options.malformed();
          projection.push(decoded); this.index += 2; continue;
        }
        const hex = source.slice(this.index + 2, this.index + 6);
        if (hex.length < 4) break;
        if (!/^[0-9a-f]{4}$/iu.test(hex)) this.options.malformed();
        const unit = Number.parseInt(hex, 16);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const lowPrefix = source.slice(this.index + 6, this.index + 8);
          const lowHex = source.slice(this.index + 8, this.index + 12);
          if (lowPrefix.length < 2 || lowHex.length < 4) break;
          if (lowPrefix !== '\\u' || !/^[0-9a-f]{4}$/iu.test(lowHex)) this.options.malformed();
          const low = Number.parseInt(lowHex, 16);
          if (low < 0xdc00 || low > 0xdfff) this.options.malformed();
          projection.push(String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + low - 0xdc00));
          this.index += 12; continue;
        }
        projection.push(String.fromCharCode(unit)); this.index += 6; continue;
      }
      if (this.phase === 'done') {
        if (!/\s/u.test(character)) this.options.malformed();
        this.index += 1;
      }
    }
    return projection.join('');
  }
}
