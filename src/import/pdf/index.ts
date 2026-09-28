/**
 * PDF → CardMirror document.
 *
 * For debate documents exported to PDF from Verbatim (Word) or CardMirror
 * (Chromium): reads the text with its sizes, weights, underlines and
 * highlights (pdf-objects / pdf-fonts / pdf-content), rebuilds paragraphs
 * (pdf-layout), then maps Verbatim's visual styles back to structure. Sizes
 * are read relative to the body text, so a template with other point sizes
 * still classifies:
 *
 *   Pocket   ≈ 2.4× body (26pt on 11pt), often boxed
 *   Hat      ≈ 2×   body (22pt), double underline
 *   Block    ≈ 1.45× body (16pt), underlined
 *   Tag      ≈ 1.2× body (13pt), bold → starts a card
 *   Analytic tag-styled but in a color (Verbatim's analytics are colored)
 *            → starts an analytic unit, which takes the paragraphs below
 *   Cite     the paragraph after a tag that opens with a bold, tag-sized
 *            run (the author + date) → cite paragraph, that run cite-marked
 *   Body     inside a card: underline → Underline, bold + underline →
 *            Emphasis, colored background → highlight, shrunk text → its
 *            size; outside a card: plain paragraphs
 *
 * Scanned PDFs (no text layer), encrypted PDFs and PDFs that aren't shaped
 * like a debate document are refused with a message saying so rather than
 * producing a poor document.
 */

import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../schema/index.js';
import { dedupeHeadingIds } from '../../schema/ids.js';
import { repairDoc } from '../../doc-repair.js';
import { PdfDocument, PdfError } from './pdf-objects.js';
import { readPage } from './pdf-content.js';
import { layoutParagraphs, isCiteChar, type PdfParagraph, type StyledChar } from './pdf-layout.js';

export class PdfImportError extends Error {}

export interface PdfImportResult {
  doc: PMNode;
  /** Producer, from the PDF's Info (e.g. "Microsoft Word", "Skia/PDF"). */
  producer: string;
  pages: number;
}

// OOXML highlight names (the highlight mark's vocabulary) and their colors.
const HIGHLIGHTS: [string, number, number, number][] = [
  ['yellow', 255, 255, 0], ['green', 0, 255, 0], ['cyan', 0, 255, 255], ['magenta', 255, 0, 255],
  ['blue', 0, 0, 255], ['red', 255, 0, 0], ['darkBlue', 0, 0, 128], ['darkCyan', 0, 128, 128],
  ['darkGreen', 0, 128, 0], ['darkMagenta', 128, 0, 128], ['darkRed', 128, 0, 0],
  ['darkYellow', 128, 128, 0], ['darkGray', 128, 128, 128], ['lightGray', 192, 192, 192],
];

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function highlightName(hex: string): string {
  const [r, g, b] = rgb(hex);
  let best = 'yellow', bestD = Infinity;
  for (const [name, hr, hg, hb] of HIGHLIGHTS) {
    const d = (r - hr) ** 2 + (g - hg) ** 2 + (b - hb) ** 2;
    if (d < bestD) [best, bestD] = [name, d];
  }
  return best;
}

function isNearBlack(hex: string): boolean {
  const [r, g, b] = rgb(hex);
  return r < 60 && g < 60 && b < 60;
}

type Kind = 'pocket' | 'hat' | 'block' | 'tag' | 'analytic' | 'body';

