/**
 * Layout for PDF import: positioned characters + rectangles → paragraphs
 * of styled runs, in reading order.
 *
 * A PDF has no paragraphs, only glyphs placed on lines. This rebuilds them
 * for single-column documents (what Word and CardMirror export):
 *
 *   1. per character, what is drawn around it: a thin rule just under the
 *      baseline is an underline (two stacked rules: a double underline, the
 *      Hat style), a colored box behind it is a highlight;
 *   2. characters sharing a baseline form a line (small raised glyphs, like
 *      "th" superscripts, join the line they sit on);
 *   3. lines form paragraphs until a break: a blank line, a larger gap than
 *      the line spacing, a change of style class (heading ↔ body), or a
 *      previous line that stopped short of the right margin;
 *   4. running headers / footers (the same text at the same place on many
 *      pages, or a bare page number) are dropped.
 */

import type { PdfChar, PdfPageContent, PdfRect } from './pdf-content.js';

export interface StyledChar {
  text: string;
  size: number;
  bold: boolean;
  italic: boolean;
  /** 0 = none, 1 = single, 2 = double. */
  underline: 0 | 1 | 2;
  /** Highlight color as #rrggbb, or null. */
  highlight: string | null;
  /** Text color as #rrggbb. */
  color: string;
  /** Raised small glyph (superscript). */
  superscript: boolean;
  /** Framed by a box (CardMirror draws Emphasis as underline + box). */
  boxed: boolean;
}

export interface PdfLine {
  page: number;
  y: number;
  x0: number;
  x1: number;
  chars: StyledChar[];
  /** Char-weighted dominant size of the line's visible text. */
  size: number;
  /** Largest glyph on the line: Word grows a line's height to fit it. */
  maxSize: number;
  /** Width of the line's first word: whether it would have fit at the
   *  end of the previous line says if that line wrapped or ended. */
  firstWordWidth: number;
}

export interface PdfParagraph {
  lines: PdfLine[];
  chars: StyledChar[];
  /** Char-weighted dominant size. */
  size: number;
  /** Centered on the page (headings). */
  centered: boolean;
  /** Drawn inside a box (the Pocket style). */
  boxed: boolean;
}

const WHITE = new Set(['#ffffff', '#fefefe', '#fdfdfd']);

function isBackground(r: PdfRect, page: PdfPageContent): boolean {
  const area = (r.x1 - r.x0) * (r.y1 - r.y0);
  return area > page.width * page.height * 0.15 || WHITE.has(r.color);
}

function dominantSize(chars: { text: string; size: number }[]): number {
  const w = new Map<number, number>();
  for (const c of chars) {
    if (!c.text.trim()) continue;
    const k = Math.round(c.size * 2) / 2;
    w.set(k, (w.get(k) ?? 0) + 1);
  }
  let best = 0, n = -1;
  for (const [k, v] of w) if (v > n) [best, n] = [k, v];
  return best || (chars[0]?.size ?? 0);
}

/** Style each char from the rectangles around it. */
function styleChars(page: PdfPageContent): { c: PdfChar; s: StyledChar }[] {
  const rects = page.rects.filter((r) => !isBackground(r, page));
  // Thin horizontal rules (underlines) vs area fills (highlights).
  const rules = rects.filter((r) => r.y1 - r.y0 <= 2.6 && r.x1 - r.x0 > (r.y1 - r.y0) * 2);
  const fills = rects.filter((r) => r.kind === 'fill' && r.y1 - r.y0 > 2.6 && r.color !== '#000000');
  const sides = rects.filter((r) => r.x1 - r.x0 <= 2.6 && r.y1 - r.y0 > (r.x1 - r.x0) * 2);
  return page.chars.map((c) => {
    const mid = (c.x0 + c.x1) / 2;
    const under = rules.filter(
      (r) => r.x0 - 0.5 <= mid && r.x1 + 0.5 >= mid && r.y0 >= c.y - 0.5 && r.y0 <= c.y + c.size * 0.45,
    );
    // A box: a rule just above the glyph with a vertical side inside its
    // extent spanning the glyph (the line above's underline has no sides).
    // Its bottom edge sits with the underline, so that isn't a second one.
    const boxTop = rules.some(
      (r) =>
        r.x0 - 0.5 <= mid &&
        r.x1 + 0.5 >= mid &&
        r.y1 <= c.y - c.size * 0.55 &&
        r.y1 >= c.y - c.size * 1.4 &&
        sides.some(
          (v) => v.x1 >= r.x0 - 2 && v.x0 <= r.x1 + 2 && v.y0 <= c.y - c.size * 0.5 && v.y1 >= c.y && v.y0 >= r.y0 - 2,
        ),
    );
    const hi = fills.find(
      (r) => r.x0 - 0.5 <= mid && r.x1 + 0.5 >= mid && r.y0 <= c.y - c.size * 0.3 && r.y1 >= c.y - 0.5,
    );
    return {
      c,
      s: {
        text: c.text,
        size: c.size,
        bold: c.font.bold,
        italic: c.font.italic,
        underline: boxTop ? (under.length ? 1 : 0) : under.length >= 2 ? 2 : under.length === 1 ? 1 : 0,
        highlight: hi ? hi.color : null,
        color: c.color,
        superscript: false,
        boxed: boxTop,
      },
    };
  });
}

