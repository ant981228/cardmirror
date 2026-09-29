/**
 * Minimal PDF object reader for PDF import.
 *
 * Scope: the PDFs debaters actually have — exports from Word (Verbatim) and
 * from Chromium (CardMirror's Save As → PDF, or a browser's print). Not a
 * general PDF library: no encryption, no filters beyond Flate / ASCIIHex, no
 * incremental-update semantics beyond "the last definition of an object
 * wins". Objects are found by scanning for `N G obj` (plus object streams),
 * which is robust to broken or missing xref tables and needs no xref parser.
 *
 * Values are plain JS: numbers, booleans, null, strings as `PdfString`
 * (raw bytes), names as `PdfName`, arrays, dicts as `PdfDict` (a Map), and
 * references as `PdfRef`.
 */

import { unzlibSync, inflateSync } from 'fflate';

export class PdfName {
  constructor(readonly name: string) {}
}
export class PdfString {
  constructor(readonly bytes: Uint8Array) {}
  /** Latin-1 view (metadata, names in strings). */
  text(): string {
    let s = '';
    for (const b of this.bytes) s += String.fromCharCode(b);
    return s;
  }
}
export class PdfRef {
  constructor(readonly num: number, readonly gen: number) {}
}
export type PdfDict = Map<string, PdfValue>;
export interface PdfStream {
  dict: PdfDict;
  /** Raw (still-encoded) bytes. */
  raw: Uint8Array;
}
export type PdfValue =
  | number
  | boolean
  | null
  | PdfName
  | PdfString
  | PdfRef
  | PdfValue[]
  | PdfDict
  | PdfStream;

export class PdfError extends Error {}

export function isDict(v: unknown): v is PdfDict {
  return v instanceof Map;
}
export function isStream(v: unknown): v is PdfStream {
  return typeof v === 'object' && v !== null && 'raw' in v && 'dict' in v;
}

// ── Lexer ────────────────────────────────────────────────────────────

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/** Operator / keyword token in a content stream or object body. */
export class PdfOp {
  constructor(readonly op: string) {}
}