function classify(p: PdfParagraph, body: number): Kind {
  const vis = p.chars.filter((c) => c.text.trim());
  const n = Math.max(1, vis.length);
  const boldShare = vis.filter((c) => c.bold).length / n;
  const highlightShare = vis.filter((c) => c.highlight).length / n;
  // Headings are one size throughout; body text with big emphasis isn't.
  const uniform = vis.filter((c) => Math.abs(c.size - p.size) < 1).length / n > 0.85;
  const r = p.size / body;
  const headingLike = boldShare > 0.6 && highlightShare < 0.3 && uniform;
  if (headingLike && (r >= 2.15 || (p.boxed && r >= 1.35))) return 'pocket';
  if (headingLike && r >= 1.7) return 'hat';
  if (headingLike && r >= 1.3) return 'block';
  if (r >= 1.08 && r < 1.3 && uniform) {
    // An analytic's color is its style (Verbatim also bolds it; CardMirror
    // doesn't), so a colored tag-sized line is one either way.
    const colored = vis.filter((c) => !isNearBlack(c.color)).length / n > 0.6;
    if (colored && highlightShare < 0.3) return 'analytic';
    if (boldShare > 0.6) return 'tag';
  }
  return 'body';
}


/** A paragraph carrying Cite-styled text is a cite paragraph — the same
 *  rule the Word importer uses (any cite mark makes the paragraph a cite).
 *  Needs a real run of letters, not one stray glyph. */
function hasCite(p: PdfParagraph, body: number): boolean {
  let run = 0;
  for (const c of p.chars) {
    if (!c.text.trim()) continue;
    run = isCiteChar(c, body) ? run + 1 : 0;
    if (run >= 2) return true;
  }
  return false;
}

/** Where text sits: a Pocket / Hat / Block (its underline is the style),
 *  a tag (bold is the style), or body text. */
type Ctx = 'heading' | 'tag' | 'analytic' | 'body';

/** The marks one character carries, by where it sits.
 *
 *  Underline plus bold (Verbatim) or a box (CardMirror) maps to Emphasis.
 *  Some templates draw Emphasis exactly
 *  like underlined bold text (same weight, rule and offset), so the two
 *  can't be told apart from a PDF; Emphasis is by far the more common of
 *  the two in card text. */
function marksFor(c: StyledChar, ctx: Ctx, body: number): Mark[] {
  const m = schema.marks;
  const out: Mark[] = [];
  if (ctx === 'tag' || ctx === 'analytic') {
    if (c.underline) out.push(m['underline_mark']!.create());
  } else if (ctx === 'body') {
    if (isCiteChar(c, body)) out.push(m['cite_mark']!.create());
    else if (c.underline && (c.bold || c.boxed)) out.push(m['emphasis_mark']!.create());
    else if (c.underline) out.push(m['underline_mark']!.create());
    else if (c.bold) out.push(m['bold']!.create());
    // Shrunk text (Verbatim's shrink), or any other size change in body text.
    if (!isCiteChar(c, body) && !c.superscript && Math.abs(c.size - body) > 0.6 && c.size < body * 1.5) {
      out.push(m['font_size']!.create({ halfPoints: Math.max(2, Math.round(c.size * 2)) }));
    }
  }
  if (c.italic) out.push(m['italic']!.create());
  if (c.superscript) out.push(m['superscript']!.create());
  if (c.highlight) out.push(m['highlight']!.create({ color: highlightName(c.highlight) }));
  // An analytic's color is its style, not formatting.
  if (ctx !== 'analytic' && !isNearBlack(c.color)) {
    out.push(m['font_color']!.create({ color: c.color.slice(1).toUpperCase() }));
  }
  return out;
}

const sameMarks = (a: readonly Mark[], b: readonly Mark[]): boolean =>
  a.length === b.length && a.every((mk, k) => mk.eq(b[k]!));

/** Inline content: consecutive chars with the same marks become one text node. */
function inline(chars: StyledChar[], ctx: Ctx, body: number): PMNode[] {
  const marks = chars.map((c) => sortMarks(marksFor(c, ctx, body)));
  // Whitespace between two runs formatted alike takes their formatting: a
  // renderer may not underline or highlight a space (Word leaves the space
  // at a line wrap bare), which would otherwise split one run in two.
  for (let i = 0; i < chars.length; i++) {
    if (chars[i]!.text.trim()) continue;
    let j = i;
    while (j < chars.length && !chars[j]!.text.trim()) j++;
    if (i > 0 && j < chars.length && sameMarks(marks[i - 1]!, marks[j]!)) {
      for (let k = i; k < j; k++) marks[k] = marks[i - 1]!;
    }
    i = j - 1;
  }
  const nodes: PMNode[] = [];
  let text = '';
  let cur: readonly Mark[] | null = null;
  const push = (): void => {
    if (text) nodes.push(schema.text(text, cur ?? []));
    text = '';
  };
  chars.forEach((c, i) => {
    const ms = marks[i]!;
    if (cur === null || !sameMarks(cur, ms)) {
      push();
      cur = ms;
    }
    text += c.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  });
  push();
  return nodes;
}

