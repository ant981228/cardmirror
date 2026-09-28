/**
 * Content-stream interpreter for PDF import: runs a page's drawing
 * operators and collects what the layout step needs —
 *
 *   - every shown character with its position, size, font and color;
 *   - every axis-aligned filled rectangle (highlights, shading, table and
 *     box borders, underlines drawn as thin fills) and stroked segment
 *     (underlines and borders drawn as lines).
 *
 * Coordinates are in points with a TOP-LEFT origin (y grows downward),
 * relative to the page's MediaBox.
 */

import {
  Lexer,
  PdfDocument,
  PdfName,
  PdfOp,
  PdfString,
  decodeStream,
  isStream,
  nameOf,
  type PdfDict,
  type PdfValue,
} from './pdf-objects.js';
import { loadFont, type PdfFont } from './pdf-fonts.js';

export interface PdfChar {
  text: string;
  /** Left edge / right edge (after the advance), baseline y. */
  x0: number;
  x1: number;
  y: number;
  /** Rendered font size in points. */
  size: number;
  font: PdfFont;
  /** Fill color as #rrggbb. */
  color: string;
}

export interface PdfRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
  /** 'fill' for filled areas; 'stroke' for a stroked line segment
   *  (normalized to a thin rectangle of the line width). */
  kind: 'fill' | 'stroke';
}

export interface PdfPageContent {
  width: number;
  height: number;
  chars: PdfChar[];
  rects: PdfRect[];
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}
function apply(m: Matrix, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

function hex2(n: number): string {
  return Math.round(Math.max(0, Math.min(1, n)) * 255)
    .toString(16)
    .padStart(2, '0');
}
function rgbHex(r: number, g: number, b: number): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}
/** Color operands → hex, by component count (gray / RGB / CMYK). */
function colorFrom(ops: number[]): string | null {
  if (ops.length === 1) return rgbHex(ops[0]!, ops[0]!, ops[0]!);
  if (ops.length === 3) return rgbHex(ops[0]!, ops[1]!, ops[2]!);
  if (ops.length === 4) {
    const [c, m, y, k] = ops as [number, number, number, number];
    return rgbHex((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));
  }
  return null;
}

interface GState {
  ctm: Matrix;
  fill: string;
  stroke: string;
  lineWidth: number;
  font: PdfFont | null;
  fontSize: number;
  charSpace: number;
  wordSpace: number;
  hScale: number;
  leading: number;
  rise: number;
}

export function readPage(doc: PdfDocument, page: { dict: PdfDict; resources: PdfDict; mediaBox: number[] }): PdfPageContent {
  const [bx0, by0, bx1, by1] = page.mediaBox as [number, number, number, number];
  const width = bx1 - bx0;
  const height = by1 - by0;
  const chars: PdfChar[] = [];
  const rects: PdfRect[] = [];
  // PDF user space (bottom-left origin) → top-left page coordinates.
  const toPage: Matrix = [1, 0, 0, -1, -bx0, by1];

  const contents = doc.resolve(page.dict.get('Contents'));
  const parts = Array.isArray(contents) ? contents.map((c) => doc.resolve(c)) : [contents];
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    if (!isStream(p)) continue;
    const d = decodeStream(doc, p);
    if (d) chunks.push(d, new Uint8Array([0x0a]));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const data = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    data.set(c, off);
    off += c.length;
  }

  run(doc, data, page.resources, {
    ctm: toPage,
    fill: '#000000',
    stroke: '#000000',
    lineWidth: 1,
    font: null,
    fontSize: 0,
    charSpace: 0,
    wordSpace: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
  }, chars, rects, 0);

  return { width, height, chars, rects };
}

