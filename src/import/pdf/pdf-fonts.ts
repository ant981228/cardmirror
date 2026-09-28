/**
 * Fonts for PDF import: turn a shown string's bytes into characters with
 * their advance widths, and tell bold / italic apart.
 *
 * Handles what Word and Chromium emit: Type0 fonts with Identity-H (2-byte
 * codes) and simple TrueType / Type1 fonts (1-byte codes), with a ToUnicode
 * CMap (both producers always embed one) and, failing that, the named
 * base encoding plus /Differences.
 */

import {
  PdfDocument,
  PdfName,
  isStream,
  nameOf,
  decodeStream,
  type PdfDict,
  type PdfValue,
} from './pdf-objects.js';

export interface Glyph {
  /** Unicode text for this code ('' when unmappable). */
  text: string;
  /** Advance in text-space units (glyph width / 1000). */
  width: number;
  /** A single-byte code 32: word spacing (Tw) applies. */
  isSpace: boolean;
}

export interface PdfFont {
  name: string;
  bold: boolean;
  italic: boolean;
  decode(bytes: Uint8Array): Glyph[];
}

// WinAnsi differs from Latin-1 only in 0x80–0x9F.
const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ',
  0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“',
  0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
  0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};
// MacRoman 0x80–0xFF.
const MAC_ROMAN_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

/** The glyph names that show up in /Differences of text fonts. */
const GLYPH_NAMES: Record<string, string> = {
  space: ' ', quotesingle: "'", quotedbl: '"', quoteleft: '‘', quoteright: '’',
  quotedblleft: '“', quotedblright: '”', endash: '–', emdash: '—', bullet: '•',
  ellipsis: '…', hyphen: '-', period: '.', comma: ',', colon: ':', semicolon: ';',
  exclam: '!', question: '?', parenleft: '(', parenright: ')', bracketleft: '[',
  bracketright: ']', slash: '/', ampersand: '&', percent: '%', dollar: '$',
  numbersign: '#', asterisk: '*', plus: '+', equal: '=', at: '@', underscore: '_',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', fi: 'ﬁ', fl: 'ﬂ', section: '§', paragraph: '¶',
  degree: '°', copyright: '©', registered: '®', trademark: '™', nbspace: ' ',
};

function glyphNameToUnicode(name: string): string {
  if (name.length === 1) return name;
  if (GLYPH_NAMES[name]) return GLYPH_NAMES[name]!;
  const uni = /^uni([0-9A-Fa-f]{4})/.exec(name);
  if (uni) return String.fromCharCode(parseInt(uni[1]!, 16));
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (u) return String.fromCodePoint(parseInt(u[1]!, 16));
  return '';
}

function baseEncoding(name: string | null, code: number): string {
  if (code < 0x80) return code >= 0x20 ? String.fromCharCode(code) : '';
  if (name === 'MacRomanEncoding') return MAC_ROMAN_HIGH[code - 0x80] ?? '';
  if (code < 0xa0) return WIN_ANSI_HIGH[code] ?? '';
  return String.fromCharCode(code); // WinAnsi / Standard ≈ Latin-1 above 0xA0
}

/** code → unicode from a ToUnicode CMap (bfchar + bfrange). Also returns
 *  the code byte length from its codespace range. */
function parseToUnicode(data: Uint8Array): { map: Map<number, string>; codeBytes: number } {
  const text = new TextDecoder('latin1').decode(data);
  const map = new Map<number, string>();
  const hexToStr = (hex: string): string => {
    let s = '';
    for (let i = 0; i < hex.length; i += 4) {
      s += String.fromCharCode(parseInt(hex.slice(i, i + 4).padEnd(4, '0'), 16));
    }
    return s;
  };
  let codeBytes = 1;
  const cs = /begincodespacerange\s*<([0-9A-Fa-f]+)>/.exec(text);
  if (cs) codeBytes = Math.max(1, cs[1]!.length / 2);
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(parseInt(m[1]!, 16), hexToStr(m[2]!));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1]!;
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]*)>|\[([^\]]*)\])/g;
    for (const m of body.matchAll(re)) {
      const lo = parseInt(m[1]!, 16);
      const hi = parseInt(m[2]!, 16);
      if (hi - lo > 0xffff) continue;
      if (m[4] !== undefined) {
        const base = hexToStr(m[4]);
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) {
          map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - lo)));
        }
      } else {
        const items = [...m[5]!.matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => hexToStr(x[1]!));
        items.forEach((s, i) => map.set(lo + i, s));
      }
    }
  }
  return { map, codeBytes };
}