function sortMarks(ms: Mark[]): readonly Mark[] {
  let set: readonly Mark[] = [];
  for (const mk of ms) set = mk.addToSet(set);
  return set;
}

export function pdfToDoc(bytes: Uint8Array): PdfImportResult {
  let pdf: PdfDocument;
  try {
    pdf = new PdfDocument(bytes);
  } catch (err) {
    throw new PdfImportError(err instanceof PdfError ? err.message : 'This file could not be read as a PDF.');
  }
  if (pdf.trailer.has('Encrypt')) {
    throw new PdfImportError('This PDF is password-protected or encrypted, so its text can’t be read.');
  }
  const info = pdf.info();
  const pageList = pdf.pages();
  if (!pageList.length) throw new PdfImportError('This PDF has no pages.');
  const pages = pageList.map((p) => readPage(pdf, p));
  const charCount = pages.reduce((n, p) => n + p.chars.length, 0);
  if (charCount < 50) {
    throw new PdfImportError(
      'This PDF has no readable text — it may be a scan or an image. Only PDFs exported from a document (Verbatim / Word or CardMirror) can be converted.',
    );
  }

  const { paragraphs, bodySize } = layoutParagraphs(pages);
  const n = schema.nodes;
  const blocks: PMNode[] = [];
  // The open card or analytic unit: its head and the paragraphs it takes.
  let card: { unit: 'card' | 'analytic_unit'; tag: PMNode; rest: PMNode[] } | null = null;
  const closeCard = (): void => {
    if (card) blocks.push(n[card.unit]!.createChecked(null, [card.tag, ...card.rest]));
    card = null;
  };

  for (const p of paragraphs) {
    const kind = classify(p, bodySize);
    if (kind === 'pocket' || kind === 'hat' || kind === 'block') {
      closeCard();
      blocks.push(n[kind]!.create({ id: newHeadingId() }, inline(p.chars, 'heading', bodySize)));
      continue;
    }
    if (kind === 'tag') {
      closeCard();
      card = { unit: 'card', tag: n['tag']!.create({ id: newHeadingId() }, inline(p.chars, 'tag', bodySize)), rest: [] };
      continue;
    }
    if (kind === 'analytic') {
      closeCard();
      card = {
        unit: 'analytic_unit',
        tag: n['analytic']!.create({ id: newHeadingId() }, inline(p.chars, 'analytic', bodySize)),
        rest: [],
      };
      continue;
    }
    // Body text. A cite outside a card stays a cite paragraph, as in Word
    // import.
    const content = inline(p.chars, 'body', bodySize);
    const cite = hasCite(p, bodySize);
    const cur = card as { rest: PMNode[] } | null;
    if (cur) cur.rest.push(n[cite ? 'cite_paragraph' : 'card_body']!.create(null, content));
    else blocks.push(n[cite ? 'cite_paragraph' : 'paragraph']!.create(null, content));
  }
  closeCard();
  if (!blocks.length) throw new PdfImportError('No text could be recovered from this PDF.');

  let doc = n['doc']!.create(null, blocks);
  doc = dedupeHeadingIds(repairDoc(doc));
  try {
    doc.check();
  } catch (err) {
    throw new PdfImportError(
      `This PDF converted into an invalid document — please report this file (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  return {
    doc,
    producer: [info['Creator'], info['Producer']].filter(Boolean).join(' / '),
    pages: pages.length,
  };
}