export class Lexer {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
    /** Fold `num gen R` into a PdfRef (object bodies; never content streams). */
    private readonly refs = true,
  ) {
    this.pos = start;
  }

  private skipWs(): void {
    const b = this.buf;
    while (this.pos < this.end) {
      const c = b[this.pos]!;
      if (WS.has(c)) this.pos++;
      else if (c === 0x25) {
        // comment to end of line
        while (this.pos < this.end && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
  }

  /** Next value or operator; undefined at end. Arrays and dicts are
   *  returned whole. `R` after two ints folds into a PdfRef. */
  next(): PdfValue | PdfOp | undefined {
    const v = this.nextRaw();
    if (this.refs && typeof v === 'number' && Number.isInteger(v) && v >= 0) {
      // Possible `num gen R`.
      const save = this.pos;
      const g = this.nextRaw();
      if (typeof g === 'number' && Number.isInteger(g)) {
        const save2 = this.pos;
        const r = this.nextRaw();
        if (r instanceof PdfOp && r.op === 'R') return new PdfRef(v, g);
        this.pos = save2;
      }
      this.pos = save;
    }
    return v;
  }

  private nextRaw(): PdfValue | PdfOp | undefined {
    this.skipWs();
    if (this.pos >= this.end) return undefined;
    const b = this.buf;
    const c = b[this.pos]!;
    if (c === 0x2f) return this.name();
    if (c === 0x28) return this.literalString();
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return this.dict();
      }
      return this.hexString();
    }
    if (c === 0x5b) {
      this.pos++;
      const arr: PdfValue[] = [];
      for (;;) {
        this.skipWs();
        if (this.pos >= this.end) break;
        if (b[this.pos] === 0x5d) {
          this.pos++;
          break;
        }
        const v = this.next();
        if (v === undefined) break;
        if (v instanceof PdfOp) continue; // stray keyword inside an array
        arr.push(v);
      }
      return arr;
    }
    if (c === 0x5d || c === 0x3e || c === 0x7b || c === 0x7d || c === 0x29) {
      this.pos++;
      return new PdfOp(String.fromCharCode(c));
    }
    // Numbers straight from the bytes (most tokens in a content stream).
    if ((c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2b || c === 0x2e) {
      const n = this.number();
      if (n !== null) return n;
    }
    // keyword
    const start = this.pos;
    while (this.pos < this.end && !WS.has(b[this.pos]!) && !DELIM.has(b[this.pos]!)) this.pos++;
    if (this.pos === start) {
      this.pos++;
      return new PdfOp(String.fromCharCode(c));
    }
    let tok = '';
    for (let i = start; i < this.pos; i++) tok += String.fromCharCode(b[i]!);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) return Number(tok);
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    return new PdfOp(tok);
  }

  /** A number at pos, or null (pos unchanged) when the token isn't one. */
  private number(): number | null {
    const b = this.buf;
    const start = this.pos;
    let i = start;
    let neg = false;
    if (b[i] === 0x2d || b[i] === 0x2b) {
      neg = b[i] === 0x2d;
      i++;
    }
    let int = 0;
    let digits = 0;
    while (i < this.end && b[i]! >= 0x30 && b[i]! <= 0x39) {
      int = int * 10 + (b[i]! - 0x30);
      i++;
      digits++;
    }
    let frac = 0;
    let scale = 1;
    if (i < this.end && b[i] === 0x2e) {
      i++;
      while (i < this.end && b[i]! >= 0x30 && b[i]! <= 0x39) {
        frac = frac * 10 + (b[i]! - 0x30);
        scale *= 10;
        i++;
        digits++;
      }
    }
    // A number must end at whitespace or a delimiter, and have a digit.
    if (digits === 0 || (i < this.end && !WS.has(b[i]!) && !DELIM.has(b[i]!))) return null;
    this.pos = i;
    const v = int + frac / scale;
    return neg ? -v : v;
  }

  private name(): PdfName {
    const b = this.buf;
    this.pos++; // '/'
    let s = '';
    while (this.pos < this.end && !WS.has(b[this.pos]!) && !DELIM.has(b[this.pos]!)) {
      const c = b[this.pos]!;
      if (c === 0x23 && this.pos + 2 < this.end) {
        // #xx escape
        s += String.fromCharCode(parseInt(String.fromCharCode(b[this.pos + 1]!, b[this.pos + 2]!), 16));
        this.pos += 3;
      } else {
        s += String.fromCharCode(c);
        this.pos++;
      }
    }
    return new PdfName(s);
  }

  private literalString(): PdfString {
    const b = this.buf;
    this.pos++; // '('
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.end) {
      const c = b[this.pos++]!;
      if (c === 0x5c) {
        const n = b[this.pos++]!;
        switch (n) {
          case 0x6e: out.push(0x0a); break; // n
          case 0x72: out.push(0x0d); break; // r
          case 0x74: out.push(0x09); break; // t
          case 0x62: out.push(0x08); break; // b
          case 0x66: out.push(0x0c); break; // f
          case 0x0d:
            if (b[this.pos] === 0x0a) this.pos++;
            break; // line continuation
          case 0x0a:
            break;
          default:
            if (n >= 0x30 && n <= 0x37) {
              let oct = n - 0x30;
              for (let k = 0; k < 2; k++) {
                const d = b[this.pos]!;
                if (d >= 0x30 && d <= 0x37) {
                  oct = oct * 8 + (d - 0x30);
                  this.pos++;
                } else break;
              }
              out.push(oct & 0xff);
            } else out.push(n);
        }
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) break;
      out.push(c);
    }
    return new PdfString(Uint8Array.from(out));
  }

  private hexString(): PdfString {
    const b = this.buf;
    this.pos++; // '<'
    let hex = '';
    while (this.pos < this.end && b[this.pos] !== 0x3e) {
      const c = b[this.pos++]!;
      if (!WS.has(c)) hex += String.fromCharCode(c);
    }
    this.pos++; // '>'
    if (hex.length % 2) hex += '0';
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return new PdfString(out);
  }

  private dict(): PdfDict {
    const d: PdfDict = new Map();
    for (;;) {
      this.skipWs();
      if (this.pos >= this.end) break;
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }
      const k = this.next();
      if (!(k instanceof PdfName)) {
        if (k === undefined) break;
        continue;
      }
      const v = this.next();
      if (v === undefined) break;
      if (v instanceof PdfOp) continue;
      d.set(k.name, v);
    }
    return d;
  }
}

// ── Document ─────────────────────────────────────────────────────────