function styleFromName(base: string, flags: number, weight: number | null): { bold: boolean; italic: boolean } {
  const n = base.replace(/^[A-Z]{6}\+/, '');
  const bold = /bold|black|heavy|semibold|demi/i.test(n) || (weight !== null && weight >= 600) || (flags & (1 << 18)) !== 0;
  const italic = /italic|oblique/i.test(n) || (flags & (1 << 6)) !== 0;
  return { bold, italic };
}

const fontCache = new WeakMap<PdfDict, PdfFont>();

export function loadFont(doc: PdfDocument, fontDict: PdfDict): PdfFont {
  const cached = fontCache.get(fontDict);
  if (cached) return cached;
  const subtype = nameOf(fontDict.get('Subtype'));
  const baseFont = nameOf(fontDict.get('BaseFont')) ?? 'Unknown';

  let toUni: Map<number, string> | null = null;
  let codeBytes = subtype === 'Type0' ? 2 : 1;
  const tu = doc.resolve(fontDict.get('ToUnicode'));
  if (isStream(tu)) {
    const data = decodeStream(doc, tu);
    if (data) {
      const parsed = parseToUnicode(data);
      toUni = parsed.map;
      if (subtype === 'Type0') codeBytes = parsed.codeBytes;
    }
  }

  let widthOf: (code: number) => number;
  let descriptor: PdfDict | null;
  let encName: string | null = null;
  const differences = new Map<number, string>();

  if (subtype === 'Type0') {
    const desc = doc.resolve(fontDict.get('DescendantFonts'));
    const cid = Array.isArray(desc) ? doc.dict(desc[0]) : null;
    descriptor = doc.dict(cid?.get('FontDescriptor'));
    const dw = doc.resolve(cid?.get('DW'));
    const defaultW = typeof dw === 'number' ? dw : 1000;
    const widths = new Map<number, number>();
    const w = doc.resolve(cid?.get('W'));
    if (Array.isArray(w)) {
      for (let i = 0; i < w.length; ) {
        const first = doc.resolve(w[i]);
        const second = doc.resolve(w[i + 1]);
        if (typeof first !== 'number') break;
        if (Array.isArray(second)) {
          second.forEach((x, k) => widths.set(first + k, Number(doc.resolve(x))));
          i += 2;
        } else {
          const third = doc.resolve(w[i + 2]);
          if (typeof second === 'number' && typeof third === 'number') {
            for (let c = first; c <= second; c++) widths.set(c, third);
          }
          i += 3;
        }
      }
    }
    widthOf = (code) => (widths.get(code) ?? defaultW) / 1000;
  } else {
    descriptor = doc.dict(fontDict.get('FontDescriptor'));
    const first = doc.resolve(fontDict.get('FirstChar'));
    const widthsArr = doc.resolve(fontDict.get('Widths'));
    const fc = typeof first === 'number' ? first : 0;
    const ws = Array.isArray(widthsArr) ? widthsArr.map((x) => Number(doc.resolve(x))) : [];
    const mw = doc.resolve(descriptor?.get('MissingWidth'));
    const missing = typeof mw === 'number' ? mw : 500;
    widthOf = (code) => (ws[code - fc] ?? missing) / 1000;
    const enc = doc.resolve(fontDict.get('Encoding'));
    if (enc instanceof PdfName) encName = enc.name;
    else if (enc instanceof Map) {
      encName = nameOf(enc.get('BaseEncoding'));
      const diffs = doc.resolve(enc.get('Differences'));
      if (Array.isArray(diffs)) {
        let code = 0;
        for (const d of diffs) {
          const r = doc.resolve(d as PdfValue);
          if (typeof r === 'number') code = r;
          else if (r instanceof PdfName) differences.set(code++, glyphNameToUnicode(r.name));
        }
      }
    }
  }

  const flagsV = doc.resolve(descriptor?.get('Flags'));
  const weightV = doc.resolve(descriptor?.get('FontWeight'));
  const { bold, italic } = styleFromName(
    baseFont,
    typeof flagsV === 'number' ? flagsV : 0,
    typeof weightV === 'number' ? weightV : null,
  );

  const font: PdfFont = {
    name: baseFont.replace(/^[A-Z]{6}\+/, ''),
    bold,
    italic,
    decode(bytes) {
      const out: Glyph[] = [];
      for (let i = 0; i + codeBytes <= bytes.length; i += codeBytes) {
        let code = 0;
        for (let k = 0; k < codeBytes; k++) code = (code << 8) | bytes[i + k]!;
        let text = toUni?.get(code);
        if (text === undefined) {
          text = codeBytes === 1 ? differences.get(code) ?? baseEncoding(encName, code) : '';
        }
        out.push({ text, width: widthOf(code), isSpace: codeBytes === 1 && code === 32 });
      }
      return out;
    },
  };
  fontCache.set(fontDict, font);
  return font;
}

