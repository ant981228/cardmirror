/**
 * Read-aloud word counting.
 *
 * The "read-aloud" predicate, split into the two speeds a reader
 * actually has (2026-07-29):
 *   - `other` — the structural read:
 *       · All text inside a `tag` paragraph
 *       · All text inside an `analytic` paragraph
 *       · Text carrying the `cite_mark` mark (typically inside
 *         `cite_paragraph`)
 *       (Highlighted non-shaded text inside a cite counts as `body`,
 *        not `other` — see readAloudBucket.)
 *   - `body` — the highlighted read:
 *       · Text in body-level paragraphs (`card_body` / `paragraph` /
 *         `undertag`) iff carrying the `highlight` mark AND NOT the
 *         `shading` mark
 *
 * Shading (the D2D2D2 protected-highlight via `HighlightToBackgroundColor`)
 * is excluded — that text is reference-style and not read aloud.
 *
 * Readers (settings `ReaderConfig`) carry a required `wpm` and an
 * optional `tagWpm`: with `tagWpm` set, `body` words read at `wpm` and
 * `other` words at `tagWpm`; left blank, `wpm` covers everything —
 * which reproduces the old single-rate arithmetic exactly.
 */

import type { Node as PMNode } from 'prosemirror-model';

/** Read-aloud words split by which speed they're read at. */
export interface ReadAloudCounts {
  /** Highlighted (non-shaded) body-paragraph words — read at `wpm`. */
  body: number;
  /** Tag + analytic + cite words — read at `tagWpm` when set. */
  other: number;
}

/** The reader shape the time math needs (a subset of settings'
 *  ReaderConfig). `tagWpm` absent/invalid → `wpm` covers everything. */
export interface ReaderRates {
  wpm: number;
  tagWpm?: number;
}

/**
 * Count read-aloud words in [from, to), split into body vs
 * tag/analytic/cite. When `from`/`to` are omitted, counts the whole doc.
 */
export function countReadAloudSplit(doc: PMNode, from?: number, to?: number): ReadAloudCounts {
  const lo = from ?? 0;
  const hi = to ?? doc.content.size;
  const counts: ReadAloudCounts = { body: 0, other: 0 };
  if (lo >= hi) return counts;
  doc.nodesBetween(lo, hi, (node, pos, parent) => {
    if (!node.isText) return true;
    if (!parent) return false;
    const bucket = readAloudBucket(node, parent);
    if (!bucket) return false;
    const text = node.text ?? '';
    // Slice the text to the [lo, hi] window.
    const start = Math.max(0, lo - pos);
    const end = Math.min(text.length, hi - pos);
    if (end <= start) return false;
    counts[bucket] += countWords(text.slice(start, end));
    return false;
  });
  return counts;
}

/** Total read-aloud words in [from, to) — the display number. */
export function countReadAloudWords(doc: PMNode, from?: number, to?: number): number {
  return totalWords(countReadAloudSplit(doc, from, to));
}

export function totalWords(counts: ReadAloudCounts): number {
  return counts.body + counts.other;
}

/** Count structural cards intersecting [from, to). When the range is
 * omitted, count every card in the document. */
export function countCards(doc: PMNode, from?: number, to?: number): number {
  const lo = from ?? 0;
  const hi = to ?? doc.content.size;
  if (lo >= hi) return 0;
  let cards = 0;
  doc.nodesBetween(lo, hi, (node) => {
    if (node.type.name !== 'card') return true;
    cards++;
    return false;
  });
  return cards;
}

function readAloudBucket(node: PMNode, parent: PMNode): 'body' | 'other' | null {
  const parentType = parent.type.name;
  if (parentType === 'tag' || parentType === 'analytic') return 'other';
  if (parentType === 'cite_paragraph') {
    // Highlighted (non-shaded) text in a cite reads at BODY speed —
    // it's evidence the reader delivers in full, and read mode shows
    // it (underline/emphasis exclude cite_mark in the schema, so such
    // runs can never carry the cite style). Cite-styled runs stay at
    // tag speed; unmarked filler isn't read at all.
    const hasHighlight = node.marks.some((m) => m.type.name === 'highlight');
    const hasShading = node.marks.some((m) => m.type.name === 'shading');
    if (hasHighlight && !hasShading) return 'body';
    return node.marks.some((m) => m.type.name === 'cite_mark') ? 'other' : null;
  }
  if (node.marks.some((m) => m.type.name === 'cite_mark')) return 'other';
  if (parentType === 'card_body' || parentType === 'paragraph' || parentType === 'undertag') {
    const hasHighlight = node.marks.some((m) => m.type.name === 'highlight');
    const hasShading = node.marks.some((m) => m.type.name === 'shading');
    return hasHighlight && !hasShading ? 'body' : null;
  }
  return null;
}

function countWords(s: string): number {
  const trimmed = s.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/** Seconds a reader needs for the split counts: body at `wpm`, the
 *  structural read at `tagWpm` when set (blank → everything at `wpm`).
 *  Null when no usable rate exists. */
export function readTimeSeconds(counts: ReadAloudCounts, reader: ReaderRates): number | null {
  if (!Number.isFinite(reader.wpm) || reader.wpm <= 0) return null;
  const otherRate =
    reader.tagWpm != null && Number.isFinite(reader.tagWpm) && reader.tagWpm > 0
      ? reader.tagWpm
      : reader.wpm;
  return (counts.body / reader.wpm + counts.other / otherRate) * 60;
}

/** Format a reader's time over split counts as "M:SS". */
export function formatReadTimeFor(counts: ReadAloudCounts, reader: ReaderRates): string {
  const seconds = readTimeSeconds(counts, reader);
  return seconds === null ? '—' : formatSeconds(seconds);
}

/** Format reading time as "M:SS" given a word count and a single WPM
 *  rate — for callers that only have a total (no body/structure split). */
export function formatReadTime(words: number, wpm: number): string {
  if (wpm <= 0) return '—';
  return formatSeconds((words / wpm) * 60);
}

function formatSeconds(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Format a number with thousands separators ("1,024"). */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}