function buildLines(page: PdfPageContent, pageIndex: number): PdfLine[] {
  const styled = styleChars(page).sort((a, b) => a.c.y - b.c.y || a.c.x0 - b.c.x0);
  // 1. Cluster by baseline.
  type Line = { y: number; size: number; items: { c: PdfChar; s: StyledChar }[] };
  const raw: Line[] = [];
  for (const it of styled) {
    const line = raw.find((l) => Math.abs(l.y - it.c.y) <= Math.max(1, Math.min(l.size, it.c.size) * 0.3));
    if (line) {
      line.items.push(it);
      line.size = Math.max(line.size, it.c.size);
    } else raw.push({ y: it.c.y, size: it.c.size, items: [it] });
  }
  // 2. A few small glyphs raised just above a bigger line's baseline are
  //    that line's superscripts ("8th", footnote numbers). Only a few: a
  //    whole line of shrunk text can sit that close above a normal one.
  const lines: Line[] = [];
  for (const l of raw) {
    const visible = l.items.filter((it) => it.c.text.trim()).length;
    const host =
      visible <= 8 &&
      raw.find(
        (h) =>
          h !== l &&
          l.size < h.size * 0.8 &&
          l.y < h.y - h.size * 0.15 &&
          l.y > h.y - h.size * 0.8 &&
          l.items.every((it) => it.c.x0 >= Math.min(...h.items.map((x) => x.c.x0)) - 1),
      );
    if (host) {
      for (const it of l.items) it.s.superscript = true;
      host.items.push(...l.items);
    } else lines.push(l);
  }
  lines.sort((a, b) => a.y - b.y);
  return lines.map((l) => {
    l.items.sort((a, b) => a.c.x0 - b.c.x0);
    // Explicit gaps between glyphs with no space glyph → a space.
    const chars: StyledChar[] = [];
    let prevX1: number | null = null;
    for (const it of l.items) {
      if (prevX1 !== null && it.c.x0 - prevX1 > it.c.size * 0.22) {
        const last = chars[chars.length - 1];
        if (last && last.text.trim() && it.c.text.trim()) chars.push({ ...last, text: ' ', superscript: false });
      }
      chars.push(it.s);
      prevX1 = it.c.x1;
    }
    const visible = l.items.filter((it) => it.c.text.trim());
    let firstWordEnd = -1;
    for (let i = 0; i < l.items.length; i++) {
      if (!l.items[i]!.c.text.trim()) {
        if (firstWordEnd >= 0) break;
        continue;
      }
      firstWordEnd = i;
    }
    const firstWordWidth = visible.length && firstWordEnd >= 0 ? l.items[firstWordEnd]!.c.x1 - visible[0]!.c.x0 : 0;
    return {
      firstWordWidth,
      maxSize: visible.length ? Math.max(...visible.filter((it) => !it.s.superscript).map((it) => it.c.size), 0) || l.size : l.size,
      page: pageIndex,
      y: l.y,
      x0: visible.length ? Math.min(...visible.map((it) => it.c.x0)) : l.items[0]!.c.x0,
      x1: visible.length ? Math.max(...visible.map((it) => it.c.x1)) : l.items[0]!.c.x1,
      chars,
      size: dominantSize(l.items.map((it) => it.c)),
    };
  });
}