function indexOfBytes(buf: Uint8Array, needle: string, from: number): number {
  const n0 = needle.charCodeAt(0);
  const last = buf.length - needle.length;
  // Native indexOf jumps to each candidate first byte; only those are checked.
  for (let i = buf.indexOf(n0, from); i !== -1 && i <= last; i = buf.indexOf(n0, i + 1)) {
    let j = 1;
    while (j < needle.length && buf[i + j] === needle.charCodeAt(j)) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

export class PdfDocument {
  private objects = new Map<number, PdfValue>();
  /** Byte offset of each `N G obj`, parsed lazily. */
  private offsets = new Map<number, number>();
  trailer: PdfDict = new Map();

  constructor(readonly buf: Uint8Array) {
    const head = new TextDecoder('latin1').decode(buf.subarray(0, Math.min(1024, buf.length)));
    if (!head.includes('%PDF-')) throw new PdfError('Not a PDF file');
    this.scan();
  }

  /** Find every `N G obj` header. A later definition of the same object
   *  (incremental update) replaces an earlier one. */
  private scan(): void {
    const b = this.buf;
    for (let i = indexOfBytes(b, ' obj', 0); i !== -1; i = indexOfBytes(b, ' obj', i + 4)) {
      // Walk back over "N G" before " obj".
      let j = i - 1;
      while (j >= 0 && b[j]! >= 0x30 && b[j]! <= 0x39) j--; // gen digits
      if (j === i - 1 || b[j] !== 0x20) continue;
      let k = j - 1;
      while (k >= 0 && b[k]! >= 0x30 && b[k]! <= 0x39) k--; // num digits
      if (k === j - 1) continue;
      if (k >= 0 && !WS.has(b[k]!)) continue;
      let num = 0;
      for (let p = k + 1; p < j; p++) num = num * 10 + (b[p]! - 0x30);
      this.offsets.set(num, i + 4);
    }
    // Trailer: classic trailer dict, else the xref stream's dict.
    const t = b.length > 0 ? this.lastTrailer() : null;
    if (t) this.trailer = t;
  }

  private lastTrailer(): PdfDict | null {
    const b = this.buf;
    let found: PdfDict | null = null;
    for (let i = indexOfBytes(b, 'trailer', 0); i !== -1; i = indexOfBytes(b, 'trailer', i + 7)) {
      const v = new Lexer(b, i + 7).next();
      if (isDict(v)) found = found ? new Map([...found, ...v]) : v;
    }
    if (found?.has('Root')) return found;
    // Xref streams carry the trailer keys in their dict.
    for (const num of this.offsets.keys()) {
      const v = this.get(num);
      if (isStream(v) && nameOf(v.dict.get('Type')) === 'XRef' && v.dict.has('Root')) found = v.dict;
    }
    return found;
  }

  /** The object `num`, parsed on first use. */
  get(num: number): PdfValue {
    if (this.objects.has(num)) return this.objects.get(num)!;
    const off = this.offsets.get(num);
    if (off === undefined) {
      this.loadObjectStreams();
      return this.objects.get(num) ?? null;
    }
    this.objects.set(num, null); // cycle guard
    const lex = new Lexer(this.buf, off);
    let v = lex.next();
    if (v instanceof PdfOp) v = null;
    if (isDict(v)) {
      const save = lex.pos;
      const kw = lex.next();
      if (kw instanceof PdfOp && kw.op === 'stream') {
        let start = lex.pos;
        if (this.buf[start] === 0x0d) start++;
        if (this.buf[start] === 0x0a) start++;
        const lenV = this.resolve(v.get('Length') ?? null);
        let end = typeof lenV === 'number' ? start + lenV : -1;
        if (end < 0 || end > this.buf.length || indexOfBytes(this.buf, 'endstream', end) - end > 4) {
          end = indexOfBytes(this.buf, 'endstream', start);
          while (end > start && WS.has(this.buf[end - 1]!)) end--;
        }
        const s: PdfStream = { dict: v, raw: this.buf.subarray(start, Math.max(start, end)) };
        this.objects.set(num, s);
        return s;
      }
      lex.pos = save;
    }
    this.objects.set(num, v ?? null);
    return v ?? null;
  }

  private objStmsLoaded = false;
  /** Compressed objects (PDF 1.5+): parse every /ObjStm once. */
  private loadObjectStreams(): void {
    if (this.objStmsLoaded) return;
    this.objStmsLoaded = true;
    for (const num of [...this.offsets.keys()]) {
      const s = this.get(num);
      if (!isStream(s) || nameOf(s.dict.get('Type')) !== 'ObjStm') continue;
      const data = decodeStream(this, s);
      if (!data) continue;
      const n = this.resolve(s.dict.get('N') ?? null);
      const first = this.resolve(s.dict.get('First') ?? null);
      if (typeof n !== 'number' || typeof first !== 'number') continue;
      const header = new Lexer(data, 0, first);
      const entries: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const onum = header.next();
        const ooff = header.next();
        if (typeof onum === 'number' && typeof ooff === 'number') entries.push([onum, ooff]);
      }
      for (const [onum, ooff] of entries) {
        if (this.offsets.has(onum) || this.objects.has(onum)) continue; // a direct definition wins
        const v = new Lexer(data, first + ooff).next();
        this.objects.set(onum, v instanceof PdfOp || v === undefined ? null : v);
      }
    }
  }

  resolve(v: PdfValue | undefined): PdfValue {
    let cur: PdfValue | undefined = v;
    for (let i = 0; i < 16 && cur instanceof PdfRef; i++) cur = this.get(cur.num);
    return cur ?? null;
  }

  dict(v: PdfValue | undefined): PdfDict | null {
    const r = this.resolve(v);
    if (isDict(r)) return r;
    if (isStream(r)) return r.dict;
    return null;
  }

  /** Pages in order, each with its inherited Resources and MediaBox. */
  pages(): { dict: PdfDict; resources: PdfDict; mediaBox: number[] }[] {
    const root = this.dict(this.trailer.get('Root'));
    const out: { dict: PdfDict; resources: PdfDict; mediaBox: number[] }[] = [];
    const seen = new Set<PdfDict>();
    const walk = (node: PdfDict | null, res: PdfDict, box: number[]): void => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      const r = this.dict(node.get('Resources')) ?? res;
      const mb = this.resolve(node.get('MediaBox'));
      const b = Array.isArray(mb) && mb.length === 4 ? mb.map((x) => Number(this.resolve(x))) : box;
      const kids = this.resolve(node.get('Kids'));
      if (Array.isArray(kids)) for (const k of kids) walk(this.dict(k), r, b);
      else out.push({ dict: node, resources: r, mediaBox: b });
    };
    walk(this.dict(root?.get('Pages')), new Map(), [0, 0, 612, 792]);
    return out;
  }

  /** Document /Info as strings (Creator, Producer, Title). */
  info(): Record<string, string> {
    const d = this.dict(this.trailer.get('Info'));
    const out: Record<string, string> = {};
    if (d) for (const [k, v] of d) {
      const r = this.resolve(v);
      if (r instanceof PdfString) out[k] = decodePdfText(r.bytes);
    }
    return out;
  }
}