function run(
  doc: PdfDocument,
  data: Uint8Array,
  resources: PdfDict,
  initial: GState,
  chars: PdfChar[],
  rects: PdfRect[],
  depth: number,
): void {
  if (depth > 8) return; // runaway form-XObject nesting
  const lex = new Lexer(data);
  const stack: GState[] = [];
  let gs: GState = { ...initial };
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let operands: (PdfValue | PdfOp)[] = [];
  // Current path, as subpaths of points in PAGE coordinates.
  let subpaths: [number, number][][] = [];
  let cur: [number, number][] | null = null;

  const fonts = doc.dict(resources.get('Font'));
  const xobjects = doc.dict(resources.get('XObject'));
  const extG = doc.dict(resources.get('ExtGState'));

  const num = (i: number): number => {
    const v = operands[i];
    return typeof v === 'number' ? v : 0;
  };
  const nums = (): number[] => operands.filter((v): v is number => typeof v === 'number');

  const showText = (bytes: Uint8Array): void => {
    const font = gs.font;
    if (!font) return;
    const trm0 = mul([gs.fontSize * gs.hScale, 0, 0, gs.fontSize, 0, gs.rise], mul(tm, gs.ctm));
    // Rendered size: the length of the text-space unit vertical in page space.
    const size = Math.hypot(trm0[2], trm0[3]);
    for (const g of font.decode(bytes)) {
      const trm = mul([gs.fontSize * gs.hScale, 0, 0, gs.fontSize, 0, gs.rise], mul(tm, gs.ctm));
      const [x, y] = apply(trm, 0, 0);
      const adv = (g.width * gs.fontSize + gs.charSpace + (g.isSpace ? gs.wordSpace : 0)) * gs.hScale;
      const [xe] = apply(mul(tm, gs.ctm), adv, 0);
      if (g.text) {
        chars.push({ text: g.text, x0: Math.min(x, xe), x1: Math.max(x, xe), y, size, font, color: gs.fill });
      }
      tm = mul([1, 0, 0, 1, adv, 0], tm);
    }
  };

  const flushPath = (mode: 'fill' | 'stroke' | 'none'): void => {
    if (mode !== 'none') {
      for (const sp of subpaths) {
        if (sp.length < 2) continue;
        const xs = sp.map((p) => p[0]);
        const ys = sp.map((p) => p[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        // Axis-aligned shapes only: every point on the bounding box's edge.
        const onBox = sp.every(
          (p) => Math.abs(p[0] - x0) < 0.5 || Math.abs(p[0] - x1) < 0.5 || Math.abs(p[1] - y0) < 0.5 || Math.abs(p[1] - y1) < 0.5,
        );
        if (!onBox) continue;
        if (mode === 'fill') {
          if (x1 - x0 > 0.01 && y1 - y0 > 0.01) rects.push({ x0, y0, x1, y1, color: gs.fill, kind: 'fill' });
        } else {
          // Stroke: each segment becomes a rect of the (page-space) line width.
          const [a, b, c, d] = gs.ctm;
          const lw = Math.max(0.1, gs.lineWidth * Math.sqrt(Math.abs(a * d - b * c)));
          for (let i = 1; i < sp.length; i++) {
            const [px, py] = sp[i - 1]!;
            const [qx, qy] = sp[i]!;
            if (Math.abs(py - qy) < 0.5) {
              rects.push({ x0: Math.min(px, qx), x1: Math.max(px, qx), y0: py - lw / 2, y1: py + lw / 2, color: gs.stroke, kind: 'stroke' });
            } else if (Math.abs(px - qx) < 0.5) {
              rects.push({ x0: px - lw / 2, x1: px + lw / 2, y0: Math.min(py, qy), y1: Math.max(py, qy), color: gs.stroke, kind: 'stroke' });
            }
          }
        }
      }
    }
    subpaths = [];
    cur = null;
  };

  for (;;) {
    const t = lex.next();
    if (t === undefined) break;
    if (!(t instanceof PdfOp)) {
      operands.push(t);
      continue;
    }
    const op = t.op;
    switch (op) {
      case 'q':
        stack.push({ ...gs });
        break;
      case 'Q':
        gs = stack.pop() ?? gs;
        break;
      case 'cm':
        gs.ctm = mul([num(0), num(1), num(2), num(3), num(4), num(5)], gs.ctm);
        break;
      case 'w':
        gs.lineWidth = num(0);
        break;
      case 'gs': {
        const n = operands[0];
        const d = n instanceof PdfName ? doc.dict(extG?.get(n.name)) : null;
        const lw = doc.resolve(d?.get('LW'));
        if (typeof lw === 'number') gs.lineWidth = lw;
        break;
      }
      // Colors
      case 'g': case 'rg': case 'k': case 'sc': case 'scn': {
        const c = colorFrom(nums());
        if (c) gs.fill = c;
        break;
      }
      case 'G': case 'RG': case 'K': case 'SC': case 'SCN': {
        const c = colorFrom(nums());
        if (c) gs.stroke = c;
        break;
      }
      case 'cs':
        gs.fill = '#000000';
        break;
      case 'CS':
        gs.stroke = '#000000';
        break;
      // Paths
      case 'm': {
        cur = [apply(gs.ctm, num(0), num(1))];
        subpaths.push(cur);
        break;
      }
      case 'l':
        if (cur) cur.push(apply(gs.ctm, num(0), num(1)));
        break;
      case 'c':
        if (cur) cur.push(apply(gs.ctm, num(4), num(5)));
        break;
      case 'v': case 'y':
        if (cur) cur.push(apply(gs.ctm, num(2), num(3)));
        break;
      case 'h':
        if (cur && cur.length) cur.push(cur[0]!);
        break;
      case 're': {
        const x = num(0), y = num(1), w = num(2), h = num(3);
        const sp: [number, number][] = [
          apply(gs.ctm, x, y), apply(gs.ctm, x + w, y), apply(gs.ctm, x + w, y + h), apply(gs.ctm, x, y + h), apply(gs.ctm, x, y),
        ];
        subpaths.push(sp);
        cur = sp;
        break;
      }
      case 'f': case 'F': case 'f*':
        flushPath('fill');
        break;
      case 'S': case 's':
        flushPath('stroke');
        break;
      case 'B': case 'B*': case 'b': case 'b*': {
        const saved = subpaths.map((sp) => sp.slice());
        flushPath('fill');
        subpaths = saved;
        flushPath('stroke');
        break;
      }
      case 'n':
        flushPath('none');
        break;
      // Text
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case 'Tf': {
        const n = operands[0];
        const fd = n instanceof PdfName ? doc.dict(fonts?.get(n.name)) : null;
        gs.font = fd ? loadFont(doc, fd) : null;
        gs.fontSize = num(1);
        break;
      }
      case 'Tc': gs.charSpace = num(0); break;
      case 'Tw': gs.wordSpace = num(0); break;
      case 'Tz': gs.hScale = num(0) / 100; break;
      case 'TL': gs.leading = num(0); break;
      case 'Ts': gs.rise = num(0); break;
      case 'Tm':
        tm = tlm = [num(0), num(1), num(2), num(3), num(4), num(5)];
        break;
      case 'Td':
        tm = tlm = mul([1, 0, 0, 1, num(0), num(1)], tlm);
        break;
      case 'TD':
        gs.leading = -num(1);
        tm = tlm = mul([1, 0, 0, 1, num(0), num(1)], tlm);
        break;
      case 'T*':
        tm = tlm = mul([1, 0, 0, 1, 0, -gs.leading], tlm);
        break;
      case 'Tj': {
        const s = operands[0];
        if (s instanceof PdfString) showText(s.bytes);
        break;
      }
      case "'": {
        tm = tlm = mul([1, 0, 0, 1, 0, -gs.leading], tlm);
        const s = operands[0];
        if (s instanceof PdfString) showText(s.bytes);
        break;
      }
      case '"': {
        gs.wordSpace = num(0);
        gs.charSpace = num(1);
        tm = tlm = mul([1, 0, 0, 1, 0, -gs.leading], tlm);
        const s = operands[2];
        if (s instanceof PdfString) showText(s.bytes);
        break;
      }
      case 'TJ': {
        const arr = operands[0];
        if (Array.isArray(arr)) {
          for (const el of arr) {
            if (el instanceof PdfString) showText(el.bytes);
            else if (typeof el === 'number') {
              const tx = (-el / 1000) * gs.fontSize * gs.hScale;
              tm = mul([1, 0, 0, 1, tx, 0], tm);
            }
          }
        }
        break;
      }
      // Form XObjects (images are skipped)
      case 'Do': {
        const n = operands[0];
        const xo = n instanceof PdfName ? doc.resolve(xobjects?.get(n.name)) : null;
        if (isStream(xo) && nameOf(xo.dict.get('Subtype')) === 'Form') {
          const body = decodeStream(doc, xo);
          if (body) {
            const mArr = doc.resolve(xo.dict.get('Matrix'));
            const m: Matrix = Array.isArray(mArr) && mArr.length === 6
              ? (mArr.map((x) => Number(doc.resolve(x))) as Matrix)
              : IDENTITY;
            const res = doc.dict(xo.dict.get('Resources')) ?? resources;
            run(doc, body, res, { ...gs, ctm: mul(m, gs.ctm) }, chars, rects, depth + 1);
          }
        }
        break;
      }
      case 'BI': {
        // Inline image: skip to EI.
        for (;;) {
          const x = lex.next();
          if (x === undefined || (x instanceof PdfOp && x.op === 'EI')) break;
        }
        break;
      }
    }
    operands = [];
  }
}