const lineText = (l: PdfLine): string => l.chars.map((c) => c.text).join('');

/** Drop running headers/footers: text repeated at the same spot on many
 *  pages, or a bare page number near the top or bottom edge. */
function dropHeadersFooters(pages: PdfLine[][], heights: number[]): PdfLine[][] {
  const key = (l: PdfLine): string => `${Math.round(l.y / 3)}|${lineText(l).trim().replace(/\d+/g, '#')}`;
  const counts = new Map<string, number>();
  pages.forEach((ls, i) => {
    for (const l of ls) {
      if (l.y > heights[i]! * 0.12 && l.y < heights[i]! * 0.88) continue;
      const k = key(l);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  });
  const threshold = Math.max(3, Math.ceil(pages.length * 0.3));
  return pages.map((ls, i) =>
    ls.filter((l) => {
      const edge = l.y <= heights[i]! * 0.12 || l.y >= heights[i]! * 0.88;
      if (!edge) return true;
      const t = lineText(l).trim();
      if (/^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i.test(t)) return false;
      return (counts.get(key(l)) ?? 0) < threshold || pages.length < 3;
    }),
  );
}

/** Coarse style class, for "did the style change between two lines". */
function styleClass(l: PdfLine, body: number): string {
  const vis = l.chars.filter((c) => c.text.trim());
  const bold = vis.filter((c) => c.bold).length > vis.length * 0.8;
  const r = l.size / body;
  if (r >= 1.35) return `h${Math.round(l.size)}`;
  if (r >= 1.08 && bold) return 'tag';
  return 'body';
}

/** The Cite style, as drawn: tag-sized text inside body text, not
 *  underlined. Verbatim draws it bold; CardMirror's own templates may not,
 *  so weight isn't required. */
export function isCiteChar(c: StyledChar, body: number): boolean {
  return !c.underline && c.size / body >= 1.08 && c.size / body < 1.3 && !c.superscript;
}

const OPEN = '([{';
const CLOSE = ')]}';

/** A cite and its card text often print with nothing between them: the
 *  cite's last line runs to the margin and the card's first word doesn't
 *  fit. But a cite's source details sit in one bracketed span right after
 *  the author and date, so when that span closes at the end of a line and
 *  more lines follow, the card text starts on the next line. */
function splitAfterCite(
  p: PdfParagraph,
  body: number,
  makeParagraph: (lines: PdfLine[]) => PdfParagraph | null,
): PdfParagraph[] {
  if (p.lines.length < 2) return [p];
  // Opens with a cite: tag-sized text within its first few words.
  const head = p.lines[0]!.chars.slice(0, 60);
  if (head.filter((c) => c.text.trim() && isCiteChar(c, body)).length < 2) return [p];
  let depth = 0;
  let opened = false;
  for (let k = 0; k < p.lines.length - 1; k++) {
    const chars = p.lines[k]!.chars;
    for (let i = 0; i < chars.length; i++) {
      const t = chars[i]!.text;
      if (OPEN.includes(t)) {
        depth++;
        opened = true;
      } else if (CLOSE.includes(t) && depth > 0) {
        depth--;
        if (opened && depth === 0) {
          // Closed. Only short credits may follow on the line ("//PK").
          const rest = chars.slice(i + 1).map((c) => c.text).join('').trim();
          if (rest.length > 40) return [p];
          const a = makeParagraph(p.lines.slice(0, k + 1));
          const b = makeParagraph(p.lines.slice(k + 1));
          return [a, b].filter((x): x is PdfParagraph => x !== null);
        }
      }
    }
    if (!opened && k >= 1) return [p]; // no bracketed details up front
  }
  return [p];
}

export function layoutParagraphs(
  pages: PdfPageContent[],
  /** Diagnostics: called with each paragraph break and its reason. */
  debug?: (reason: string, prev: string, next: string) => void,
): { paragraphs: PdfParagraph[]; bodySize: number } {
  const perPage = dropHeadersFooters(
    pages.map((p, i) => buildLines(p, i)),
    pages.map((p) => p.height),
  );
  const all = perPage.flat();
  // Body size: from underlined text when there's enough of it. Shrinking
  // (Verbatim's condense-for-reading) only ever applies to non-underlined
  // text, so in a heavily shrunk file the most common size is the shrunk
  // one, which would make every heading read one level too big.
  const allChars = all.flatMap((l) => l.chars);
  const underlined = allChars.filter((c) => c.underline && !c.bold && c.text.trim());
  const bodySize = (underlined.length >= 30 ? dominantSize(underlined) : dominantSize(allChars)) || 11;

  // The text column's right edge: where full body lines end.
  const bodyEnds = all
    .filter((l) => Math.abs(l.size - bodySize) < 0.6 && lineText(l).trim())
    .map((l) => l.x1)
    .sort((a, b) => a - b);
  const right = bodyEnds.length ? bodyEnds[Math.floor(bodyEnds.length * 0.9)]! : 540;
  const leftEdges = all.filter((l) => lineText(l).trim()).map((l) => l.x0).sort((a, b) => a - b);
  const left = leftEdges.length ? leftEdges[Math.floor(leftEdges.length * 0.1)]! : 72;

  // Boxes (Pocket): long horizontal rules above and below a line.
  const boxedLine = (l: PdfLine): boolean => {
    const page = pages[l.page]!;
    const rules = page.rects.filter((r) => r.y1 - r.y0 <= 3 && r.x1 - r.x0 > (right - left) * 0.6);
    const above = rules.some((r) => r.y1 <= l.y - l.size * 0.6 && r.y1 >= l.y - l.size * 2.2);
    const below = rules.some((r) => r.y0 >= l.y && r.y0 <= l.y + l.size * 1.2);
    return above && below;
  };

  /** Lines → one paragraph: joined with a space where a line wrapped
   *  (not after a hyphen or slash), trimmed. Null when there's no text. */
  const makeParagraph = (lines: PdfLine[]): PdfParagraph | null => {
    const chars: StyledChar[] = [];
    lines.forEach((l, i) => {
      if (i > 0) {
        const prev = chars[chars.length - 1];
        const endsSoft = prev && (/\s$/.test(prev.text) || /[-‐\u00ad/]$/.test(prev.text));
        if (prev && !endsSoft) chars.push({ ...prev, text: ' ', superscript: false });
      }
      chars.push(...l.chars);
    });
    while (chars.length && !chars[0]!.text.trim()) chars.shift();
    while (chars.length && !chars[chars.length - 1]!.text.trim()) chars.pop();
    if (!chars.length) return null;
    const first = lines[0]!;
    const mid = (first.x0 + first.x1) / 2;
    const centered = lines.length <= 3 && Math.abs(mid - (left + right) / 2) < (right - left) * 0.08 && first.x0 > left + 20;
    return { lines, chars, size: dominantSize(chars), centered, boxed: boxedLine(first) };
  };

  const paragraphs: PdfParagraph[] = [];
  let cur: PdfLine[] = [];
  const flush = (): void => {
    if (!cur.length) return;
    const para = makeParagraph(cur);
    if (para) paragraphs.push(...splitAfterCite(para, bodySize, makeParagraph));
    cur = [];
  };

  for (const line of all) {
    if (!lineText(line).trim()) {
      flush(); // blank line = paragraph break
      continue;
    }
    const prev = cur[cur.length - 1];
    if (prev) {
      const samePage = prev.page === line.page;
      const gap = line.y - prev.y;
      const expected = Math.max(prev.maxSize, line.maxSize) * 1.25;
      // The previous line ended (rather than wrapped) when this line's first
      // word would have fit in the room it left before the right margin.
      const room = right - prev.x1;
      const shortPrev = room > line.firstWordWidth + line.size * 0.6;
      const styleChange = styleClass(prev, bodySize) !== styleClass(line, bodySize);
      const bigGap = samePage && gap > expected * 1.45;
      const indentChange = Math.abs(line.x0 - cur[0]!.x0) > line.size * 1.5 && line.x0 > cur[0]!.x0;
      if (styleChange || bigGap || shortPrev || indentChange) {
        debug?.(
          [styleChange && 'style', bigGap && 'gap', shortPrev && 'short', indentChange && 'indent'].filter(Boolean).join('+'),
          lineText(prev),
          lineText(line),
        );
        flush();
      }
    }
    cur.push(line);
  }
  flush();
  return { paragraphs, bodySize };
}