export function nameOf(v: PdfValue | undefined): string | null {
  return v instanceof PdfName ? v.name : null;
}

/** A PDF text string: UTF-16BE with a BOM, else PDFDocEncoding (~Latin-1). */
export function decodePdfText(bytes: Uint8Array): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    return s;
  }
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** Decoded stream bytes, or null for a filter we don't handle. */
export function decodeStream(doc: PdfDocument, s: PdfStream): Uint8Array | null {
  const f = doc.resolve(s.dict.get('Filter'));
  const filters = Array.isArray(f) ? f.map((x) => nameOf(x as PdfValue)) : f ? [nameOf(f)] : [];
  let data: Uint8Array = s.raw;
  for (const name of filters) {
    if (name === 'FlateDecode' || name === 'Fl') {
      try {
        data = unzlibSync(data);
      } catch {
        try {
          data = inflateSync(data); // raw deflate, or a bad zlib checksum
        } catch {
          return null;
        }
      }
    } else if (name === 'ASCIIHexDecode' || name === 'AHx') {
      let hex = '';
      for (const c of data) if (!WS.has(c) && c !== 0x3e) hex += String.fromCharCode(c);
      if (hex.length % 2) hex += '0';
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      data = out;
    } else {
      return null; // DCT (images), LZW, etc. — never needed for text
    }
  }
  return data;
}
